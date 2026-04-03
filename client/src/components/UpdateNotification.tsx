import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, X, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/custom-button';
import { checkForUpdates, openExternalUrl, UpdateInfo } from '@/lib/electron-bridge';

export function UpdateNotification() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const check = async () => {
      try {
        const info = await checkForUpdates();
        if (info.updateAvailable) {
          setUpdateInfo(info);
        }
      } catch (error) {
        console.error('Update check failed:', error);
      }
    };
    
    // Check after a short delay to not block app startup
    const timer = setTimeout(check, 2000);
    return () => clearTimeout(timer);
  }, []);

  const handleDownload = async () => {
    if (updateInfo?.downloadUrl) {
      await openExternalUrl(updateInfo.downloadUrl);
    }
  };

  const handleDismiss = () => {
    if (!updateInfo?.mandatory) {
      setDismissed(true);
    }
  };

  if (!updateInfo || (!updateInfo.mandatory && dismissed)) {
    return null;
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 50 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 50 }}
        className="fixed bottom-4 right-4 z-50 max-w-sm"
      >
        <div className={`rounded-xl shadow-2xl border p-4 ${
          updateInfo.mandatory 
            ? 'bg-amber-50 border-amber-200 dark:bg-amber-950/50 dark:border-amber-800' 
            : 'bg-background border-border'
        }`}>
          <div className="flex items-start gap-3">
            <div className={`p-2 rounded-full ${
              updateInfo.mandatory 
                ? 'bg-amber-100 dark:bg-amber-900/50' 
                : 'bg-primary/10'
            }`}>
              {updateInfo.mandatory ? (
                <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
              ) : (
                <Download className="w-5 h-5 text-primary" />
              )}
            </div>
            
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <h3 className={`font-semibold ${
                  updateInfo.mandatory 
                    ? 'text-amber-900 dark:text-amber-200' 
                    : 'text-foreground'
                }`}>
                  {updateInfo.mandatory ? 'Update Required' : 'Update Available'}
                </h3>
                {!updateInfo.mandatory && (
                  <button
                    onClick={handleDismiss}
                    className="p-1 hover:bg-secondary rounded-full transition-colors"
                  >
                    <X className="w-4 h-4 text-muted-foreground" />
                  </button>
                )}
              </div>
              
              <p className="text-sm text-muted-foreground mt-1">
                Version {updateInfo.latestVersion} is available
                {updateInfo.currentVersion && ` (you have ${updateInfo.currentVersion})`}
              </p>
              
              {updateInfo.releaseNotes && (
                <p className="text-xs text-muted-foreground mt-1 italic">
                  {updateInfo.releaseNotes}
                </p>
              )}
              
              <div className="flex gap-2 mt-3">
                <Button
                  size="sm"
                  onClick={handleDownload}
                  className="flex-1"
                >
                  <Download className="w-4 h-4 mr-1" />
                  Download
                </Button>
                {!updateInfo.mandatory && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleDismiss}
                  >
                    Later
                  </Button>
                )}
              </div>
              
              {updateInfo.mandatory && (
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-2">
                  This update is required to continue using Photo Date Rescue.
                </p>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}