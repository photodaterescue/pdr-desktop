import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, Loader2, X, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/custom-button';
import { Progress } from '@/components/ui/progress';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { 
  runPreScan, 
  cancelPreScan, 
  onPreScanProgress, 
  removePreScanProgressListener,
  PreScanProgress,
  PreScanResult
} from '@/lib/electron-bridge';

interface NetworkScanModalProps {
  sourcePath: string;
  sourceType: 'folder' | 'zip';
  storageLabel: string;
  sourceName: string;
  onComplete: (result: PreScanResult) => void;
  onCancel: () => void;
  onProceedWithoutSize: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getSizeWarningMessage(totalBytes: number, fileCount: number, scanSpeed?: number): { 
  message: string; 
  severity: 'low' | 'medium' | 'high';
  estimatedMinutes?: number;
} {
  const sizeGB = totalBytes / (1024 * 1024 * 1024);
  
  // Estimate analysis time based on measured scan speed
  // Analysis is typically 3-5x slower than enumeration due to metadata parsing
  const analysisMultiplier = 8;
  let estimatedMinutes: number | undefined;
  
  if (scanSpeed && scanSpeed > 0 && fileCount > 0) {
    const analysisSpeed = scanSpeed / analysisMultiplier;
    const estimatedSeconds = fileCount / analysisSpeed;
    estimatedMinutes = Math.ceil(estimatedSeconds / 60);
  }
  
  if (sizeGB < 5) {
    return { 
      message: 'This should process without major issues.', 
      severity: 'low',
      estimatedMinutes
    };
  } else if (sizeGB < 25) {
    return { 
      message: 'Processing may take a while. Consider copying to a local drive for faster results.', 
      severity: 'medium',
      estimatedMinutes
    };
  } else if (sizeGB < 75) {
    return { 
      message: 'This is a large source. We recommend copying files to a local drive or processing in smaller batches.', 
      severity: 'high',
      estimatedMinutes
    };
  } else {
    return { 
      message: 'This is very large for network storage. We strongly recommend copying locally or processing in batches of 25 GB or less.', 
      severity: 'high',
      estimatedMinutes
    };
  }
}

export function NetworkScanModal({ 
  sourcePath, 
  sourceType, 
  storageLabel,
  sourceName,
  onComplete, 
  onCancel,
  onProceedWithoutSize
}: NetworkScanModalProps) {
  const [phase, setPhase] = useState<'scanning' | 'timeout' | 'complete'>('scanning');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [progress, setProgress] = useState<PreScanProgress>({
    fileCount: 0,
    photoCount: 0,
    videoCount: 0,
    totalBytes: 0,
    timedOut: false,
    elapsed: 0
  });
  const [finalResult, setFinalResult] = useState<PreScanResult | null>(null);
  const [isKeepScanning, setIsKeepScanning] = useState(false);
  
  useEffect(() => {
    onPreScanProgress((p) => {
      setProgress(p);
      if (p.timedOut && phase === 'scanning') {
        setPhase('timeout');
      }
    });

    const doScan = async () => {
      const result = await runPreScan(sourcePath, sourceType);
      removePreScanProgressListener();
      
      if (result.cancelled) {
        return;
      }
      
      if (result.timedOut) {
        setPhase('timeout');
      } else if (result.success) {
        setFinalResult(result);
        setPhase('complete');
        const soundEnabled = localStorage.getItem('pdr-completion-sound') !== 'false';
        if (soundEnabled) {
          const { playCompletionSound, flashTaskbar } = await import('@/lib/electron-bridge');
          await playCompletionSound();
          await flashTaskbar();
        }
      }
    };

    doScan();

    return () => {
      removePreScanProgressListener();
    };
  }, [sourcePath, sourceType]);

  const handleCancel = async () => {
    setShowCancelConfirm(true);
  };

  const handleConfirmCancel = async () => {
    setShowCancelConfirm(false);
    await cancelPreScan();
    removePreScanProgressListener();
    onCancel();
  };

  const handleDismissCancel = () => {
    setShowCancelConfirm(false);
  };
  
  // Auto-dismiss cancel confirmation if scan completes in background
  useEffect(() => {
    if (showCancelConfirm && phase === 'complete') {
      setShowCancelConfirm(false);
    }
  }, [phase, showCancelConfirm]);

  const handleKeepScanning = async () => {
    setPhase('scanning');
    setIsKeepScanning(true);
    
    // Re-attach progress listener for the new scan
    onPreScanProgress((data) => {
      setProgress({
        fileCount: data.fileCount,
        photoCount: data.photoCount,
        videoCount: data.videoCount,
        totalBytes: data.totalBytes,
        timedOut: data.timedOut,
        elapsed: data.elapsed
      });
    });
    
    const result = await runPreScan(sourcePath, sourceType, true);
    removePreScanProgressListener();
    
    if (result.cancelled) {
      return;
    }
    
    if (result.success) {
      setFinalResult(result);
      setPhase('complete');
      const soundEnabled = localStorage.getItem('pdr-completion-sound') !== 'false';
      if (soundEnabled) {
        const { playCompletionSound, flashTaskbar } = await import('@/lib/electron-bridge');
        await playCompletionSound();
        await flashTaskbar();
      }
    } else if (result.timedOut) {
      setPhase('timeout');
    }
  };

  const handleProceedWithEstimate = () => {
    if (progress.fileCount > 0) {
      onComplete({
        success: true,
        timedOut: true,
        data: {
          fileCount: progress.fileCount,
          photoCount: progress.photoCount,
          videoCount: progress.videoCount,
          totalBytes: progress.totalBytes
        }
      });
    } else {
      onProceedWithoutSize();
    }
  };

  const handleContinueAnyway = () => {
    if (finalResult) {
      onComplete(finalResult);
    }
  };

  const warningInfo = getSizeWarningMessage(
    finalResult?.data?.totalBytes || progress.totalBytes, 
    finalResult?.data?.fileCount || progress.fileCount,
    (finalResult?.data as any)?.scanSpeed
  );

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
    >
      <motion.div 
        initial={{ scale: 0.95, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        className="bg-background rounded-2xl shadow-2xl max-w-md w-full p-6 border border-border"
      >
        {phase === 'scanning' && (
          <>
            <div className="flex flex-col items-center text-center mb-6">
              <div className="w-14 h-14 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                {showCancelConfirm ? (
                  <img src="./assets/pdr-logo_transparent.png" className="w-9 h-9 object-contain" alt="PDR" />
                ) : (
                  <Loader2 className="w-7 h-7 text-primary animate-spin" />
                )}
              </div>
              <h2 className="text-xl font-semibold text-foreground mb-2">
                {showCancelConfirm ? 'Cancel Scan?' : `${storageLabel} Detected`}
              </h2>
              <p className="text-sm text-muted-foreground">
                {showCancelConfirm 
                  ? 'Scan is still running in the background' 
                  : (isKeepScanning ? 'Extended scan in progress...' : 'Scanning to estimate folder size...')}
              </p>
              {!showCancelConfirm && (
                <IconTooltip label={sourceName} side="top">
                  <p className="text-xs text-muted-foreground mt-2 truncate max-w-full">
                    {sourceName}
                  </p>
                </IconTooltip>
              )}
            </div>

            <div className="mb-4">
              <div className="flex justify-between text-sm text-muted-foreground mb-2">
                <span>{progress.fileCount.toLocaleString()} files found</span>
                <span>{formatBytes(progress.totalBytes)}</span>
              </div>
              <div className="w-full h-2 bg-secondary rounded-full overflow-hidden">
                <div className="h-full bg-primary/50 animate-pulse" style={{ width: '100%' }} />
              </div>
            </div>

            {!showCancelConfirm ? (
              <Button 
                variant="outline" 
                className="w-full" 
                onClick={handleCancel}
              >
                Cancel
              </Button>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl p-4 text-left space-y-3"
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">Stop this pre-scan?</h4>
                    <p className="text-xs text-muted-foreground mt-1">
                      {isKeepScanning 
                        ? 'The extended scan will stop and no source will be added. You can start again or choose a smaller folder.'
                        : 'The scan will stop and no source will be added. You can start again at any time.'}
                    </p>
                  </div>
                </div>
                <div className="flex gap-3 pt-1">
                  <Button 
                    variant="outline" 
                    size="sm"
                    className="flex-1 border-muted-foreground/30" 
                    onClick={handleDismissCancel}
                  >
                    Continue Scan
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1 bg-amber-500 hover:bg-amber-600 text-white"
                    onClick={handleConfirmCancel}
                  >
                    Yes, Cancel
                  </Button>
                </div>
              </motion.div>
            )}
          </>
        )}

        {phase === 'timeout' && (
          <>
            <div className="flex flex-col items-center text-center mb-6">
              <div className="w-14 h-14 bg-amber-50 rounded-full flex items-center justify-center mb-4">
                <AlertTriangle className="w-7 h-7 text-amber-500" />
              </div>
              <h2 className="text-xl font-semibold text-foreground mb-2">Large Folder Detected</h2>
              <p className="text-sm text-muted-foreground mb-3">
                Scanned {progress.fileCount.toLocaleString()} files (~{formatBytes(progress.totalBytes)}) so far...
              </p>
              <p className="text-sm text-muted-foreground">
                This folder appears to be very large. Would you like to continue scanning, or proceed with what we know?
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Button 
                className="w-full bg-primary hover:bg-primary/90" 
                onClick={handleKeepScanning}
              >
                Keep Scanning
              </Button>
              <Button 
                variant="outline" 
                className="w-full" 
                onClick={handleProceedWithEstimate}
              >
                Analyze Now
              </Button>
              {!showCancelConfirm ? (
                <Button 
                  variant="ghost" 
                  className="w-full" 
                  onClick={handleCancel}
                >
                  Cancel
                </Button>
              ) : (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                  className="bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl p-4 text-left space-y-3 mt-1"
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                    <div>
                      <h4 className="text-sm font-semibold text-foreground">Stop this pre-scan?</h4>
                      <p className="text-xs text-muted-foreground mt-1">
                        The scan will stop and no source will be added. You can start again at any time.
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-3 pt-1">
                    <Button 
                      variant="outline" 
                      size="sm"
                      className="flex-1 border-muted-foreground/30" 
                      onClick={handleDismissCancel}
                    >
                      Continue Scan
                    </Button>
                    <Button
                      size="sm"
                      className="flex-1 bg-amber-500 hover:bg-amber-600 text-white"
                      onClick={handleConfirmCancel}
                    >
                      Yes, Cancel
                    </Button>
                  </div>
                </motion.div>
              )}
            </div>
          </>
        )}

        {phase === 'complete' && finalResult?.data && (
          <>
            <div className="flex flex-col items-center text-center mb-6">
              <div className={`w-14 h-14 rounded-full flex items-center justify-center mb-4 ${
                warningInfo.severity === 'low' ? 'bg-green-50' : 'bg-amber-50'
              }`}>
                {warningInfo.severity === 'low' ? (
                  <CheckCircle className="w-7 h-7 text-green-500" />
                ) : (
                  <AlertTriangle className="w-7 h-7 text-amber-500" />
                )}
              </div>
              <h2 className="text-xl font-semibold text-foreground mb-2">Pre-Scan Results</h2>
              <p className="text-xs text-muted-foreground">{storageLabel}</p>
              <IconTooltip label={sourceName} side="top">
                <p className="text-xs text-muted-foreground mb-3 truncate max-w-full">
                  {sourceName}
                </p>
              </IconTooltip>
              <p className="text-sm font-medium text-foreground mb-1">
                {finalResult.data.fileCount.toLocaleString()} files (~{formatBytes(finalResult.data.totalBytes)})
              </p>
              <p className="text-sm text-muted-foreground">
                {finalResult.data.photoCount.toLocaleString()} photos, {finalResult.data.videoCount.toLocaleString()} videos
              </p>
              {warningInfo.estimatedMinutes && warningInfo.estimatedMinutes > 1 && (
                <p className="text-sm text-muted-foreground mt-2">
                  Estimated analysis time: ~{warningInfo.estimatedMinutes < 60 
                    ? `${warningInfo.estimatedMinutes} minutes` 
                    : `${Math.round(warningInfo.estimatedMinutes / 60 * 10) / 10} hours`}
                </p>
              )}
            </div>

            <div className={`rounded-lg p-4 mb-6 ${
              warningInfo.severity === 'high' ? 'bg-amber-50 border border-amber-200' :
              warningInfo.severity === 'medium' ? 'bg-amber-50/50 border border-amber-100' :
              'bg-green-50 border border-green-200'
            }`}>
              <p className={`text-sm ${
                warningInfo.severity === 'high' ? 'text-amber-800' :
                warningInfo.severity === 'medium' ? 'text-amber-700' :
                'text-green-800'
              }`}>
                {warningInfo.message}
              </p>
              {warningInfo.severity !== 'low' && (
                <p className="text-xs text-muted-foreground mt-2">
                  <strong>Tip:</strong> For best results, copy files to internal storage or a drive connected directly to your computer (USB drive, external hard drive, or internal SSD/HDD).
                </p>
              )}
            </div>

            <div className="flex gap-3">
              <Button 
                variant="outline" 
                className="flex-1" 
                onClick={handleConfirmCancel}
              >
                Cancel
              </Button>
              <Button 
                className="flex-1 bg-primary hover:bg-primary/90" 
                onClick={handleContinueAnyway}
              >
                Analyze
              </Button>
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}