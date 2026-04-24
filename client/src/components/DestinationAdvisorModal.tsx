import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, HardDrive, Shield, AlertTriangle, CheckCircle2,
  Zap, Wifi, Usb, Server, Cloud, ChevronRight, Lock,
  Info, ExternalLink, ArrowUpDown, SortAsc, Crown,
  MonitorSmartphone, ChevronDown, ChevronUp, Lightbulb,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { listDrives, type DriveInfo } from '@/lib/electron-bridge';

interface DestinationAdvisorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onContinue: () => void; // User wants to proceed to folder browser
  currentSourceSizeGB: number;
  plannedCollectionSizeGB?: number | null; // From Library Planner — total collection estimate
}

interface ScoredDrive extends DriveInfo {
  score: number;
  speedTier: 'fast' | 'medium' | 'slow';
  speedLabel: string;
  connectionType: string;
  recommended: boolean;
  warnings: string[];
  isSystemDrive: boolean;
}

function scoreDrive(drive: DriveInfo): ScoredDrive {
  let score = 0;
  let speedTier: 'fast' | 'medium' | 'slow' = 'medium';
  let speedLabel = 'Standard';
  let connectionType = 'Local';
  const warnings: string[] = [];
  const freeGB = drive.freeBytes / (1024 * 1024 * 1024);
  const totalGB = drive.totalBytes / (1024 * 1024 * 1024);

  // Detect system drive (C:)
  const isSystemDrive = drive.letter.toUpperCase().startsWith('C');

  // Drive type scoring
  if (drive.type === 'Local Disk') {
    score += 40;
    connectionType = 'Internal (SATA/NVMe)';
    speedTier = 'fast';
    speedLabel = 'Fast — direct motherboard connection';
  } else if (drive.type === 'Removable') {
    score += 20;
    connectionType = 'USB / External';
    speedTier = 'medium';
    speedLabel = 'Medium — depends on USB version';
    warnings.push('External drives can disconnect during long operations');
  } else if (drive.type === 'Network') {
    score += 5;
    connectionType = 'Network / NAS';
    speedTier = 'slow';
    speedLabel = 'Slow — not recommended as a destination';
    warnings.push('Network drives are too slow for use as a destination — large jobs can take hours or days, and risk interruption from power loss, sleep mode, or connection drops');
    warnings.push('Tip: Use a fast local drive as your destination, then back up to your NAS or cloud storage afterwards');
  } else if (drive.type === 'CD/DVD') {
    score = 0;
    speedTier = 'slow';
    speedLabel = 'Not suitable';
    connectionType = 'Optical';
    warnings.push('Optical drives are read-only or very slow for writing');
  }

  // System drive — always penalised heavily, always red
  if (isSystemDrive) {
    score = Math.max(0, score - 50);
    warnings.push('This is your Windows system drive. A growing photo library will consume space that Windows needs for updates, virtual memory, and normal operation — this can cause crashes, boot failures, and data loss.');
    warnings.push('Even for testing, files stored here can easily be forgotten and accumulate over time.');
  }

  // Space scoring (more space = better for long-term library)
  if (totalGB >= 2000) score += 30; // 2TB+
  else if (totalGB >= 1000) score += 25; // 1TB+
  else if (totalGB >= 500) score += 20;
  else if (totalGB >= 100) score += 10;
  else score += 2;

  // Free space scoring
  if (freeGB >= 500) score += 20;
  else if (freeGB >= 100) score += 15;
  else if (freeGB >= 50) score += 10;
  else if (freeGB >= 10) score += 5;
  else {
    score += 0;
    warnings.push('Very low free space — not suitable for a growing library');
  }

  // Small drives penalty
  if (totalGB < 16) {
    warnings.push('This drive is too small for a permanent photo library');
    score = Math.max(0, score - 20);
  }

  return {
    ...drive,
    score,
    speedTier,
    speedLabel,
    connectionType,
    recommended: false, // Set after sorting
    warnings,
    isSystemDrive,
  };
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1000) return `${(gb / 1024).toFixed(1)} TB`;
  return `${gb.toFixed(1)} GB`;
}

