import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
function getReportsDirectory() {
    const userDataPath = app.getPath('userData');
    const reportsDir = path.join(userDataPath, 'fix-reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }
    return reportsDir;
}
function generateReportId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `report-${timestamp}-${random}`;
}
export async function saveReport(report) {
    const reportsDir = getReportsDirectory();
    const id = generateReportId();
    const timestamp = new Date().toISOString();
    const fullReport = {
        id,
        timestamp,
        ...report
    };
    const filePath = path.join(reportsDir, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(fullReport, null, 2), 'utf-8');
    return fullReport;
}
export async function loadReport(reportId) {
    const reportsDir = getReportsDirectory();
    const filePath = path.join(reportsDir, `${reportId}.json`);
    if (!fs.existsSync(filePath)) {
        return null;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
}
export async function loadLatestReport() {
    const reports = await listReports();
    if (reports.length === 0) {
        return null;
    }
    const latestSummary = reports[0];
    return loadReport(latestSummary.id);
}
export async function listReports() {
    const reportsDir = getReportsDirectory();
    if (!fs.existsSync(reportsDir)) {
        return [];
    }
    const files = fs.readdirSync(reportsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => path.join(reportsDir, f));
    const summaries = [];
    for (const filePath of files) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const report = JSON.parse(content);
            const totalScanned = report.totalScanned ?? (report.counts.confirmed + report.counts.recovered + report.counts.marked + (report.duplicatesRemoved || 0));
            summaries.push({
                id: report.id,
                timestamp: report.timestamp,
                destinationPath: report.destinationPath,
                totalFiles: report.counts.total,
                sourceCount: report.sources.length,
                counts: {
                    confirmed: report.counts.confirmed,
                    recovered: report.counts.recovered,
                    marked: report.counts.marked
                },
                duplicatesRemoved: report.duplicatesRemoved || 0,
                totalScanned: totalScanned,
                destinationExists: fs.existsSync(report.destinationPath),
                destinationStatus: fs.existsSync(report.destinationPath)
                    ? 'found'
                    : (() => {
                        // Check if it's the drive that's missing vs just the folder
                        const driveMatch = report.destinationPath.match(/^([A-Za-z]:\\)/);
                        if (driveMatch && !fs.existsSync(driveMatch[1]))
                            return 'drive-missing';
                        // Also handle UNC paths (\\server\share)
                        const uncMatch = report.destinationPath.match(/^(\\\\[^\\]+\\[^\\]+)/);
                        if (uncMatch && !fs.existsSync(uncMatch[1]))
                            return 'drive-missing';
                        return 'folder-missing';
                    })()
            });
        }
        catch (e) {
            console.error(`Error reading report ${filePath}:`, e);
        }
    }
    summaries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return summaries;
}
export async function deleteReport(reportId) {
    const reportsDir = getReportsDirectory();
    const filePath = path.join(reportsDir, `${reportId}.json`);
    if (!fs.existsSync(filePath)) {
        return false;
    }
    fs.unlinkSync(filePath);
    return true;
}
export function exportReportToCSV(report) {
    const headers = [
        'run_id',
        'run_timestamp',
        'original_filename',
        'new_filename',
        'confidence',
        'confidence_method',
        'source_path',
        'destination_path',
        'file_type',
        'date_changed',
        'exif_written',
        'exif_source',
        'status'
    ];
    const escapeCSV = (val) => {
        if (val === undefined || val === null)
            return '""';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };
    const rows = [];
    // Add processed files
    report.files.forEach(f => {
        const ext = f.originalFilename.split('.').pop()?.toLowerCase() || '';
        const dateChanged = f.originalFilename !== f.newFilename;
        rows.push([
            escapeCSV(report.id),
            escapeCSV(report.timestamp),
            escapeCSV(f.originalFilename),
            escapeCSV(f.newFilename),
            escapeCSV(f.confidence.charAt(0).toUpperCase() + f.confidence.slice(1)),
            escapeCSV(f.dateSource),
            escapeCSV(f.sourcePath || report.sources[0]?.path || ''),
            escapeCSV(report.destinationPath),
            escapeCSV(f.fileType || ext),
            dateChanged ? 'true' : 'false',
            f.exifWritten ? 'true' : 'false',
            escapeCSV(f.exifSource || ''),
            'Processed'
        ].join(','));
    });
    // Add duplicate files as rows
    if (report.duplicateFiles && report.duplicateFiles.length > 0) {
        report.duplicateFiles.forEach(dup => {
            const ext = dup.filename.split('.').pop()?.toLowerCase() || '';
            const retainedFile = report.files.find(f => f.originalFilename === dup.duplicateOf);
            const retainedNewFilename = retainedFile?.newFilename || dup.duplicateOf;
            const duplicateConfidence = dup.duplicateMethod === 'heuristic'
                ? 'Duplicate – Heuristic'
                : 'Duplicate – Hash (SHA-256)';
            rows.push([
                escapeCSV(report.id),
                escapeCSV(report.timestamp),
                escapeCSV(dup.filename),
                escapeCSV('(skipped - duplicate)'),
                escapeCSV(duplicateConfidence),
                escapeCSV(`Retained as: ${retainedNewFilename}`),
                escapeCSV(report.sources[0]?.path || ''),
                escapeCSV(report.destinationPath),
                escapeCSV(ext),
                'false',
                'false',
                '',
                'Skipped'
            ].join(','));
        });
    }
    const totalScanned = report.totalScanned ?? (report.counts.confirmed + report.counts.recovered + report.counts.marked + (report.duplicatesRemoved || 0));
    let csvContent = [headers.join(','), ...rows].join('\n');
    csvContent += '\n\n# Summary: ' + totalScanned + ' files scanned -> ' + report.counts.total + ' output files, ' + (report.duplicatesRemoved || 0) + ' duplicates skipped';
    return csvContent;
}
export function exportReportToTXT(report) {
    const lines = [];
    const timestamp = new Date(report.timestamp);
    const totalScanned = report.totalScanned ?? (report.counts.confirmed + report.counts.recovered + report.counts.marked + (report.duplicatesRemoved || 0));
    lines.push('='.repeat(70));
    lines.push('PHOTO DATE RESCUE — FIX REPORT');
    lines.push('='.repeat(70));
    lines.push('');
    lines.push(`Run ID:        ${report.id}`);
    lines.push(`Timestamp:     ${timestamp.toISOString()}`);
    lines.push(`               ${timestamp.toLocaleString()}`);
    lines.push(`Destination:   ${report.destinationPath}`);
    lines.push('');
    lines.push('-'.repeat(70));
    lines.push('SOURCES');
    lines.push('-'.repeat(70));
    report.sources.forEach((s, i) => {
        lines.push(`  ${i + 1}. ${s.label} (${s.type})`);
        lines.push(`     Path: ${s.path}`);
    });
    lines.push('');
    lines.push('-'.repeat(70));
    lines.push('TOTALS');
    lines.push('-'.repeat(70));
    lines.push(`  Confirmed:     ${report.counts.confirmed.toLocaleString()} files`);
    lines.push(`  Recovered:     ${report.counts.recovered.toLocaleString()} files`);
    lines.push(`  Marked:        ${report.counts.marked.toLocaleString()} files`);
    lines.push(`  Duplicates:    ${(report.duplicatesRemoved || 0).toLocaleString()} skipped`);
    lines.push(`  ─────────────────────────`);
    lines.push(`  Total Scanned: ${totalScanned.toLocaleString()} files`);
    lines.push(`  Output Files:  ${report.counts.total.toLocaleString()} files`);
    lines.push('');
    lines.push('-'.repeat(70));
    lines.push('FILE DETAILS (Processed)');
    lines.push('-'.repeat(70));
    lines.push('');
    report.files.forEach((f, index) => {
        const ext = f.originalFilename.split('.').pop()?.toLowerCase() || '';
        const dateChanged = f.originalFilename !== f.newFilename;
        const confidenceLabel = f.confidence.charAt(0).toUpperCase() + f.confidence.slice(1);
        lines.push(`  File ${(index + 1).toString().padStart(5)}:`);
        lines.push(`    Original:    ${f.originalFilename}`);
        lines.push(`    New:         ${f.newFilename}`);
        lines.push(`    Confidence:  ${confidenceLabel}`);
        lines.push(`    Method:      ${f.dateSource}`);
        lines.push(`    File Type:   ${f.fileType || ext}`);
        lines.push(`    Changed:     ${dateChanged ? 'Yes' : 'No'}`);
        lines.push(`    EXIF Written:${f.exifWritten ? 'Yes' : 'No'}${f.exifSource ? ` (${f.exifSource})` : ''}`);
        if (f.sourcePath) {
            lines.push(`    Source:      ${f.sourcePath}`);
        }
        lines.push('');
    });
    // Add duplicates section if any
    if (report.duplicateFiles && report.duplicateFiles.length > 0) {
        lines.push('-'.repeat(70));
        lines.push('DUPLICATE FILES (Skipped)');
        lines.push('-'.repeat(70));
        lines.push('');
        report.duplicateFiles.forEach((dup, index) => {
            const retainedFile = report.files.find(f => f.originalFilename === dup.duplicateOf);
            const retainedNewFilename = retainedFile?.newFilename || dup.duplicateOf;
            const methodLabel = dup.duplicateMethod === 'heuristic'
                ? 'Heuristic (filename + size)'
                : 'Hash (SHA-256)';
            lines.push(`  Duplicate ${(index + 1).toString().padStart(5)}:`);
            lines.push(`    Original:    ${dup.filename}`);
            lines.push(`    Retained as: ${retainedNewFilename}`);
            lines.push(`    Method:      ${methodLabel}`);
            lines.push('');
        });
    }
    lines.push('='.repeat(70));
    lines.push('END OF REPORT');
    lines.push('='.repeat(70));
    return lines.join('\n');
}
export function getExportFilename(report, extension) {
    const date = new Date(report.timestamp);
    const dateStr = date.toISOString().split('T')[0];
    return `PDR_Report_${dateStr}_${report.id}.${extension}`;
}
// ─── Auto-Catalogue ────────────────────────────────────────────────────────
// Generates a dynamic, cumulative PDR_Catalogue.csv and PDR_Catalogue.txt at
// the destination root.  Includes all reports targeting that destination, but
// only lists files that still exist on disk — so if someone deletes files from
// the destination, the catalogue shrinks to match reality on the next fix.
/** Scan a directory tree once and return a Set of all filenames (lowercase) */
function collectFilenames(dirPath, maxDepth = 6, currentDepth = 0) {
    const names = new Set();
    if (currentDepth > maxDepth)
        return names;
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile()) {
                names.add(entry.name.toLowerCase());
            }
            else if (entry.isDirectory() && !entry.name.startsWith('.')) {
                const sub = collectFilenames(path.join(dirPath, entry.name), maxDepth, currentDepth + 1);
                for (const n of sub)
                    names.add(n);
            }
        }
    }
    catch { /* permission error, etc. */ }
    return names;
}
export async function generateCatalogue(destinationPath) {
    const reportsDir = getReportsDirectory();
    if (!fs.existsSync(reportsDir))
        return { csv: '', txt: '' };
    // 1. Scan destination ONCE to build a fast lookup of every filename on disk
    const existingFiles = fs.existsSync(destinationPath)
        ? collectFilenames(destinationPath)
        : new Set();
    // 2. Load all reports targeting this destination
    const reportFiles = fs.readdirSync(reportsDir).filter(f => f.endsWith('.json'));
    const matchingReports = [];
    for (const file of reportFiles) {
        try {
            const content = fs.readFileSync(path.join(reportsDir, file), 'utf-8');
            const report = JSON.parse(content);
            // Normalise paths for comparison (case-insensitive on Windows, trailing slash)
            const normDest = report.destinationPath.replace(/[\\/]+$/, '').toLowerCase();
            const normTarget = destinationPath.replace(/[\\/]+$/, '').toLowerCase();
            if (normDest === normTarget) {
                matchingReports.push(report);
            }
        }
        catch { /* skip corrupt reports */ }
    }
    // Sort oldest first so catalogue reads chronologically
    matchingReports.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    // 3. Build CSV + TXT
    const csvHeaders = [
        'run_id', 'run_timestamp', 'original_filename', 'new_filename',
        'confidence', 'confidence_method', 'source_path', 'destination_path',
        'file_type', 'date_changed', 'exif_written', 'exif_source', 'status'
    ];
    const escapeCSV = (val) => {
        if (val === undefined || val === null)
            return '""';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };
    const csvRows = [];
    const txtLines = [];
    let totalProcessed = 0;
    let totalDuplicates = 0;
    let totalScanned = 0;
    let totalRemoved = 0;
    txtLines.push('='.repeat(70));
    txtLines.push('PHOTO DATE RESCUE — CUMULATIVE CATALOGUE');
    txtLines.push('='.repeat(70));
    txtLines.push('');
    txtLines.push(`Destination:   ${destinationPath}`);
    txtLines.push(`Generated:     ${new Date().toISOString()}`);
    txtLines.push(`               ${new Date().toLocaleString()}`);
    txtLines.push(`Fix runs:      ${matchingReports.length}`);
    txtLines.push('');
    for (const report of matchingReports) {
        const runScanned = report.totalScanned ?? (report.counts.confirmed + report.counts.recovered + report.counts.marked + (report.duplicatesRemoved || 0));
        totalScanned += runScanned;
        txtLines.push('-'.repeat(70));
        txtLines.push(`RUN: ${report.id}`);
        txtLines.push(`  Timestamp:   ${new Date(report.timestamp).toLocaleString()}`);
        txtLines.push(`  Sources:`);
        report.sources.forEach((s, i) => {
            txtLines.push(`    ${i + 1}. ${s.label} (${s.type}) — ${s.path}`);
        });
        txtLines.push('');
        // Processed files — only include those still on disk
        for (const f of report.files) {
            // Check against the pre-built filename set (fast O(1) lookup)
            const filenameOnly = path.basename(f.newFilename).toLowerCase();
            if (!existingFiles.has(filenameOnly)) {
                totalRemoved++;
                continue;
            }
            totalProcessed++;
            const ext = f.originalFilename.split('.').pop()?.toLowerCase() || '';
            const dateChanged = f.originalFilename !== f.newFilename;
            csvRows.push([
                escapeCSV(report.id),
                escapeCSV(report.timestamp),
                escapeCSV(f.originalFilename),
                escapeCSV(f.newFilename),
                escapeCSV(f.confidence.charAt(0).toUpperCase() + f.confidence.slice(1)),
                escapeCSV(f.dateSource),
                escapeCSV(f.sourcePath || report.sources[0]?.path || ''),
                escapeCSV(report.destinationPath),
                escapeCSV(f.fileType || ext),
                dateChanged ? 'true' : 'false',
                f.exifWritten ? 'true' : 'false',
                escapeCSV(f.exifSource || ''),
                'Processed'
            ].join(','));
            const confidenceLabel = f.confidence.charAt(0).toUpperCase() + f.confidence.slice(1);
            txtLines.push(`  File ${totalProcessed.toString().padStart(6)}:`);
            txtLines.push(`    Original:    ${f.originalFilename}`);
            txtLines.push(`    New:         ${f.newFilename}`);
            txtLines.push(`    Confidence:  ${confidenceLabel}`);
            txtLines.push(`    Method:      ${f.dateSource}`);
            txtLines.push(`    File Type:   ${f.fileType || ext}`);
            txtLines.push(`    Changed:     ${dateChanged ? 'Yes' : 'No'}`);
            txtLines.push(`    EXIF Written:${f.exifWritten ? 'Yes' : 'No'}${f.exifSource ? ` (${f.exifSource})` : ''}`);
            txtLines.push(`    Run:         ${report.id}`);
            txtLines.push('');
        }
        // Duplicates (always include — these were never copied so nothing to check)
        if (report.duplicateFiles && report.duplicateFiles.length > 0) {
            for (const dup of report.duplicateFiles) {
                totalDuplicates++;
                const ext = dup.filename.split('.').pop()?.toLowerCase() || '';
                const retainedFile = report.files.find(f => f.originalFilename === dup.duplicateOf);
                const retainedNewFilename = retainedFile?.newFilename || dup.duplicateOf;
                const duplicateConfidence = dup.duplicateMethod === 'heuristic'
                    ? 'Duplicate – Heuristic'
                    : 'Duplicate – Hash (SHA-256)';
                csvRows.push([
                    escapeCSV(report.id),
                    escapeCSV(report.timestamp),
                    escapeCSV(dup.filename),
                    escapeCSV('(skipped - duplicate)'),
                    escapeCSV(duplicateConfidence),
                    escapeCSV(`Retained as: ${retainedNewFilename}`),
                    escapeCSV(report.sources[0]?.path || ''),
                    escapeCSV(report.destinationPath),
                    escapeCSV(ext),
                    'false',
                    'false',
                    '',
                    'Skipped'
                ].join(','));
            }
        }
    }
    // Finalise CSV
    let csvContent = [csvHeaders.join(','), ...csvRows].join('\n');
    csvContent += `\n\n# PDR Catalogue — ${totalProcessed} files across ${matchingReports.length} fix runs, ${totalDuplicates} duplicates skipped`;
    if (totalRemoved > 0) {
        csvContent += `, ${totalRemoved} files no longer at destination`;
    }
    // Finalise TXT
    txtLines.push('');
    txtLines.push('='.repeat(70));
    txtLines.push('CATALOGUE SUMMARY');
    txtLines.push('='.repeat(70));
    txtLines.push(`  Fix Runs:      ${matchingReports.length}`);
    txtLines.push(`  Total Scanned: ${totalScanned.toLocaleString()} files`);
    txtLines.push(`  On Disk:       ${totalProcessed.toLocaleString()} files`);
    if (totalRemoved > 0) {
        txtLines.push(`  Removed:       ${totalRemoved.toLocaleString()} files no longer at destination`);
    }
    txtLines.push(`  Duplicates:    ${totalDuplicates.toLocaleString()} skipped`);
    txtLines.push('');
    txtLines.push('='.repeat(70));
    txtLines.push('END OF CATALOGUE');
    txtLines.push('='.repeat(70));
    return { csv: csvContent, txt: txtLines.join('\n') };
}
/** Write PDR_Catalogue.csv and PDR_Catalogue.txt to destination root */
export async function writeCatalogue(destinationPath) {
    try {
        if (!fs.existsSync(destinationPath)) {
            return { success: false, error: 'Destination not found' };
        }
        const { csv, txt } = await generateCatalogue(destinationPath);
        if (csv) {
            fs.writeFileSync(path.join(destinationPath, 'PDR_Catalogue.csv'), csv, 'utf-8');
        }
        if (txt) {
            fs.writeFileSync(path.join(destinationPath, 'PDR_Catalogue.txt'), txt, 'utf-8');
        }
        return { success: true };
    }
    catch (error) {
        console.error('Failed to write catalogue:', error);
        return { success: false, error: error.message };
    }
}
