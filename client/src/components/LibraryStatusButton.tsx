import { useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { LibraryPanel } from '@/components/LibraryPanel';

// LibraryStatusButton — always-present title-bar entry point for the
// library-portable DB feature. Visual state mirrors the design memo:
//   - Quiet small icon when this device is the sole writer
//   - "2 devices" pill badge when another device is also linked
//   - Slow pulse when another device is the active writer
//   - Calm amber dot when the library is offline / out of sync
//   - Calm rose dot on sync error
// Clicking opens LibraryPanel (modal). State refreshes on a 5s poll
// plus an immediate refresh whenever the modal closes (so any action
// the user took is reflected instantly in the title bar).

interface LibraryStatus {
  attached: boolean;
  libraryRoot: string | null;
  thisDeviceId: string;
  isWriter: boolean;
  writerDeviceName: string | null;
  writerDeviceId: string | null;
  sidecarPresent: boolean;
  lastAttachedAt: string | null;
}

const POLL_INTERVAL_MS = 5000;

export function LibraryStatusButton() {
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const refresh = async () => {
    try {
      const res = await (window as any).pdr?.library?.status();
      if (res?.success) setStatus(res.data as LibraryStatus);
    } catch {
      // Swallow — the title-bar button should never throw a visible error.
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const handleClose = () => {
    setIsOpen(false);
    void refresh();
  };

  const attached = !!status?.attached;
  const isWriter = !!status?.isWriter;
  const writerOther = attached && !isWriter && !!status?.writerDeviceName;

  // Tooltip text reflects the current state.
  const tooltip = !attached
    ? 'Library — connect a drive so your data can travel between devices'
    : isWriter
    ? `Library — you are the writer on ${status?.libraryRoot ?? 'this drive'}`
    : `Library — read-only (${status?.writerDeviceName ?? 'another device'} is the writer)`;

  return (
    <>
      <IconTooltip label={tooltip} side="bottom">
        <button
          onClick={() => setIsOpen(true)}
          className={
            'relative flex items-center justify-center w-7 h-7 rounded-full transition-all ' +
            (attached
              ? 'text-white/90 hover:bg-white/20 hover:text-white'
              : 'text-white/60 hover:bg-white/15 hover:text-white/90')
          }
          aria-label="Library"
          data-testid="titlebar-library-button"
        >
          <HardDrive className={'w-3.5 h-3.5' + (writerOther ? ' animate-pulse' : '')} />
          {/* Secondary-device badge: shown when we know another writer
              exists. Tiny dot top-right, calm — premium ethos. */}
          {writerOther && (
            <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-300/90 ring-1 ring-amber-200/40" />
          )}
        </button>
      </IconTooltip>
      <LibraryPanel isOpen={isOpen} onClose={handleClose} />
    </>
  );
}
