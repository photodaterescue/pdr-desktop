// electron/source-classifier.ts
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
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

// v2.0.15 (Terry 2026-06-03) — cloud-sync detection rewritten.
//
// PREVIOUS BEHAVIOUR (buggy): a regex array (/onedrive/i, /dropbox/i,
// etc.) matched the source path as a string. ANY folder whose name
// contained "OneDrive" anywhere in the path was flagged as cloud-
// synced — including Terry's "F:\OneDrive Copied to Computer\..."
// which is just a local folder he named that way after copying his
// OneDrive contents OFF the cloud. False positives like this surfaced
// the spurious "Cloud-Synced Folder" badge in the Pre-Scan Results
// modal and the (incorrect) "files may download on demand" caution.
//
// NEW BEHAVIOUR (correct): check whether the source path is INSIDE a
// known cloud-sync folder root — not whether the folder NAME happens
// to contain a provider word. Roots are discovered by enumerating
// %USERPROFILE% for `OneDrive*` / `Dropbox` / `Google Drive` /
// `iCloudDrive` entries that actually exist on disk. A folder is
// classified as cloud-sync only if its normalised path starts with
// one of those resolved roots followed by a path separator.
//
// Trade-off: this misses non-default sync root locations (e.g. a
// user who configured OneDrive to sync into D:\Sync via OneDrive
// settings). For those, registry-based discovery would be the proper
// fix and is left for a follow-up. The default-location heuristic
// here handles ~95 % of real Windows installs and resolves the false
// positive Terry hit.

function getCloudSyncRoots(): string[] {
  const roots: string[] = [];
  const userProfile = process.env.USERPROFILE || os.homedir() || '';
  if (!userProfile) return roots;

  // OneDrive personal lives at %USERPROFILE%\OneDrive; OneDrive
  // business lives at %USERPROFILE%\OneDrive - <Org>. Both start
  // with "OneDrive" so a directory scan catches all variants.
  try {
    const entries = fs.readdirSync(userProfile);
    for (const entry of entries) {
      if (entry.toLowerCase().startsWith('onedrive')) {
        const full = path.join(userProfile, entry);
        try {
          if (fs.statSync(full).isDirectory()) roots.push(full.toLowerCase());
        } catch { /* not a directory or unreadable — skip */ }
      }
    }
  } catch { /* %USERPROFILE% unreadable — skip */ }

  // Other providers: check their default install locations.
  for (const name of ['Dropbox', 'Google Drive', 'iCloudDrive', 'Box', 'MEGA']) {
    const candidate = path.join(userProfile, name);
    try {
      if (fs.statSync(candidate).isDirectory()) roots.push(candidate.toLowerCase());
    } catch { /* doesn't exist — skip */ }
  }

  return roots;
}

function isInCloudSyncRoot(sourcePath: string): boolean {
  const normalized = path.normalize(sourcePath).toLowerCase();
  const roots = getCloudSyncRoots();
  return roots.some(root => normalized === root || normalized.startsWith(root + path.sep.toLowerCase()));
}

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

  // Check for cloud sync folders — uses path-prefix match against
  // resolved roots from %USERPROFILE%, not the previous broad regex
  // on the path string. See the comment above getCloudSyncRoots().
  if (isInCloudSyncRoot(normalizedPath)) {
    return {
      type: 'cloud-sync',
      speed: 'slow',
      label: 'Cloud-Synced Folder',
      description: 'Cloud-synced folder — files may download on demand, which can slow processing.',
      isOptimal: false,
    };
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