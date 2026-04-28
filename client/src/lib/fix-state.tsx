import { useEffect, useState } from 'react';
import { getFixInProgress, onFixStateChanged } from './electron-bridge';

/**
 * useFixInProgress — read-only hook returning whether a Fix is
 * currently running anywhere in PDR. Works across windows: PM,
 * Date Editor, etc. all see the same flag because the main
 * process broadcasts state changes via the 'fix:stateChanged'
 * IPC channel.
 *
 * Used by mutating actions (Recluster, Improve Recognition, XMP
 * import, second Fix attempt, Parallel Structures, Edit Dates
 * Save, etc.) to disable themselves while a Fix is in flight,
 * preventing concurrent writes that would compete for the same
 * tables (face_detections, indexed_files) or CPU paths.
 *
 * On mount: pulls the cold-start value, then subscribes to live
 * changes. Outside Electron returns false.
 */
export function useFixInProgress(): boolean {
  const [inProgress, setInProgress] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getFixInProgress().then((v) => { if (!cancelled) setInProgress(v); });
    const unsubscribe = onFixStateChanged((state) => {
      setInProgress(!!state.inProgress);
    });
    return () => { cancelled = true; unsubscribe(); };
  }, []);
  return inProgress;
}

/**
 * Standard reason copy shown in tooltips / toasts when a mutating
 * action is blocked because a Fix is running. Centralised so the
 * wording is consistent across surfaces.
 */
export const FIX_BLOCKED_TOOLTIP = 'Available when the current Fix completes';
export const FIX_BLOCKED_TOAST = 'Wait for the current Fix to finish before doing this.';
