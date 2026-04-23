import { motion, AnimatePresence } from "framer-motion";
import { X, Sparkles, LayoutDashboard, CalendarClock, Network, Users, Key } from "lucide-react";
import { Button } from "@/components/ui/button";

export type TeaserFeature =
  | 'dashboard'
  | 'search-discovery'
  | 'memories'
  | 'trees'
  | 'people-manager';

interface FeatureTeaserModalProps {
  feature: TeaserFeature | null;
  onClose: () => void;
  onActivate: () => void;
}

interface FeatureCopy {
  icon: React.ReactNode;
  title: string;
  description: string;
}

const COPY: Record<TeaserFeature, FeatureCopy> = {
  'dashboard': {
    icon: <LayoutDashboard className="w-8 h-8 text-primary" />,
    title: 'Dashboard',
    description: 'See at a glance how many dates PDR confirmed, recovered, or marked for review across every source. Your command centre before and after each fix.',
  },
  'search-discovery': {
    icon: <Sparkles className="w-8 h-8 text-primary" />,
    title: 'Search & Discovery',
    description: "Find any photo by date, place, object, scene, or face. PDR's AI tags every image on-device so you can search your library like a pro — no cloud uploads, ever.",
  },
  'memories': {
    icon: <CalendarClock className="w-8 h-8 text-primary" />,
    title: 'Memories',
    description: 'Relive your photos chronologically — every trip, birthday, and milestone in the order it happened. Every library you build, one beautiful timeline.',
  },
  'trees': {
    icon: <Network className="w-8 h-8 text-primary" />,
    title: 'Trees',
    description: 'See the people from your photos as a family tree — a face for every name. Add relationships, generations, and step-family branches to bring your library to life.',
  },
  'people-manager': {
    icon: <Users className="w-8 h-8 text-primary" />,
    title: 'People Manager',
    description: "Verify the AI's facial recognition with granular precision. Merge, split, or rename people so every photo finds the right face — never worry about a misidentification.",
  },
};

export function FeatureTeaserModal({ feature, onClose, onActivate }: FeatureTeaserModalProps) {
  const isOpen = feature !== null;
  const copy = feature ? COPY[feature] : null;

  return (
    <AnimatePresence>
      {isOpen && copy && (
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
                  {copy.icon}
                </motion.div>

                <h2 className="text-xl font-semibold text-foreground mb-2">
                  {copy.title}
                </h2>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {copy.description}
                </p>
              </div>
            </div>

            <div className="px-6 pb-6 pt-2">
              <div className="space-y-4">
                <Button
                  onClick={onActivate}
                  className="w-full h-12 text-base font-medium shadow-lg shadow-primary/25 hover:shadow-primary/40 transition-all duration-300"
                >
                  <Key className="w-4 h-4 mr-2" />
                  Activate License
                </Button>

                <div className="text-center space-y-1">
                  <p className="text-xs text-muted-foreground">
                    Don't have a licence yet?
                  </p>
                  <button
                    onClick={async () => {
                      const { openExternalUrl } = await import('@/lib/electron-bridge');
                      await openExternalUrl('https://photodaterescue.com/#pricing');
                    }}
                    className="text-sm text-primary hover:underline font-medium cursor-pointer bg-transparent border-none"
                  >
                    Purchase Photo Date Rescue
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
