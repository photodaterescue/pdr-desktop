import { ZoomIn, ZoomOut } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Vertical zoom pill — in / reset-to-100% / out. Matches the Workspace
 * Dashboard's bottom-right zoom UI so Welcome, source-selection, and
 * Workspace all share the same control surface.
 */
export function ZoomControls({
  zoomLevel,
  onZoomIn,
  onZoomOut,
  onReset,
  canZoomIn,
  canZoomOut,
  className,
}: {
  zoomLevel: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  canZoomIn: boolean;
  canZoomOut: boolean;
  className?: string;
}) {
  return (
    <div className={`fixed right-5 bottom-6 z-40 flex flex-col items-center gap-1 bg-background/90 backdrop-blur-sm border border-border/30 rounded-xl p-1.5 shadow-md opacity-80 hover:opacity-100 hover:shadow-lg hover:-translate-y-0.5 transition-all duration-300 ease-out ${className ?? ''}`}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onZoomIn}
              disabled={!canZoomIn}
              className="flex items-center justify-center w-7 h-7 rounded-lg bg-secondary/50 hover:bg-primary/15 text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all duration-200"
              aria-label="Zoom in"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left"><p>Zoom in</p></TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onReset}
              className="flex items-center justify-center w-7 h-5 text-[10px] font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-all duration-200"
              aria-label="Reset zoom to 100%"
            >
              {zoomLevel}%
            </button>
          </TooltipTrigger>
          <TooltipContent side="left"><p>Reset to 100%</p></TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onZoomOut}
              disabled={!canZoomOut}
              className="flex items-center justify-center w-7 h-7 rounded-lg bg-secondary/50 hover:bg-primary/15 text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-all duration-200"
              aria-label="Zoom out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left"><p>Zoom out</p></TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
