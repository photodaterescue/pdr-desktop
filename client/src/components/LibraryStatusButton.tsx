import { useEffect, useState } from 'react';
import { Library } from 'lucide-react';
import { IconTooltip } from '@/components/ui/icon-tooltip';
import { LibraryPanel } from '@/components/LibraryPanel';

// LibraryStatusButton — always-present title-bar entry point for the
// library-portable DB feature. Shape, padding, and hover behaviour
// mirror LicenseStatusBadge precisely so the two pills read as a
// matched pair on the right side of the title bar.
//
// Branding: indigo (the "library / archive / classical books" colour),
// chosen because it's meaningfully distinct from every other PDR brand
// colour (lavender for Workspace, blue for S&D, gold for Date Editor /
// Memories, pink for People Manager, emerald for Trees, teal for
// Reports) and carries the right cultural weight — Library of Congress
// blue, leather-bound books with gilt-edged indigo covers, archival
// permanence.
//
// State variations:
//   - Default / attached as writer → quiet indigo pill, no badge
//   - Another device is the writer (we're read-only) → calm pulse on
//     the icon + small amber dot on the pill
//   - Library offline / sync error → calm amber dot, no pulse
// Refreshes via 5 s poll + immediate refresh on modal close.

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
      // Swallow — title-bar control should never surface errors here.
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Cross-component open: other surfaces (e.g. the Library Drive offline
  // modal's "Change Library Drive" CTA) dispatch the `pdr:openLibraryPanel`
  // CustomEvent rather than mounting a second LibraryPanel instance. One
  // panel, one source of truth, one place where multi-device / sidecar /
  // license-key state lives. Matches the same dispatch pattern PDR uses
  // for tour-menu, post-fix flow, etc.
  useEffect(() => {
    const handler = () => setIsOpen(true);
    window.addEventListener('pdr:openLibraryPanel', handler as EventListener);
    return () => window.removeEventListener('pdr:openLibraryPanel', handler as EventListener);
  }, []);

  const handleClose = () => {
    setIsOpen(false);
    void refresh();
  };

  const attached = !!status?.attached;
  const isWriter = !!status?.isWriter;
  const writerOther = attached && !isWriter && !!status?.writerDeviceName;

  const tooltip = !attached
    ? 'Library — recover on a new PC, share across devices'
    : isWriter
    ? `Library — you are the writer on ${status?.libraryRoot ?? 'this drive'}`
    : `Library — read-only (${status?.writerDeviceName ?? 'another device'} is the writer)`;

  return (
    <>
      <IconTooltip label={tooltip} side="bottom">
        <button
          onClick={() => setIsOpen(true)}
          className="relative flex items-center gap-2 px-3 py-1.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200/60 text-xs font-medium hover:bg-indigo-100 hover:text-indigo-800 cursor-pointer transition-all duration-200 hover:scale-[1.02]"
          aria-label="Library"
          data-testid="titlebar-library-button"
        >
          <Library className={'w-3 h-3' + (writerOther ? ' animate-pulse' : '')} />
          <span>Library</span>
          {writerOther && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-amber-400 ring-1 ring-amber-200/40" />
          )}
        </button>
      </IconTooltip>
      <LibraryPanel isOpen={isOpen} onClose={handleClose} />
    </>
  );
}
