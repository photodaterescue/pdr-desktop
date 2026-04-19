import { AlertTriangle } from 'lucide-react';
import { useMainAlive } from '../hooks/useMainAlive';

/**
 * Full-width banner shown at the top of a child window (People, Date Editor)
 * when the main PDR process stops responding. Explains what happened and
 * tells the user to relaunch — since the child window can't write to the
 * database without main, continuing would risk silent data loss.
 */
export function MainAliveBanner() {
  const alive = useMainAlive();
  if (alive) return null;
  return (
    <div className="shrink-0 border-b border-red-400 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-200 px-4 py-2.5 flex items-center gap-2.5">
      <AlertTriangle className="w-4 h-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">PDR has stopped responding.</div>
        <div className="text-xs opacity-90">
          This window can no longer save changes. Close it and relaunch PDR before editing further — any input made now will be discarded.
        </div>
      </div>
      <button
        onClick={() => window.close()}
        className="shrink-0 px-3 py-1 rounded-md bg-red-600 text-white text-xs font-semibold hover:bg-red-700 transition-colors"
      >
        Close window
      </button>
    </div>
  );
}
