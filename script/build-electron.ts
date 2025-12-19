import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('Building Electron app...');

const distElectronDir = path.join(rootDir, 'dist-electron');
if (!fs.existsSync(distElectronDir)) {
  fs.mkdirSync(distElectronDir, { recursive: true });
}

console.log('Compiling Electron TypeScript...');
execSync('npx tsc -p electron/tsconfig.json', { 
  cwd: rootDir, 
  stdio: 'inherit' 
});

console.log('Electron build complete!');
