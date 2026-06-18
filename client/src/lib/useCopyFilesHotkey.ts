import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

/**
 * v2.1 round 285 (Terry) — Ctrl/Cmd+C on a photo selection copies the FILE(S) to
 * the clipboard (CF_HDROP, via electron clipboard.copyFiles), so Ctrl+V in
 * Explorer / an email / a chat pastes ALL of them. Works single or multi.
 *
 * `visibilityRef` is any element inside the owning view's subtree: the hotkey
 * only fires when that element is actually visible. The photo views are kept
 * mounted but display:none'd when inactive, so this stops a hidden view from
 * stealing Ctrl+C from the one the user is actually looking at.
 *
 * `getPaths()` returns the current selection's absolute paths ([] = nothing to
 * copy). Read through a ref so the listener is registered once, never stale.
 */
export function useCopyFilesHotkey(
  visibilityRef: React.RefObject<HTMLElement | null>,
  getPaths: () => string[],
) {
  const getterRef = useRef(getPaths);
  getterRef.current = getPaths;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.key !== 'c' && e.key !== 'C')) return;
      const el = visibilityRef.current;
      if (!el || el.getClientRects().length === 0) return;            // owning view hidden
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (window.getSelection && String(window.getSelection() || '')) return;  // copying selected text
      const paths = (getterRef.current() || []).filter(Boolean);
      if (paths.length === 0) return;
      e.preventDefault();
      const api = (window as any).pdr?.clipboard;
      if (!api?.copyFiles) return;
      api.copyFiles(paths).then((r: any) => {
        if (r?.success) {
          toast.success(`Copied ${paths.length} ${paths.length === 1 ? 'photo' : 'photos'}`, { description: 'Paste them into a folder, email, or chat.' });
        } else if (r?.error) {
          toast.error(r.error);
        }
      }).catch(() => {});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visibilityRef]);
}
