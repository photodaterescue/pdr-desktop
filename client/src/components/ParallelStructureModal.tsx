import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, FolderOpen, Copy, ArrowRightLeft, CheckCircle2, AlertTriangle,
  Loader2, HardDrive, ExternalLink, Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FolderBrowserModal } from './FolderBrowserModal';
import DestinationAdvisorModal from './DestinationAdvisorModal';
import {
  copyToStructure,
  cancelStructureCopy,
  onStructureProgress,
  getDiskSpaceBridge,
  type IndexedFile,
  type StructureProgress,
  type StructureCopyResult,
} from '@/lib/electron-bridge';

/** Find the longest path prefix shared by every file in `files`.
 *  Used to surface "your photos currently live in: X" in the
 *  Parallel Structure picker so the user knows what they're
 *  mirroring FROM and can choose to keep the new structure on
 *  the same drive or move to a different one. */
function commonPathPrefix(files: { file_path: string }[]): string {
  if (files.length === 0) return '';
  if (files.length === 1) {
    const p = files[0].file_path;
    const lastSep = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return lastSep > 0 ? p.slice(0, lastSep) : '';
  }
  const split = (s: string) => s.split(/[\\/]/);
  const parts = files.map(f => split(f.file_path));
  const min = Math.min(...parts.map(p => p.length));
  const common: string[] = [];
  for (let i = 0; i < min; i++) {
    const seg = parts[0][i];
    if (parts.every(p => p[i] === seg)) common.push(seg);
    else break;
  }
  // Drop the last segment if it's empty (trailing separator) and
  // never include the file's own name.
  return common.join('\\').replace(/\\$/, '');
}

interface ParallelStructureModalProps {
  isOpen: boolean;
  onClose: () => void;
  files: IndexedFile[];
  totalResultCount: number;
}

type Phase = 'configure' | 'running' | 'complete';

