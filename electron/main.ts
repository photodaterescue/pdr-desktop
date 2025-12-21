import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { analyzeSource } from './analysis-engine';
import { saveReport, loadReport, loadLatestReport, listReports, exportReportToCSV, exportReportToTXT, FixReport } from './report-storage';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f6f6fb',
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5000');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/client/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
  });
  
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  
  return result.filePaths[0];
});

ipcMain.handle('dialog:openZip', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [{ name: 'ZIP Archives', extensions: ['zip'] }],
  });
  
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  
  return result.filePaths[0];
});

ipcMain.handle('dialog:selectDestination', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Destination Folder',
  });
  
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  
  return result.filePaths[0];
});

ipcMain.handle('shell:openFolder', async (_event, folderPath: string) => {
  try {
    await shell.openPath(folderPath);
  } catch (error) {
    console.error('Error opening folder:', error);
  }
});

ipcMain.handle('disk:getSpace', async (_event, directoryPath: string) => {
  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const output = execSync(`df -k "${directoryPath}"`, { encoding: 'utf8' });
      const lines = output.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        const availableKB = parseInt(parts[3], 10);
        const totalKB = parseInt(parts[1], 10);
        return {
          freeBytes: availableKB * 1024,
          totalBytes: totalKB * 1024,
        };
      }
    } else if (process.platform === 'win32') {
      const driveLetter = path.parse(directoryPath).root;
      const output = execSync(`wmic logicaldisk where "DeviceID='${driveLetter.replace('\\', '')}'" get FreeSpace,Size /format:csv`, { encoding: 'utf8' });
      const lines = output.trim().split('\n').filter(l => l.trim());
      if (lines.length >= 2) {
        const parts = lines[1].split(',');
        return {
          freeBytes: parseInt(parts[1], 10),
          totalBytes: parseInt(parts[2], 10),
        };
      }
    }
    return { freeBytes: 0, totalBytes: 0 };
  } catch (error) {
    console.error('Error getting disk space:', error);
    return { freeBytes: 0, totalBytes: 0 };
  }
});

ipcMain.handle('analysis:run', async (_event, sourcePath: string, sourceType: 'folder' | 'zip' | 'drive') => {
  try {
    const results = await analyzeSource(sourcePath, sourceType, (progress) => {
      mainWindow?.webContents.send('analysis:progress', progress);
    });
    return { success: true, data: results };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('report:save', async (_event, reportData: Omit<FixReport, 'id' | 'timestamp'>) => {
  try {
    const savedReport = await saveReport(reportData);
    return { success: true, data: savedReport };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('report:load', async (_event, reportId: string) => {
  try {
    const report = await loadReport(reportId);
    return { success: true, data: report };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('report:loadLatest', async () => {
  try {
    const report = await loadLatestReport();
    return { success: true, data: report };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('report:list', async () => {
  try {
    const reports = await listReports();
    return { success: true, data: reports };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('report:exportCSV', async (_event, reportId: string) => {
  try {
    const report = await loadReport(reportId);
    if (!report) {
      return { success: false, error: 'Report not found' };
    }
    const csv = exportReportToCSV(report);
    
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export Report as CSV',
      defaultPath: `fix-report-${new Date(report.timestamp).toISOString().split('T')[0]}.csv`,
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });
    
    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, csv, 'utf-8');
      return { success: true, filePath: result.filePath };
    }
    return { success: false, error: 'Export cancelled' };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('report:exportTXT', async (_event, reportId: string) => {
  try {
    const report = await loadReport(reportId);
    if (!report) {
      return { success: false, error: 'Report not found' };
    }
    const txt = exportReportToTXT(report);
    
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export Report as TXT',
      defaultPath: `fix-report-${new Date(report.timestamp).toISOString().split('T')[0]}.txt`,
      filters: [{ name: 'Text Files', extensions: ['txt'] }]
    });
    
    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, txt, 'utf-8');
      return { success: true, filePath: result.filePath };
    }
    return { success: false, error: 'Export cancelled' };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});
