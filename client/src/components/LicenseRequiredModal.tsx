import { motion, AnimatePresence } from "framer-motion";
import { X, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

interface LicenseRequiredModalProps {
  isOpen: boolean;
  onClose: () => void;
  onActivate: () => void;
  feature?: string;
}

export function LicenseRequiredModal({ isOpen, onClose, onActivate, feature = "add sources" }: LicenseRequiredModalProps) {
  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 bg-black/[0.25] backdrop-blur-[2px] flex items-center justify-center z-50 p-4"
      >
        <motion.div 
          initial={{ scale: 0.95, opacity: 0, y: 10 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ type: "spring", duration: 0.5, bounce: 0.3 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-background rounded-2xl shadow-2xl max-w-md w-full border border-border overflow-hidden"
        >
          {/* Premium gradient header */}
          <div className="relative bg-gradient-to-br from-primary/10 via-primary/5 to-transparent px-6 pt-8 pb-6">
            <button 
              onClick={onClose} 
              className="absolute top-4 right-4 p-2 hover:bg-secondary/50 rounded-full transition-colors"
            >
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
            
            <div className="flex flex-col items-center text-center">
              <motion.div
                initial={{ scale: 0, rotate: -20 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ delay: 0.1, type: "spring", stiffness: 200 }}
                className="w-16 h-16 bg-gradient-to-br from-primary/20 to-primary/5 rounded-2xl flex items-center justify-center mb-4 border border-primary/20 shadow-lg shadow-primary/10"
              >
                <Sparkles className="w-8 h-8 text-primary" />
              </motion.div>
              
              <h2 className="text-xl font-semibold text-foreground mb-2">
                License Required
              </h2>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Activate your license to {feature} and start rescuing your photo dates.
              </p>
            </div>
          </div>

          {/* Content */}
          <div className="px-6 pb-6 pt-2">
            <div className="space-y-4">
              {/* Activate button with subtle glow */}
              <Button 
                onClick={onActivate}
                className="w-full h-12 text-base font-medium shadow-lg shadow-primary/25 hover:shadow-primary/40 transition-all duration-300"
              >
                <Sparkles className="w-4 h-4 mr-2" />
                Activate License
              </Button>
              
              {/* Secondary info */}
              <div className="text-center space-y-2">
                <p className="text-xs text-muted-foreground">
                  Already have a license key? Click above to enter it.
                </p>
                <button
                  onClick={async () => {
                    const { openExternalUrl } = await import('@/lib/electron-bridge');
                    await openExternalUrl('https://photodaterescue.com/#pricing');
                  }}
                  className="text-sm text-primary hover:underline font-medium cursor-pointer bg-transparent border-none"
                >
                  Don't have one? Purchase Photo Date Rescue →
                </button>
              </div>
              
              {/* Divider */}
              <div className="relative py-2">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border"></div>
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="px-3 bg-background text-muted-foreground">or</span>
                </div>
              </div>
              
              {/* Explore option */}
              <button
                onClick={() => {
                  onClose();
                  window.location.hash = '#/workspace';
                }}
                className="w-full text-sm text-muted-foreground hover:text-foreground transition-colors py-2"
              >
                Continue exploring the Workspace
              </button>
              
              {/* Reports History note */}
              <p className="text-xs text-muted-foreground/70 text-center leading-relaxed">
                You can still view your Reports History to review past fixes.
              </p>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}