function getEstimatedCopyTime(sizeGB: number, speedTier: 'fast' | 'medium' | 'slow'): string {
  // Rough estimates: fast=200MB/s, medium=80MB/s, slow=30MB/s
  const speeds = { fast: 200, medium: 80, slow: 30 };
  const sizeMB = sizeGB * 1024;
  const seconds = sizeMB / speeds[speedTier];
  if (seconds < 60) return 'under a minute';
  if (seconds < 3600) return `~${Math.ceil(seconds / 60)} minutes`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.ceil((seconds % 3600) / 60);
  return `~${hours}h ${mins}m`;
}

function fmtGB(gb: number): string {
  return gb >= 1000 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(0)} GB`;
}

// Collection size presets for the DDA question (midpoint values matching LibraryPlannerModal)
const COLLECTION_SIZE_PRESETS = [
  { label: 'Under 50 GB', value: 50 },
  { label: '50–200 GB', value: 125 },
  { label: '200–500 GB', value: 350 },
  { label: '500 GB – 1 TB', value: 750 },
  { label: '1–5 TB', value: 2048 },
  { label: '5 TB+', value: 5120 },
] as const;

function generateQuickSummary(drives: ScoredDrive[], currentFixGB: number, totalCollectionGB: number | null): string[] {
  if (drives.length === 0) return ['No drives detected.'];
  const lines: string[] = [];

  // The space target: use the user's stated collection size if provided,
  // otherwise we only know about this single fix and say so honestly.
  const knownTotal = totalCollectionGB !== null;
  const targetGB = knownTotal ? totalCollectionGB : currentFixGB;

  const ranked = [...drives].sort((a, b) => b.score - a.score);
  const usable = ranked.filter(d => d.type !== 'CD/DVD' && (d.totalBytes / (1024 * 1024 * 1024)) >= 16);

  // Categorise drives
  const bestCandidates = usable.filter(d => !d.isSystemDrive && d.type !== 'Network');
  const systemDrive = usable.find(d => d.isSystemDrive);
  const networkDrives = usable.filter(d => d.type === 'Network');

  // Check: can any drive fit even the current fix?
  const withCurrentSpace = usable.filter(d => (d.freeBytes / (1024 * 1024 * 1024)) >= currentFixGB);
  if (withCurrentSpace.length === 0) {
    lines.push(`None of your drives have ${fmtGB(currentFixGB)} free for this fix. You'll need to free up space or add a new drive.`);
    return lines;
  }

  // When we know the total collection size, check who can actually hold it
  if (knownTotal) {
    const canHoldAll = bestCandidates.filter(d => (d.freeBytes / (1024 * 1024 * 1024)) >= targetGB);
    const canHoldFix = bestCandidates.filter(d => {
      const freeGB = d.freeBytes / (1024 * 1024 * 1024);
      return freeGB >= currentFixGB && freeGB < targetGB;
    });

    if (canHoldAll.length === 0) {
      // Nothing can hold the full collection
      if (canHoldFix.length > 0) {
        const best = canHoldFix[0];
        const freeGB = best.freeBytes / (1024 * 1024 * 1024);
        lines.push(`Your collection is ${fmtGB(targetGB)}, but ${best.letter} only has ${fmtGB(freeGB)} free. It can handle this fix, but not your full library.`);
        lines.push(`You'll either need to free up space, split your collection across multiple runs to different destinations, or add a larger drive.`);
      } else {
        lines.push(`Your collection is ${fmtGB(targetGB)}, but none of your drives have enough free space. You'll need to free up space, add a larger drive, or split your collection across separate destinations.`);
      }
    } else if (canHoldAll.length >= 2) {
      const top2 = canHoldAll.slice(0, 2);
      lines.push(`${top2[0].letter} and ${top2[1].letter} can both hold your ${fmtGB(targetGB)} collection — these are your strongest candidates.`);
    } else {
      const best = canHoldAll[0];
      const freeGB = best.freeBytes / (1024 * 1024 * 1024);
      lines.push(`${best.letter} is your best option — ${fmtGB(freeGB)} free, enough for your ${fmtGB(targetGB)} collection.`);
    }

    // Speed vs space trade-off when we know the total
    if (canHoldAll.length > 0 && canHoldFix.length > 0) {
      const fastest = canHoldFix.find(d => d.speedTier === 'fast');
      if (fastest && canHoldAll[0].letter !== fastest.letter) {
        const fastFree = fastest.freeBytes / (1024 * 1024 * 1024);
        const roomyFree = canHoldAll[0].freeBytes / (1024 * 1024 * 1024);
        lines.push(`${fastest.letter} is faster but can't hold your full collection (${fmtGB(fastFree)} free). ${canHoldAll[0].letter} has the space you need (${fmtGB(roomyFree)} free) — capacity matters more than speed for a permanent library.`);
      }
    }
  } else {
    // No collection size provided — be honest about what we know
    const withFixSpace = bestCandidates.filter(d => (d.freeBytes / (1024 * 1024 * 1024)) >= currentFixGB);
    if (withFixSpace.length >= 2) {
      const top2 = withFixSpace.slice(0, 2);
      const free1 = top2[0].freeBytes / (1024 * 1024 * 1024);
      const free2 = top2[1].freeBytes / (1024 * 1024 * 1024);
      lines.push(`Based on this fix alone, ${top2[0].letter} (${fmtGB(free1)} free) and ${top2[1].letter} (${fmtGB(free2)} free) are your best options.`);
    } else if (withFixSpace.length === 1) {
      const best = withFixSpace[0];
      const freeGB = best.freeBytes / (1024 * 1024 * 1024);
      lines.push(`${best.letter} is currently your best option with ${fmtGB(freeGB)} free.`);
    }
    lines.push(`We can only see this fix (${fmtGB(currentFixGB)}). If you have more photos to process in future, tell us your total collection size above for a more accurate recommendation.`);
  }

  // System drive — don't mention available space, just shut it down
  if (systemDrive) {
    const hasAlternatives = bestCandidates.filter(d => (d.freeBytes / (1024 * 1024 * 1024)) >= currentFixGB).length > 0;
    if (hasAlternatives) {
      lines.push(`Your system drive (${systemDrive.letter}) should not be used for a photo library — use one of your other drives instead.`);
    } else {
      lines.push(`Your system drive (${systemDrive.letter}) should not be used for a photo library. It can be used for testing, but even that is risky. Consider adding an external drive.`);
    }
  }

  // Network drives
  if (networkDrives.length > 0) {
    lines.push(`${networkDrives.map(d => d.letter).join(', ')} ${networkDrives.length === 1 ? 'is a' : 'are'} network drive${networkDrives.length > 1 ? 's' : ''} — too slow and unreliable for processing. Use a local drive as your destination, then back up to network storage afterwards.`);
  }

  // When collection size is known and nothing local can hold it, add a clear preamble
  if (knownTotal) {
    const canHoldAll = bestCandidates.filter(d => (d.freeBytes / (1024 * 1024 * 1024)) >= targetGB);
    if (canHoldAll.length === 0) {
      lines.push(`Based on your library plan, none of your current drives have enough space for your estimated collection. Visit our guides for drive recommendations: photodaterescue.com/guides/tools-recommendations`);
    }
  }

  // No good options at all
  if (bestCandidates.filter(d => (d.freeBytes / (1024 * 1024 * 1024)) >= currentFixGB).length === 0 && !systemDrive) {
    lines.push('Your current options are limited. Consider adding an NVMe or SATA SSD (internal), or a USB-C/Thunderbolt external SSD for your photo library.');
  }

  return lines;
}

