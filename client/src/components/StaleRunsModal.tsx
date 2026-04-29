import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, AlertTriangle, FolderSearch, FolderOpen, Trash2,
  RefreshCw, CheckCircle2, Loader2, Unplug, HardDrive,
  FolderEdit, Network, Wrench, ChevronDown, ChevronUp,
  Info, ShieldAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { FolderBrowserModal } from './FolderBrowserModal';
import {
  relocateSearchRun,
  removeSearchRun,
  type IndexedRun,
} from '@/lib/electron-bridge';

interface StaleRunsModalProps {
  isOpen: boolean;
  onClose: () => void;
  staleRuns: IndexedRun[];
  onResolved: () => void; // Called after all runs handled — refresh data
}

type RunAction = 'pending' | 'relocating' | 'relocated' | 'removed' | 'error';

export default function StaleRunsModal({ isOpen, onClose, staleRuns, onResolved }: StaleRunsModalProps) {
  const [runStates, setRunStates] = useState<Record<number, { action: RunAction; error?: string; newPath?: string }>>(
    () => Object.fromEntries(staleRuns.map(r => [r.id, { action: 'pending' as RunAction }]))
  );
  const [browsingRunId, setBrowsingRunId] = useState<number | null>(null);
  const [showGuidance, setShowGuidance] = useState(false);
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<number | null>(null);

  const pendingCount = Object.values(runStates).filter(s => s.action === 'pending').length;
  const allResolved = pendingCount === 0;

  const handleRelocate = async (runId: number, newPath: string) => {
    setRunStates(prev => ({ ...prev, [runId]: { action: 'relocating' } }));
    const result = await relocateSearchRun(runId, newPath);
    if (result.success) {
      setRunStates(prev => ({ ...prev, [runId]: { action: 'relocated', newPath } }));
    } else {
      setRunStates(prev => ({ ...prev, [runId]: { action: 'error', error: result.error || 'Failed to relocate' } }));
    }
  };

  const handleRemove = async (runId: number) => {
    setRunStates(prev => ({ ...prev, [runId]: { action: 'relocating' } })); // show loading
    const result = await removeSearchRun(runId);
    if (result.success) {
      setRunStates(prev => ({ ...prev, [runId]: { action: 'removed' } }));
    } else {
      setRunStates(prev => ({ ...prev, [runId]: { action: 'error', error: 'Failed to remove' } }));
    }
  };

  const handleDone = () => {
    onResolved();
    onClose();
  };

  if (!isOpen || staleRuns.length === 0) return null;

  return (
    <>
      <AnimatePresence>
        <motion.div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="bg-background rounded-2xl shadow-2xl border border-border w-[560px] max-h-[80vh] overflow-hidden flex flex-col"
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-amber-500" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">Library Locations Not Found</h2>
                  <p className="text-xs text-muted-foreground">
                    {staleRuns.length} indexed {staleRuns.length === 1 ? 'location has' : 'locations have'} moved or been renamed
                  </p>
                </div>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
              <p className="text-sm text-muted-foreground leading-relaxed">
                The following destinations can't be found at their expected locations.
                This is usually easy to fix — tap <span className="font-medium text-foreground">Why is this happening?</span> below for common causes and solutions.
              </p>

              {/* Expandable scenario guidance */}
              <div className="rounded-xl border border-border bg-secondary/30 overflow-hidden">
                <button
                  onClick={() => setShowGuidance(!showGuidance)}
                  className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-secondary/50 transition-colors"
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <Info className="w-4 h-4 text-primary" />
                    Why is this happening?
                  </span>
                  {showGuidance ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                </button>

                {showGuidance && (
                  <div className="px-4 pb-4 space-y-3 border-t border-border pt-3">
                    <div className="flex items-start gap-2.5">
                      <Unplug className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-xs font-medium text-foreground">External drive disconnected</p>
                        <p className="text-[11px] text-muted-foreground">Reconnect the USB drive or external hard drive, then dismiss this dialog. It will resolve automatically next time.</p>
                      </div>
                    </div>

                    <div className="flex items-start gap-2.5">
                      <HardDrive className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-xs font-medium text-foreground">Drive letter changed</p>
                        <p className="text-[11px] text-muted-foreground">Windows sometimes reassigns drive letters (e.g. D: became E:). Use <strong>Relocate</strong> to point to the same folder on its new letter, or reassign the original letter in Disk Management.</p>
                      </div>
                    </div>

                    <div className="flex items-start gap-2.5">
                      <FolderEdit className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-xs font-medium text-foreground">Folder renamed or moved</p>
                        <p className="text-[11px] text-muted-foreground">If you renamed or reorganised the destination, use <strong>Relocate</strong> to browse to its new location. All your search and AI data will be preserved.</p>
                      </div>
                    </div>

                    <div className="flex items-start gap-2.5">
                      <Network className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-xs font-medium text-foreground">Network or NAS path changed</p>
                        <p className="text-[11px] text-muted-foreground">If the NAS or network share path changed, ensure the drive is mounted and accessible, then use <strong>Relocate</strong>. If the NAS is simply powered off, dismiss and reconnect it.</p>
                      </div>
                    </div>

                    <div className="flex items-start gap-2.5">
                      <Wrench className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-xs font-medium text-foreground">Drive being serviced or formatted</p>
                        <p className="text-[11px] text-muted-foreground">If the drive is temporarily unavailable, just dismiss this dialog. You'll be prompted again next time you open the app.</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {staleRuns.map(run => {
                const state = runStates[run.id] || { action: 'pending' };
                const isConfirmingRemove = confirmingRemoveId === run.id;
                return (
                  <div
                    key={run.id}
                    className={`p-4 rounded-xl border-2 transition-all ${
                      state.action === 'relocated' ? 'border-green-500/30 bg-green-50/50 dark:bg-green-900/10' :
                      state.action === 'removed' ? 'border-border bg-secondary/20 opacity-70' :
                      state.action === 'error' ? 'border-red-500/30 bg-red-50/50 dark:bg-red-900/10' :
                      'border-amber-500/30 bg-amber-50/30 dark:bg-amber-900/10'
                    }`}
                  >
                    {/* Path info */}
                    <div className="mb-2">
                      <IconTooltip label={run.destination_path} side="top">
                        <p className="text-sm font-medium text-foreground truncate">
                          {run.destination_path}
                        </p>
                      </IconTooltip>
                      <p className="text-xs text-muted-foreground">
                        {run.file_count} files · {run.source_labels || 'Unknown source'} · Indexed {new Date(run.indexed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </p>
                    </div>

                    {/* Status / Actions */}
                    {state.action === 'pending' && !isConfirmingRemove && (
                      <div className="flex items-center gap-2 mt-3">
                        <Button
                          size="sm"
                          variant="information"
                          onClick={() => setBrowsingRunId(run.id)}
                          className="flex-1 text-xs"
                        >
                          <FolderSearch className="w-3.5 h-3.5 mr-1.5" />
                          Relocate — browse to new location
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => setConfirmingRemoveId(run.id)}
                          className="text-xs"
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                          Remove
                        </Button>
                      </div>
                    )}

                    {/* Remove confirmation */}
                    {state.action === 'pending' && isConfirmingRemove && (
                      <div className="mt-3 p-3 rounded-lg bg-red-50/80 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 space-y-2">
                        <div className="flex items-start gap-2">
                          <ShieldAlert className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                          <div className="text-[11px] text-red-700 dark:text-red-300 leading-relaxed">
                            <p className="font-semibold mb-1">Are you sure? This will permanently delete:</p>
                            <ul className="list-disc list-inside space-y-0.5 text-red-600 dark:text-red-400">
                              <li>The search index for this location</li>
                              <li>All AI analysis — faces, tags, and processing data</li>
                            </ul>
                            <p className="mt-1.5 text-muted-foreground">
                              Your fix report will remain in Reports History and the files can be re-indexed later, but AI analysis will need to be re-run from scratch.
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 pt-1">
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => { setConfirmingRemoveId(null); handleRemove(run.id); }}
                            className="text-xs flex-1"
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                            Yes, permanently remove
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setConfirmingRemoveId(null)}
                            className="text-xs"
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}

                    {state.action === 'relocating' && (
                      <div className="flex items-center gap-2 mt-3 text-sm text-muted-foreground">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Updating paths...</span>
                      </div>
                    )}

                    {state.action === 'relocated' && (
                      <div className="flex items-center gap-2 mt-3">
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                        <span className="text-xs text-green-600 dark:text-green-400 font-medium">
                          Relocated to: <span className="font-normal text-muted-foreground">{state.newPath}</span>
                        </span>
                      </div>
                    )}

                    {state.action === 'removed' && (
                      <div className="flex items-center gap-2 mt-3">
                        <Trash2 className="w-4 h-4 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">Removed from library — AI data permanently deleted</span>
                      </div>
                    )}

                    {state.action === 'error' && (
                      <div className="flex items-center gap-2 mt-3">
                        <AlertTriangle className="w-4 h-4 text-red-500" />
                        <span className="text-xs text-red-500">{state.error}</span>
                        <button
                          onClick={() => setRunStates(prev => ({ ...prev, [run.id]: { action: 'pending' } }))}
                          className="text-xs text-primary hover:text-primary/80 ml-auto"
                        >
                          Try again
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-border">
              {allResolved ? (
                <div className="flex justify-end">
                  <Button variant="primary" onClick={handleDone}>Done</Button>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-muted-foreground/70 max-w-[280px] leading-relaxed">
                    Dismissing? You'll be prompted again next time. Reconnect the drive or fix the path first.
                  </p>
                  <Button variant="secondary" onClick={handleDone}>Dismiss for now</Button>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      </AnimatePresence>

      {/* Folder browser for relocating */}
      {browsingRunId !== null && (
        <FolderBrowserModal
          isOpen={true}
          onCancel={() => setBrowsingRunId(null)}
          onSelect={(newPath) => {
            const runId = browsingRunId;
            setBrowsingRunId(null);
            handleRelocate(runId, newPath);
          }}
          title="Browse to the new location of this library"
          mode="folder"
        />
      )}
    </>
  );
}