export default function ParallelStructureModal({ isOpen, onClose, files, totalResultCount }: ParallelStructureModalProps) {
  const [phase, setPhase] = useState<Phase>('configure');
  const [destination, setDestination] = useState('');
  const [mode, setMode] = useState<'copy' | 'move'>('copy');
  const [folderStructure, setFolderStructure] = useState<'year' | 'year-month' | 'year-month-day'>('year-month-day');
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  // Listen for the LDM's picked-drive event so the Browse button can
  // route through the Library Drive Manager (v2.0.6, Terry's call).
  // Filter on `caller === 'parallel-library'` so other LDM-pick-mode
  // callers in future don't leak into this modal.
  useEffect(() => {
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent<{ caller?: string; path?: string }>).detail ?? {};
      if (detail.caller !== 'parallel-library') return;
      if (typeof detail.path !== 'string' || detail.path.length === 0) return;
      setDestination(detail.path);
    };
    window.addEventListener('pdr:libraryDrivePicked', handler as EventListener);
    return () => window.removeEventListener('pdr:libraryDrivePicked', handler as EventListener);
  }, []);
  // v2.0.6 — Parallel Library is now PURELY a file-copy operation.
  // The previous "Add to search" path called rebuildFromLibraries on
  // the destination after the copy, which walked the destination tree
  // and silently overwrote `confidence` (→ Confirmed) and
  // `original_filename` (→ blank) on ANY pre-existing indexed rows
  // whose file_path lived under that tree. Terry's two test files on
  // 2026-05-16 lost their Recovered status + Original Name through
  // exactly this path. Until v2.2's per-library independent PDR
  // instances exist, PL stays out of the search index entirely. The
  // master Library Drive remains the canonical source of truth in
  // S&D / Memories / Trees, and PL is a tidy file copy on disk —
  // nothing more. A deliberate "Re-index this folder" tool will land
  // in v2.0.7 as a separate Tools-section action with explicit user
  // intent and a non-destructive walk.
  const [showBrowser, setShowBrowser] = useState(false);
  const [showDriveAdvisor, setShowDriveAdvisor] = useState(false);

  // Disk space
  const [diskSpace, setDiskSpace] = useState<{ free: number; total: number } | null>(null);

  // Progress
  const [progress, setProgress] = useState<StructureProgress | null>(null);

  // Result
  const [result, setResult] = useState<StructureCopyResult | null>(null);

  // Calculate totals
  const totalSize = files.reduce((sum, f) => sum + (f.size_bytes || 0), 0);
  const totalSizeGB = totalSize / (1024 * 1024 * 1024);
  const undatedCount = files.filter(f => !f.derived_date).length;

  // Source library path — what the user is mirroring FROM. Shown
  // as context above the destination picker so the "same drive vs
  // different drive" decision is informed: most users want the
  // parallel structure on the same drive as the original library
  // for speed, but should know the option exists to use a different
  // drive (e.g. a memory stick, external HDD, etc).
  const sourceLibraryPath = useMemo(() => commonPathPrefix(files), [files]);
  const sourceDriveLetter = sourceLibraryPath.match(/^([A-Za-z]:)/)?.[1];

  // Load folder structure preference from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('pdr-folder-structure');
    if (stored === 'year' || stored === 'year-month' || stored === 'year-month-day') {
      setFolderStructure(stored);
    }
  }, []);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setPhase('configure');
      setProgress(null);
      setResult(null);
    }
  }, [isOpen]);

  // Fetch disk space when destination changes.
  //
  // The disk-space IPC returns NaN if the path doesn't exist (the
  // user typed in a NEW subfolder name like "Parallel Library 1"
  // that hasn't been created yet). Free/total bytes are a VOLUME-
  // level property — same answer whether we probe D:\foo\bar\baz
  // or just D:\ — so when the deeper path fails we walk back up to
  // the deepest parent that returns a valid result. The drive root
  // is always present and is the guaranteed fallback. Replaces the
  // earlier "fall back to —" behaviour Terry called out: leaving
  // the field blank is worse than showing the right number from a
  // parent path.
  useEffect(() => {
    if (!destination) {
      setDiskSpace(null);
      return;
    }
    let cancelled = false;
    const probeWithFallback = async () => {
      // Candidate paths: deepest first, walking up to the drive root.
      const candidates: string[] = [];
      let current = destination;
      const seen = new Set<string>();
      while (current && !seen.has(current)) {
        seen.add(current);
        candidates.push(current);
        // Step up one level. Windows path separator handling — split
        // on backslash, drop last segment. Stop when we hit the drive
        // root ("D:\" or just "D:").
        const cleaned = current.replace(/[\\/]+$/, '');
        const idx = Math.max(cleaned.lastIndexOf('\\'), cleaned.lastIndexOf('/'));
        if (idx <= 2) {
          // We're at "D:" or shallower — add the drive root explicitly
          // and stop.
          const driveLetterMatch = cleaned.match(/^([A-Za-z]:)/);
          if (driveLetterMatch) candidates.push(driveLetterMatch[1] + '\\');
          break;
        }
        current = cleaned.slice(0, idx);
      }

      for (const candidate of candidates) {
        try {
          const res = await getDiskSpaceBridge(candidate);
          if (cancelled) return;
          if (
            res.success &&
            res.data &&
            Number.isFinite(res.data.free) &&
            Number.isFinite(res.data.total) &&
            res.data.total > 0
          ) {
            setDiskSpace(res.data);
            return;
          }
        } catch {
          // try next candidate
        }
      }
      // Every candidate failed (offline drive, unreachable path, etc).
      if (!cancelled) setDiskSpace(null);
    };
    void probeWithFallback();
    return () => { cancelled = true; };
  }, [destination]);

  // Listen for progress events
  useEffect(() => {
    if (phase !== 'running') return;
    const cleanup = onStructureProgress((p) => {
      setProgress(p);
      if (p.phase === 'complete') {
        // Result will come from the promise
      }
    });
    return cleanup;
  }, [phase]);

  const handleStart = useCallback(async () => {
    if (!destination || files.length === 0) return;
    setPhase('running');
    setProgress({ current: 0, total: files.length, currentFile: '', phase: 'copying' });

    const data = {
      files: files.map(f => ({
        sourcePath: f.file_path,
        filename: f.filename,
        derivedDate: f.derived_date || null,
        sizeBytes: f.size_bytes || 0,
      })),
      destinationPath: destination,
      folderStructure,
      mode,
      skipDuplicates,
    };

    const res = await copyToStructure(data);
    setResult(res);

    // v2.0.6 — post-copy indexing REMOVED. The previous path called
    // rebuildFromLibraries on the destination, which walked the
    // destination tree and silently overwrote master-library rows'
    // confidence + original_filename (Recovered → Confirmed, name
    // → blank) for any pre-existing indexed files under that tree.
    // Until v2.2 introduces per-library independent PDR instances,
    // PL is a pure copy operation — the master Library Drive stays
    // the canonical source of truth in S&D / Memories / Trees. A
    // deliberate "Re-index this folder" tool will land in v2.0.7
    // for users who want copies (or any folder) indexed on demand.
    setPhase('complete');
  }, [destination, files, folderStructure, mode, skipDuplicates]);

  const handleCancel = useCallback(async () => {
    await cancelStructureCopy();
  }, []);

  const handleOpenDestination = useCallback(() => {
    if (destination && (window as any).pdr?.openDestinationFolder) {
      (window as any).pdr.openDestinationFolder(destination);
    }
  }, [destination]);

  const formatBytes = (bytes: number) => {
    // Guard against NaN / Infinity / undefined-coerced-to-number.
    // Terry's report (2026-05-15): typing a NEW subfolder name into
    // the destination field made getDiskSpaceBridge return NaN for
    // free/total (the folder doesn't exist yet so the probe can't
    // measure it). Without this guard `formatBytes(NaN)` falls
    // through every numeric branch and renders "NaN GB". Fall back
    // to "—" so the user sees a placeholder rather than a math
    // error.
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    // GB / TB threshold matches the Dashboard's Output card
    // (workspace.tsx:4444) — at 1000 binary GB, flip to TB so the
    // user sees "1.29 TB" instead of "1290.27 GB" for typical
    // 1-2 TB external drives. Terry's call 2026-05-16.
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb < 1000) return `${gb.toFixed(2)} GB`;
    return `${(gb / 1000).toFixed(2)} TB`;
  };

  if (!isOpen) return null;

  return (
    <>
      <AnimatePresence>
        <motion.div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={(e) => { if (e.target === e.currentTarget && phase !== 'running') onClose(); }}
        >
          <motion.div
            className="bg-background rounded-2xl shadow-2xl border border-border w-[520px] max-h-[85vh] overflow-hidden flex flex-col"
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  {phase === 'complete' ? (
                    <CheckCircle2 className="w-5 h-5 text-green-500" />
                  ) : (
                    <Copy className="w-5 h-5 text-primary" />
                  )}
                </div>
                <div>
                  <h2 className="text-lg font-semibold">
                    {phase === 'complete' ? 'Parallel Library Created' : phase === 'running' ? 'Creating Parallel Library...' : 'Create Parallel Library'}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {files.length} file{files.length !== 1 ? 's' : ''} selected ({formatBytes(totalSize)})
                  </p>
                </div>
              </div>
              {phase !== 'running' && (
                <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary transition-colors">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-5">

              {/* ── CONFIGURE PHASE ── */}
              {phase === 'configure' && (
                <div className="space-y-5">
                  {/* Source library context — tells the user what
                      they're mirroring FROM so the same-drive vs
                      different-drive choice is informed. */}
                  {sourceLibraryPath && (
                    <div className="p-3 rounded-xl bg-secondary/30 border border-border">
                      <div className="flex items-start gap-2.5">
                        <FolderOpen className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-0.5">Your photos currently live in</p>
                          <p className="text-xs text-foreground font-mono truncate" title={sourceLibraryPath}>{sourceLibraryPath}</p>
                          {sourceDriveLetter && (
                            <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
                              Most users keep the Parallel Library on the same drive ({sourceDriveLetter}) for speed — but you can pick any drive (memory stick, external HDD, NAS). Use the Drive Advisor to see which drives can fit this batch.
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Destination picker */}
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1.5 block">Library Drive</label>
                    <div className="flex gap-2 flex-wrap">
                      <div className="flex-1 px-3 py-2 rounded-lg border border-border bg-secondary/30 text-sm text-foreground truncate min-h-[38px] flex items-center min-w-0">
                        {destination || <span className="text-muted-foreground">Choose a folder...</span>}
                      </div>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => {
                          // v2.0.6: route Browse through the LDM
                          // (Terry's call — "I want the LDM, not
                          // close enough"). Dispatches the pick-mode
                          // event with caller='parallel-library'; the
                          // LDM opens in pick-mode, user clicks a
                          // drive radio, LDM dispatches
                          // pdr:libraryDrivePicked back, our handler
                          // up top sets destination.
                          window.dispatchEvent(new CustomEvent('pdr:openLibraryPanelForPick', {
                            detail: { caller: 'parallel-library' },
                          }));
                        }}
                        className="shrink-0"
                        // Lavender outline-pulse while no Library Drive
                        // is selected — mirrors the Workspace "Select
                        // Library Drive" CTA pattern. Animation stops
                        // the moment the user picks a folder so it
                        // doesn't keep tugging at the eye once the
                        // action is done. The reason the user (Terry,
                        // 2026-05-16) didn't realise the Start
                        // Move/Copy button was disabled because of
                        // an empty destination — there was no signal
                        // on the unfilled field. The pulse tells the
                        // eye where to look first.
                        style={!destination ? { animation: 'outline-pulse 2s ease-in-out infinite' } : undefined}
                      >
                        <FolderOpen className="w-4 h-4 mr-1.5" />
                        Browse
                      </Button>
                      <Button variant="information" size="sm" onClick={() => setShowDriveAdvisor(true)} className="shrink-0">
                        <Info className="w-4 h-4 mr-1.5" />
                        Drive Advisor
                      </Button>
                    </div>
                    {/* Disk-space card — only renders when destination
                        is set. Empty state matches the Dashboard's
                        "no destination yet" treatment: just the
                        primary picker + Drive Advisor buttons, no
                        "Calculating space…" placeholder pill. Terry
                        2026-05-16: "I think the PL should look like
                        [the Dashboard empty state] also when there's
                        no source selected." */}
                    {destination ? <>
                    {/* Disk-space card — lifted from the Dashboard's
                        Output card pattern (workspace.tsx:4424-4490)
                        so the user gets the same visual treatment
                        for "will this fit?" wherever they look in
                        PDR. Terry's call (2026-05-16): "Instead of
                        trying to redesign it, why not use the same
                        thing from the Dashboard?" Includes the
                        used-vs-free progress bar, the required-size
                        pill (green when it fits, red when it
                        doesn't, slate while the probe is in flight),
                        the "free after this fix" follow-on pill,
                        and a Loader2 spinner during probe.
                        PL works in bytes natively; Dashboard works
                        in GB. We pass bytes through formatBytes for
                        display + keep arithmetic in bytes.
                        Probe-pending state: diskSpace === null. */}
                    <div className="mt-2 space-y-2">
                      {/* Visual space bar — only when we have a real
                          total and there's something to copy. */}
                      {diskSpace && diskSpace.total > 0 && totalSize > 0 && (() => {
                        const used = diskSpace.total - diskSpace.free;
                        const usedPercent = Math.round((used / diskSpace.total) * 100);
                        const requiredPercent = Math.min(100 - usedPercent, Math.round((totalSize / diskSpace.total) * 100));
                        const fits = diskSpace.free >= totalSize;
                        return (
                          <div>
                            <div className="w-full h-2.5 rounded-full bg-secondary overflow-hidden">
                              <div className="h-full flex">
                                <div className="h-full bg-muted-foreground/30 rounded-l-full" style={{ width: `${usedPercent}%` }} />
                                <div className={`h-full ${fits ? 'bg-primary/60' : 'bg-rose-500/60'}`} style={{ width: `${requiredPercent}%` }} />
                              </div>
                            </div>
                            <div className="flex items-center justify-between mt-1 text-caption">
                              <span>{formatBytes(used)} used</span>
                              <span>{formatBytes(diskSpace.free)} free of {formatBytes(diskSpace.total)}</span>
                            </div>
                          </div>
                        );
                      })()}

                      {/* Required / fits-after pills. */}
                      <div className="flex items-center gap-2 flex-wrap">
                        {!diskSpace ? (
                          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-500/10 ring-1 ring-slate-500/20 text-slate-600 dark:text-slate-300">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            <span className="text-xs font-medium">Calculating space…</span>
                          </div>
                        ) : diskSpace.free >= totalSize ? (
                          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30 text-emerald-700 dark:text-emerald-300">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span className="text-xs font-medium">Copying {formatBytes(totalSize)}</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-500/15 ring-1 ring-rose-500/30 text-rose-700 dark:text-rose-300">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            <span className="text-xs font-medium">Needs {formatBytes(totalSize)}</span>
                          </div>
                        )}
                        {diskSpace && diskSpace.free >= totalSize && totalSize > 0 && (
                          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-100/50 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200/50 dark:border-emerald-700/50">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span className="text-xs font-medium">
                              {formatBytes(diskSpace.free - totalSize)} free after this copy
                            </span>
                          </div>
                        )}
                        {diskSpace && diskSpace.free < totalSize && (
                          <span className="text-xs text-rose-700 dark:text-rose-300 font-medium ml-auto">Insufficient space</span>
                        )}
                      </div>
                    </div>
                    </> : null}
                  </div>

                  {/* Operation mode.
                      Typography brought in line with the 8-tier style
                      guide (v2.0.6): label uses text-label, subline
                      uses text-caption, warning uses text-caption.
                      Amber text colour strengthened from amber-500
                      (low contrast) to amber-700 / amber-300 so the
                      caution palette is readable at caption size —
                      this was Terry's call (2026-05-16). The
                      operation-toggle buttons stay as custom
                      <button>s for now; a proper Button-primitive
                      rewrite is on the v2.0.7 style-audit roadmap
                      because changing the click semantics now risks
                      regressions ahead of the v2.0.6 cut. */}
                  <div>
                    <label className="text-label text-foreground mb-2 block">Operation</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => setMode('copy')}
                        className={`flex items-center gap-2.5 p-3 rounded-xl border-2 transition-all ${
                          mode === 'copy' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30'
                        }`}
                      >
                        <Copy className={`w-4 h-4 ${mode === 'copy' ? 'text-primary' : 'text-muted-foreground'}`} />
                        <div className="text-left">
                          <div className={`text-label ${mode === 'copy' ? 'text-primary' : 'text-foreground'}`}>Copy</div>
                          <div className="text-caption">Originals untouched</div>
                        </div>
                      </button>
                      <button
                        onClick={() => setMode('move')}
                        className={`flex items-center gap-2.5 p-3 rounded-xl border-2 transition-all ${
                          mode === 'move' ? 'border-amber-500 bg-amber-500/5' : 'border-border hover:border-amber-500/30'
                        }`}
                      >
                        <ArrowRightLeft className={`w-4 h-4 ${mode === 'move' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`} />
                        <div className="text-left">
                          <div className={`text-label ${mode === 'move' ? 'text-amber-700 dark:text-amber-300' : 'text-foreground'}`}>Move</div>
                          <div className="text-caption">Verified safe move</div>
                        </div>
                      </button>
                    </div>
                    {mode === 'move' && (
                      <p className="text-caption text-amber-700 dark:text-amber-300 mt-1.5 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        Files are copied, verified by hash, then originals deleted.
                      </p>
                    )}
                  </div>

                  {/* Folder structure */}
                  <div>
                    <label className="text-sm font-medium text-foreground mb-2 block">Folder Structure</label>
                    <div className="space-y-1.5">
                      {([
                        { value: 'year', label: 'Year', example: '2024/' },
                        { value: 'year-month', label: 'Year / Month', example: '2024/03/' },
                        { value: 'year-month-day', label: 'Year / Month / Day', example: '2024/03/15/' },
                      ] as const).map(opt => (
                        <label key={opt.value} className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-secondary/50 cursor-pointer transition-colors">
                          <input
                            type="radio"
                            name="folderStructure"
                            checked={folderStructure === opt.value}
                            onChange={() => setFolderStructure(opt.value)}
                            className="w-4 h-4 accent-primary"
                          />
                          <span className="text-sm flex-1">{opt.label}</span>
                          <code className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">{opt.example}</code>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Options */}
                  <div className="space-y-1">
                    <label className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-secondary/50 cursor-pointer transition-colors">
                      <input
                        type="checkbox"
                        checked={skipDuplicates}
                        onChange={(e) => setSkipDuplicates(e.target.checked)}
                        className="w-4 h-4 rounded accent-primary"
                      />
                      <span className="text-sm">Skip duplicate files</span>
                    </label>
                    {/* v2.0.6 — "Add to PDR's search & views" checkbox
                        REMOVED. Parallel Library is now a pure file-copy
                        operation. Master Library Drive remains the
                        canonical source of truth in S&D / Memories /
                        Trees. The earlier opt-in path silently
                        overwrote master metadata on any pre-existing
                        indexed rows under the destination tree. A
                        deliberate "Re-index this folder" tool lands in
                        v2.0.7; per-library independent PDR instances
                        (where PL copies are first-class searchable in
                        their own scope) land in v2.2. */}
                  </div>

                  {/* Summary */}
                  {undatedCount > 0 && (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      <span>{undatedCount} file{undatedCount !== 1 ? 's have' : ' has'} no date — will be placed in an "Undated" folder.</span>
                    </div>
                  )}
                </div>
              )}

              {/* ── RUNNING PHASE ── */}
              {phase === 'running' && progress && (
                <div className="space-y-4 py-4">
                  <div className="text-center">
                    <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto mb-3" />
                    <p className="text-sm font-medium">
                      {progress.phase === 'copying' && 'Copying files...'}
                      {progress.phase === 'verifying' && 'Verifying integrity...'}
                      {progress.phase === 'deleting' && 'Removing originals...'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {progress.current} of {progress.total} files
                    </p>
                  </div>

                  <div className="w-full h-2 rounded-full bg-secondary overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-300"
                      style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }}
                    />
                  </div>

                  {progress.currentFile && (
                    <p className="text-[11px] text-muted-foreground text-center truncate">
                      {progress.currentFile}
                    </p>
                  )}

                  <div className="flex justify-center">
                    <Button variant="outline" size="sm" onClick={handleCancel} className="text-red-500 hover:text-red-400">
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {/* ── COMPLETE PHASE ── */}
              {phase === 'complete' && result && (
                <div className="space-y-4 py-2">
                  {result.cancelled ? (
                    <div className="text-center py-4">
                      <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-2" />
                      <p className="text-lg font-semibold">Cancelled</p>
                      <p className="text-sm text-muted-foreground">Operation was cancelled before completion.</p>
                    </div>
                  ) : (
                    <div className="text-center py-4">
                      <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto mb-2" />
                      <p className="text-lg font-semibold">
                        {mode === 'move' ? 'Files Moved' : 'Files Copied'}
                      </p>
                      {/* v2.0.6 — indexing-status line REMOVED with
                          the post-copy index path. PL is now a pure
                          file-copy operation. */}
                    </div>
                  )}

                  {/* Stats */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-green-500/10 rounded-xl p-3 text-center">
                      <div className="text-xl font-bold text-green-600 dark:text-green-400">{result.copied}</div>
                      <div className="text-[10px] text-muted-foreground uppercase">{mode === 'move' ? 'Moved' : 'Copied'}</div>
                    </div>
                    <div className="bg-secondary/50 rounded-xl p-3 text-center">
                      <div className="text-xl font-bold text-muted-foreground">{result.skipped}</div>
                      <div className="text-[10px] text-muted-foreground uppercase">Duplicates Removed</div>
                    </div>
                    <div className={`rounded-xl p-3 text-center ${result.failed > 0 ? 'bg-red-500/10' : 'bg-secondary/50'}`}>
                      <div className={`text-xl font-bold ${result.failed > 0 ? 'text-red-500' : 'text-muted-foreground'}`}>{result.failed}</div>
                      <div className="text-[10px] text-muted-foreground uppercase">Failed</div>
                    </div>
                  </div>

                  {mode === 'move' && result.movedAndDeleted !== undefined && result.movedAndDeleted > 0 && (
                    <p className="text-xs text-muted-foreground text-center">
                      {result.movedAndDeleted} original{result.movedAndDeleted !== 1 ? 's' : ''} safely removed after verification.
                    </p>
                  )}

                  {/* Destination path */}
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/30 text-xs text-muted-foreground">
                    <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate flex-1">{destination}</span>
                    <button onClick={handleOpenDestination} className="text-primary hover:text-primary/80 transition-colors shrink-0">
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
              {phase === 'configure' && (() => {
                const ctaDisabled = !destination || files.length === 0 || (diskSpace !== null && totalSize > diskSpace.free);
                // Pulse the Start Copy/Move button once it becomes
                // enabled — i.e., the user has filled in the
                // destination and there's enough disk space. Same
                // "guide the user to the next action" pattern as the
                // Browse pulse that fires while destination is empty.
                // Lavender pulse for Copy (primary), amber pulse for
                // Move (caution) — both keyframes already exist in
                // index.css. Pulse stops the moment the action is
                // clicked (phase flips to running).
                const ctaPulseAnim = !ctaDisabled
                  ? (mode === 'move'
                    ? 'outline-pulse-amber 2s ease-in-out infinite'
                    : 'outline-pulse 2s ease-in-out infinite')
                  : undefined;
                return (
                  <>
                    <Button variant="secondary" onClick={onClose}>Cancel</Button>
                    <Button
                      variant={mode === 'move' ? 'caution' : 'primary'}
                      onClick={handleStart}
                      disabled={ctaDisabled}
                      style={ctaPulseAnim ? { animation: ctaPulseAnim } : undefined}
                    >
                      {mode === 'move' ? (
                        <><ArrowRightLeft className="w-4 h-4 mr-1.5" /> Start Move</>
                      ) : (
                        <><Copy className="w-4 h-4 mr-1.5" /> Start Copy</>
                      )}
                    </Button>
                  </>
                );
              })()}
              {phase === 'complete' && (
                <>
                  <Button variant="information" onClick={handleOpenDestination}>
                    <ExternalLink className="w-4 h-4 mr-1.5" /> Open Destination
                  </Button>
                  <Button variant="primary" onClick={onClose}>Done</Button>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      </AnimatePresence>

      {/* Folder browser sub-modal.
          enableSavedLocations surfaces the user's known Library
          Drives (same data the LDM uses) at the top of the picker —
          so they see "Pick from your existing libraries" front and
          centre without digging through folders. Terry's call
          (2026-05-16): the PL Browse path should reuse the LDM's
          drive-list affordances. Re-routing to the literal LDM modal
          would require LDM to support a pick-only mode (return path
          without attaching) which is a bigger refactor — this gives
          the user the same outcome via the existing picker. */}
      <FolderBrowserModal
        isOpen={showBrowser}
        onCancel={() => setShowBrowser(false)}
        onSelect={(folderPath) => { setDestination(folderPath); setShowBrowser(false); }}
        title="Select Destination for New Structure"
        mode="folder"
        enableSavedLocations
        plannedCollectionSizeGB={totalSizeGB}
        showDriveRatings
        onOpenDriveAdvisor={() => { setShowBrowser(false); setShowDriveAdvisor(true); }}
      />
      <DestinationAdvisorModal
        isOpen={showDriveAdvisor}
        onClose={() => setShowDriveAdvisor(false)}
        onContinue={() => {
          setShowDriveAdvisor(false);
          // Continue → open the LDM in pick-mode (same channel as
          // the Browse button) instead of the legacy FolderBrowserModal.
          // Keeps a single drive-picking surface across PL flows.
          window.dispatchEvent(new CustomEvent('pdr:openLibraryPanelForPick', {
            detail: { caller: 'parallel-library' },
          }));
        }}
        currentSourceSizeGB={totalSizeGB}
        plannedCollectionSizeGB={totalSizeGB}
      />
    </>
  );
}