export default function DestinationAdvisorModal({ isOpen, onClose, onContinue, currentSourceSizeGB, plannedCollectionSizeGB }: DestinationAdvisorModalProps) {
  const [drives, setDrives] = useState<ScoredDrive[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortMode, setSortMode] = useState<'ranked' | 'alpha'>('ranked');
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  // Auto-open summary if planner data is available
  const [summaryOpen, setSummaryOpen] = useState(!!plannedCollectionSizeGB);
  // Use planner answer if available, otherwise let user set it in the DDA
  const [collectionSizeGB, setCollectionSizeGB] = useState<number | null>(plannedCollectionSizeGB ?? null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    listDrives().then(driveList => {
      const scored = driveList
        .filter(d => d.totalBytes > 0) // Exclude empty/unformatted
        .map(scoreDrive)
        .sort((a, b) => b.score - a.score);
      // Mark the top one as recommended (but never the system drive)
      const topCandidate = scored.find(d => !d.isSystemDrive);
      if (topCandidate) topCandidate.recommended = true;
      setDrives(scored);
      setLoading(false);
    });
  }, [isOpen]);

  if (!isOpen) return null;

  const sortedDrives = sortMode === 'alpha'
    ? [...drives].sort((a, b) => a.letter.localeCompare(b.letter))
    : [...drives].sort((a, b) => b.score - a.score);

  const speedTierColors = {
    fast: 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/30',
    medium: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30',
    slow: 'text-red-500 dark:text-red-400 bg-red-50 dark:bg-red-900/30',
  };

  const speedTierIcons = {
    fast: <Zap className="w-3.5 h-3.5" />,
    medium: <HardDrive className="w-3.5 h-3.5" />,
    slow: <Wifi className="w-3.5 h-3.5" />,
  };

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <motion.div
          className="bg-background rounded-2xl shadow-2xl border border-border w-[640px] max-h-[85vh] overflow-hidden flex flex-col"
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <Shield className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">Destination Advisor</h2>
                <p className="text-xs text-muted-foreground">Plan your permanent library location</p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

            {/* Key message — best practice, universal */}
            <div className="p-4 rounded-xl bg-primary/5 border border-primary/20">
              <div className="flex items-start gap-3">
                <Shield className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-foreground mb-1">Best practice: choose one destination for your library</p>
                  <p className="text-[13px] text-muted-foreground leading-relaxed">
                    You can change your destination each time you run a fix, but for the best experience
                    we recommend keeping all your fixes in one location.
                  </p>
                </div>
              </div>
            </div>

            {/* Pro features callout */}
            <div className="p-3 rounded-xl bg-purple-500/5 border border-purple-500/20">
              <div className="flex items-start gap-3">
                <Crown className="w-4 h-4 text-purple-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-semibold text-purple-600 dark:text-purple-400 mb-0.5">PDR Pro</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Your search index, AI analysis, and reports are all tied to the destination.
                    Moving or renaming it means rebuilding that data. Keeping one permanent location protects your investment.
                  </p>
                </div>
              </div>
            </div>

            {/* Guidance accordion */}
            <div className="rounded-xl border border-border overflow-hidden">
              <button
                onClick={() => setGuidanceOpen(!guidanceOpen)}
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-secondary/30 transition-colors"
              >
                <span className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                  <Info className="w-4 h-4 text-primary" />
                  Help choosing the best drive for you
                </span>
                {guidanceOpen
                  ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
                  : <ChevronDown className="w-4 h-4 text-muted-foreground" />
                }
              </button>

              {guidanceOpen && (
                <div className="px-4 pb-4 space-y-2 border-t border-border pt-3">
                  <div className="flex items-start gap-2.5 p-3 rounded-lg bg-secondary/30">
                    <Zap className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[13px] font-medium">A large internal drive (SATA/NVMe)</p>
                      <p className="text-xs text-muted-foreground leading-relaxed">Directly connected to your motherboard for maximum speed. SSDs are ideal, HDDs are good.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2.5 p-3 rounded-lg bg-secondary/30">
                    <HardDrive className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[13px] font-medium">Plenty of space for growth</p>
                      <p className="text-xs text-muted-foreground leading-relaxed">Your current source is {currentSourceSizeGB.toFixed(1)} GB. Plan for your entire collection —
                        a typical library grows significantly as you add more sources over time.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2.5 p-3 rounded-lg bg-secondary/30">
                    <Lock className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[13px] font-medium">A permanent, stable location</p>
                      <p className="text-xs text-muted-foreground leading-relaxed">For best results, keep all your fixes in the same destination. This is your master library.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-500/5 border border-amber-500/15">
                    <Wifi className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[13px] font-medium">Avoid network drives as your destination</p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        NAS, personal cloud, and network drives are too slow for processing — large jobs can take hours or
                        even days, and risk failure from power loss, sleep mode, or connection drops. Use a fast local drive
                        as your destination first, then back up to your NAS or cloud storage afterwards at your leisure.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Collection size question + Quick Summary */}
            {!loading && drives.length > 0 && (
              <div className="rounded-xl border border-border overflow-hidden">
                <button
                  onClick={() => setSummaryOpen(!summaryOpen)}
                  className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-secondary/30 transition-colors"
                >
                  <span className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                    <Lightbulb className="w-4 h-4 text-amber-500" />
                    Quick Summary
                  </span>
                  {summaryOpen
                    ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
                    : <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  }
                </button>
                {summaryOpen && (
                  <div className="px-4 pb-4 border-t border-border pt-3 space-y-3">
                    {/* Collection size — compact if from planner, full question if not */}
                    <div className="p-3 rounded-lg bg-secondary/30">
                      {collectionSizeGB !== null && plannedCollectionSizeGB ? (
                        <>
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-medium text-foreground">
                              Your estimated collection: <span className="text-primary font-semibold">{fmtGB(collectionSizeGB)}</span>
                            </p>
                            <button
                              onClick={() => setCollectionSizeGB(null)}
                              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                            >
                              Change
                            </button>
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-1">From your Library Planner answers. Your storage device should ideally keep at least 10% free space to avoid performance issues.</p>
                        </>
                      ) : (
                        <>
                          <p className="text-xs font-medium text-foreground mb-2">
                            How large is your entire photo & video collection?
                          </p>
                          <p className="text-[11px] text-muted-foreground mb-2.5">
                            This helps us recommend a drive that can hold your full library — not just this fix.
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {COLLECTION_SIZE_PRESETS.map(preset => (
                              <button
                                key={preset.value}
                                onClick={() => setCollectionSizeGB(collectionSizeGB === preset.value ? null : preset.value)}
                                className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                                  collectionSizeGB === preset.value
                                    ? 'bg-primary text-white border-primary font-medium'
                                    : 'bg-background border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                                }`}
                              >
                                {preset.label}
                              </button>
                            ))}
                            {collectionSizeGB !== null && (
                              <button
                                onClick={() => setCollectionSizeGB(null)}
                                className="text-[11px] px-2 py-1 text-muted-foreground/60 hover:text-foreground transition-colors"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </div>

                    {/* Summary lines */}
                    {generateQuickSummary(drives, currentSourceSizeGB, collectionSizeGB).map((line, i) => (
                      <p key={i} className="text-[13px] text-muted-foreground leading-relaxed flex items-start gap-2">
                        <span className="text-primary mt-0.5 shrink-0">•</span>
                        <span>{line}</span>
                      </p>
                    ))}
                    <p className="text-[10px] text-muted-foreground/50 mt-1 italic">
                      Based on available space and drive type only.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Drive rankings */}
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <h3 className="text-[13px] font-semibold text-foreground">
                  Your drives
                  {!loading && <span className="text-xs font-normal text-muted-foreground ml-1.5">({sortedDrives.length} found)</span>}
                </h3>
                <div className="flex items-center gap-1">
                  {loading && <span className="text-xs text-muted-foreground mr-2">Scanning...</span>}
                  {!loading && (
                    <IconTooltip label={sortMode === 'ranked' ? 'Sort alphabetically' : 'Sort by best ranked'} side="bottom">
                      <button
                        onClick={() => setSortMode(prev => prev === 'ranked' ? 'alpha' : 'ranked')}
                        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-lg hover:bg-secondary/50 transition-colors"
                      >
                        <ArrowUpDown className="w-3.5 h-3.5" />
                        {sortMode === 'ranked' ? 'Best ranked' : 'A–Z'}
                      </button>
                    </IconTooltip>
                  )}
                </div>
              </div>

              {!loading && sortedDrives.length > 0 && (
                <div className="space-y-2">
                  {sortedDrives.map((drive) => {
                    const freeGB = drive.freeBytes / (1024 * 1024 * 1024);
                    const totalGB = drive.totalBytes / (1024 * 1024 * 1024);
                    const usedPercent = totalGB > 0 ? Math.round(((totalGB - freeGB) / totalGB) * 100) : 0;

                    return (
                      <div
                        key={drive.letter}
                        className={`p-3 rounded-xl border-2 transition-all ${
                          drive.recommended ? 'border-green-500/50 bg-green-50/50 dark:bg-green-900/10' :
                          drive.isSystemDrive ? 'border-red-400/50 bg-red-50/40 dark:bg-red-900/10' :
                          'border-border'
                        }`}
                      >
                        {/* Top row: letter, name, recommended badge, space, speed */}
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-sm font-bold text-foreground shrink-0">{drive.letter}</span>
                            {drive.label && <span className="text-sm text-foreground truncate">{drive.label}</span>}
                            {drive.recommended && (
                              <span className="text-[10px] font-semibold text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/40 px-2 py-0.5 rounded-full flex items-center gap-1 shrink-0">
                                <CheckCircle2 className="w-3 h-3" /> Recommended
                              </span>
                            )}
                            {drive.isSystemDrive && (
                              <span className="text-[10px] font-semibold text-red-500 bg-red-100 dark:bg-red-900/40 px-2 py-0.5 rounded-full flex items-center gap-1 shrink-0">
                                <MonitorSmartphone className="w-3 h-3" /> System drive
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2.5 shrink-0 ml-3">
                            <span className="text-xs text-muted-foreground whitespace-nowrap">
                              {formatBytes(drive.freeBytes)} free / {formatBytes(drive.totalBytes)}
                            </span>
                            <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full flex items-center gap-1 shrink-0 ${speedTierColors[drive.speedTier]}`}>
                              {speedTierIcons[drive.speedTier]}
                              {drive.speedTier === 'fast' ? 'Fast' : drive.speedTier === 'medium' ? 'Medium' : 'Slow'}
                            </span>
                          </div>
                        </div>

                        {/* Connection type */}
                        <div className="text-xs text-muted-foreground mb-1.5">
                          {drive.connectionType} · {drive.speedLabel}
                        </div>

                        {/* Space bar */}
                        <div className="w-full h-2 rounded-full bg-secondary overflow-hidden mb-1">
                          <div
                            className={`h-full rounded-full transition-all ${
                              usedPercent > 90 ? 'bg-red-500' : usedPercent > 70 ? 'bg-amber-500' : 'bg-primary'
                            }`}
                            style={{ width: `${usedPercent}%` }}
                          />
                        </div>

                        {/* Estimated copy time */}
                        {currentSourceSizeGB > 0 && (
                          <div className="text-xs text-muted-foreground mt-1">
                            Est. processing time for {currentSourceSizeGB.toFixed(1)} GB: <span className="font-medium text-foreground">{getEstimatedCopyTime(currentSourceSizeGB, drive.speedTier)}</span>
                          </div>
                        )}

                        {/* Warnings */}
                        {drive.warnings.length > 0 && (
                          <div className="mt-1.5 space-y-0.5">
                            {drive.warnings.map((w, i) => (
                              <p key={i} className={`text-xs flex items-start gap-1 ${
                                drive.isSystemDrive
                                  ? 'text-red-600 dark:text-red-400'
                                  : 'text-amber-600 dark:text-amber-400'
                              }`}>
                                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" /> {w}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* No drives large enough for collection — shown when user has stated a collection size and nothing fits */}
            {!loading && collectionSizeGB && collectionSizeGB > 0 && (() => {
              const nonSystemWithSpace = sortedDrives.filter(d =>
                !d.isSystemDrive && d.type !== 'CD/DVD' && d.type !== 'Network' &&
                (d.freeBytes / (1024 * 1024 * 1024)) >= collectionSizeGB
              );
              if (nonSystemWithSpace.length > 0) return null;
              return (
                <div className="p-4 rounded-xl bg-amber-500/10 border-2 border-amber-500/40">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-foreground mb-1">No connected drives are suitable for your library</p>
                      <p className="text-xs text-muted-foreground leading-relaxed mb-2">
                        Your estimated collection is {fmtGB(collectionSizeGB)}, but none of your current drives have enough free space. We recommend purchasing a dedicated drive for your photo library:
                      </p>
                      <div className="space-y-1.5 text-xs text-muted-foreground">
                        <div className="flex items-start gap-2">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                          <span><strong className="text-foreground">Best:</strong> NVMe M.2 SSD (internal) or Thunderbolt/USB-C external SSD — fastest read and write speeds.</span>
                        </div>
                        <div className="flex items-start gap-2">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                          <span><strong className="text-foreground">Good:</strong> SATA SSD (internal) or USB 3.1/3.2 external SSD — excellent performance at a lower price point.</span>
                        </div>
                        <div className="flex items-start gap-2">
                          <Info className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                          <span><strong className="text-foreground">Budget:</strong> USB 3.0 external HDD — slower but affordable for larger capacities. Avoid USB 2.0 and flash drives.</span>
                        </div>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-2">
                        Choose a drive at least <strong className="text-foreground">{fmtGB(Math.ceil(collectionSizeGB * 1.2))}</strong> to allow room for growth.
                        {' '}<button
                          onClick={() => window.open('https://www.photodaterescue.com/guides/tools-recommendations', '_blank')}
                          className="text-primary hover:text-primary/80 underline underline-offset-2 transition-colors"
                        >
                          See our drive guide
                        </button>
                      </p>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* C: drive alternatives — shown when system drive is the only option with enough space */}
            {!loading && (() => {
              const nonSystemWithSpace = sortedDrives.filter(d =>
                !d.isSystemDrive && d.type !== 'CD/DVD' &&
                (d.freeBytes / (1024 * 1024 * 1024)) >= Math.max(currentSourceSizeGB, 10) &&
                (d.totalBytes / (1024 * 1024 * 1024)) >= 16
              );
              const systemDrive = sortedDrives.find(d => d.isSystemDrive);
              if (!systemDrive || nonSystemWithSpace.length > 0) return null;
              return (
                <div className="p-4 rounded-xl bg-red-500/5 border border-red-500/20">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-red-600 dark:text-red-400 mb-1.5">Your system drive is your only option</p>
                      <p className="text-xs text-muted-foreground leading-relaxed mb-3">
                        Using {systemDrive.letter} for a growing photo library risks filling your OS disk, which can cause Windows crashes, failed updates, and data loss. Here are some practical alternatives:
                      </p>
                      <div className="space-y-2">
                        <div className="flex items-start gap-2 text-xs text-muted-foreground">
                          <span className="text-primary font-bold mt-px">1.</span>
                          <span><strong className="text-foreground">Add a second internal drive</strong> — An NVMe M.2 SSD is the fastest option (1,000–5,000 MB/s). SATA SSDs (400–550 MB/s) are excellent too. Many desktops and some laptops have a spare M.2 slot or drive bay.</span>
                        </div>
                        <div className="flex items-start gap-2 text-xs text-muted-foreground">
                          <span className="text-primary font-bold mt-px">2.</span>
                          <span><strong className="text-foreground">External SSD with a fast connection</strong> — A USB-C, USB 3.1/3.2, or Thunderbolt external SSD gives near-internal speeds and portability. Avoid USB 2.0 or basic USB 3.0 HDDs where possible.</span>
                        </div>
                        <div className="flex items-start gap-2 text-xs text-muted-foreground">
                          <span className="text-primary font-bold mt-px">3.</span>
                          <span><strong className="text-foreground">Process on a fast drive, back up to NAS</strong> — If you have a NAS or cloud storage, use a fast local or external drive as your destination first, then back up to your NAS afterwards. Network drives are too slow and unreliable for direct processing.</span>
                        </div>
                      </div>
                      <p className="text-[10px] text-muted-foreground/60 mt-3 italic">
                        You can still select {systemDrive.letter} if you choose, but we strongly recommend an alternative for long-term use.
                      </p>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Typical drive speeds reference */}
            <div className="p-3 rounded-xl bg-secondary/30 border border-border">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Drive types ranked by speed</h4>
              <div className="space-y-0.5 text-xs">
                <div className="flex justify-between items-center"><span className="text-muted-foreground flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />NVMe M.2 SSD (internal)</span><span className="text-emerald-700 dark:text-emerald-300 font-medium">1,000–5,000 MB/s</span></div>
                <div className="flex justify-between items-center"><span className="text-muted-foreground flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />Thunderbolt external SSD</span><span className="text-emerald-700 dark:text-emerald-300 font-medium">700–2,800 MB/s</span></div>
                <div className="flex justify-between items-center"><span className="text-muted-foreground flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />SATA SSD (internal)</span><span className="text-emerald-700 dark:text-emerald-300 font-medium">400–550 MB/s</span></div>
                <div className="flex justify-between items-center"><span className="text-muted-foreground flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />USB 3.1/3.2 external SSD</span><span className="text-emerald-700 dark:text-emerald-300 font-medium">300–1,000 MB/s</span></div>
                <div className="flex justify-between items-center"><span className="text-muted-foreground flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />Internal HDD (SATA)</span><span className="text-foreground font-medium">80–160 MB/s</span></div>
                <div className="flex justify-between items-center"><span className="text-muted-foreground flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />USB 3.0 external HDD</span><span className="text-amber-600 dark:text-amber-400 font-medium">50–120 MB/s</span></div>
                <div className="flex justify-between items-center"><span className="text-muted-foreground flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />USB 2.0 (any drive)</span><span className="text-red-600 dark:text-red-400 font-medium">20–35 MB/s</span></div>
                <div className="flex justify-between items-center"><span className="text-muted-foreground flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />USB flash / memory stick</span><span className="text-red-600 dark:text-red-400 font-medium">5–30 MB/s</span></div>
                <div className="flex justify-between items-center"><span className="text-muted-foreground flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />Network / NAS (Wi-Fi)</span><span className="text-red-600 dark:text-red-400 font-medium">10–100 MB/s</span></div>
                <div className="flex justify-between items-center"><span className="text-muted-foreground flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />Cloud sync</span><span className="text-red-600 dark:text-red-400 font-medium">1–20 MB/s</span></div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-border flex items-center justify-between">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                defaultChecked={localStorage.getItem('pdr-skip-dest-advisor') === 'true'}
                onChange={(e) => {
                  if (e.target.checked) {
                    localStorage.setItem('pdr-skip-dest-advisor', 'true');
                  } else {
                    localStorage.removeItem('pdr-skip-dest-advisor');
                  }
                }}
                className="w-4 h-4 rounded accent-primary"
              />
              <span className="text-xs text-muted-foreground">Don't show automatically</span>
            </label>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={onContinue}>
                <ChevronRight className="w-4 h-4 mr-1" /> Choose Destination
              </Button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
