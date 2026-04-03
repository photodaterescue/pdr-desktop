// electron/source-classifier.ts
import * as path from 'path';
import { execSync } from 'child_process';

export type StorageType = 'local-ssd' | 'local-hdd' | 'network' | 'cloud-sync' | 'unknown';
export type StorageSpeed = 'fast' | 'medium' | 'slow';

export interface StorageClassification {
  type: StorageType;
  speed: StorageSpeed;
  label: string;
  description: string;
  isOptimal: boolean;
}

const CLOUD_SYNC_PATTERNS = [
  /onedrive/i,
  /dropbox/i,
  /google\s*drive/i,
  /icloud/i,
  /box\s*sync/i,
  /mega/i,
];

function isMappedNetworkDrive(driveLetter: string): boolean {
  const letter = driveLetter.toUpperCase().replace(':', '');
  
  try {
    // Use 'net use' to check if drive is mapped
    const output = execSync('net use', { encoding: 'utf8', timeout: 5000 });
    return output.includes(`${letter}:`);
  } catch (e) {
    // If net use fails, assume local
    return false;
  }
}

export function classifySource(sourcePath: string): StorageClassification {
  if (!sourcePath) {
    return {
      type: 'unknown',
      speed: 'medium',
      label: 'Unknown',
      description: 'Unable to determine storage type',
      isOptimal: false,
    };
  }

  const normalizedPath = path.normalize(sourcePath);

  // Check for UNC path (network share)
  if (normalizedPath.startsWith('\\\\')) {
    return {
      type: 'network',
      speed: 'slow',
      label: 'Network Drive',
      description: 'Network drive detected — analysis and copying may take longer. This is normal.',
      isOptimal: false,
    };
  }

  // Check for cloud sync folders
  for (const pattern of CLOUD_SYNC_PATTERNS) {
    if (pattern.test(normalizedPath)) {
      return {
        type: 'cloud-sync',
        speed: 'slow',
        label: 'Cloud-Synced Folder',
        description: 'Cloud-synced folder — files may download on demand, which can slow processing.',
        isOptimal: false,
      };
    }
  }

  // Drive letter - check if it's a mapped network drive
  const driveMatch = normalizedPath.match(/^([A-Za-z]):/);
  if (driveMatch) {
    const driveLetter = driveMatch[1];
    
    // Check if this is a mapped network drive
    if (isMappedNetworkDrive(driveLetter)) {
      return {
        type: 'network',
        speed: 'slow',
        label: 'Network Drive',
        description: 'Mapped network drive detected — analysis and copying may take longer. This is normal.',
        isOptimal: false,
      };
    }
    
    // It's a local drive
    return {
      type: 'local-ssd',
      speed: 'fast',
      label: 'Local Drive',
      description: 'Local drive — optimal for fast processing.',
      isOptimal: true,
    };
  }

  return {
    type: 'unknown',
    speed: 'medium',
    label: 'Unknown Storage',
    description: 'Unable to determine storage type.',
    isOptimal: false,
  };
}

export function checkSameDriveWarning(sourcePath: string, outputPath: string): { 
  showWarning: boolean; 
  message: string;
} {
  if (!sourcePath || !outputPath) {
    return { showWarning: false, message: '' };
  }

  const sourceClass = classifySource(sourcePath);
  const outputClass = classifySource(outputPath);

  if (sourceClass.speed === 'slow' && outputClass.speed === 'slow') {
    const sourceRoot = getStorageRoot(sourcePath);
    const outputRoot = getStorageRoot(outputPath);

    if (sourceRoot && outputRoot && sourceRoot.toLowerCase() === outputRoot.toLowerCase()) {
      return {
        showWarning: true,
        message: 'Using the same network or cloud drive for both source and output may significantly slow processing. For best performance, use a local drive for the output and copy results back afterward.',
      };
    }
  }

  return { showWarning: false, message: '' };
}

function getStorageRoot(filePath: string): string | null {
  const normalizedPath = path.normalize(filePath);

  if (normalizedPath.startsWith('\\\\')) {
    const parts = normalizedPath.split('\\').filter(Boolean);
    if (parts.length >= 2) {
      return `\\\\${parts[0]}\\${parts[1]}`;
    }
  }

  const driveMatch = normalizedPath.match(/^([A-Za-z]):/);
  if (driveMatch) {
    return `${driveMatch[1]}:`;
  }

  return null;
}