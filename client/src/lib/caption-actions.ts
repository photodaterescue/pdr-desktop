// Caption edit/clear helper — v2.0.13.
//
// Shared by every surface that hangs a "Add/Edit caption" right-click
// menu item off a photo tile: SearchPanel FileCard, MemoriesView
// drilldown grid, AlbumsView photo grid, and (later) the viewer.
//
// Why this lives in its own module:
//   - Three call sites, identical flow — keeping it inline triples the
//     surface area for "I forgot to write EXIF" / "I forgot to refresh
//     the badge after clear" bugs.
//   - Each surface still picks its own toast/refresh hook so the
//     helper stays purely "open modal → IPC → notify" without
//     reaching into any view's internal state.
//
// Returns the new caption (or null if removed); returns undefined when
// the user dismissed the modal. Surfaces that need a refresh on
// success listen for the `pdr:captionsChanged` window event with the
// `{ fileId }` detail.

import { promptInput } from '@/components/trees/promptConfirm';
import { toast } from 'sonner';

interface CaptionsApi {
  get: (fileId: number) => Promise<{ success: boolean; data?: string | null; error?: string }>;
  set: (fileId: number, caption: string, writeExif?: boolean) => Promise<{ success: boolean; error?: string }>;
  clear: (fileId: number, writeExif?: boolean) => Promise<{ success: boolean; error?: string }>;
}

function getCaptionsApi(): CaptionsApi | null {
  return (window as Window & { pdr?: { captions?: CaptionsApi } }).pdr?.captions ?? null;
}

/**
 * Open the caption editor for a single photo. Fetches the current
 * caption first so the modal pre-fills with whatever exists.
 *
 * EXIF write-through is ON by default — the user's caption travels
 * with the file when exported, which is the whole point of writing
 * captions in PDR rather than in some external tool.
 */
export async function editPhotoCaption(args: {
  fileId: number;
  filename?: string;
  writeExif?: boolean;
}): Promise<string | null | undefined> {
  const api = getCaptionsApi();
  if (!api) {
    toast.error('Caption editor unavailable');
    return undefined;
  }
  let initial = '';
  try {
    const res = await api.get(args.fileId);
    if (res.success && typeof res.data === 'string') initial = res.data;
  } catch { /* default to empty */ }

  const value = await promptInput({
    eyebrow: initial.length > 0 ? 'EDIT CAPTION' : 'ADD CAPTION',
    title: args.filename ? args.filename : 'Caption',
    message: 'Captions are saved in your PDR library and (when possible) written into the photo’s EXIF ImageDescription so they travel with the file when you export it.',
    placeholder: 'Type a caption…',
    initialValue: initial,
    multiline: true,
    maxLength: 1000,
    confirmLabel: 'Save caption',
    // v2.1 round 60 (Terry 2026-06-09) — let users drop emojis
    // into captions to "bring the comments to life". The picker
    // splices at the cursor so emojis can be interleaved with
    // text rather than only appended at the end.
    enableEmoji: true,
  });

  if (value === null) return undefined; // dismissed / cancelled

  const trimmed = value.trim();
  const writeExif = args.writeExif !== false;
  if (trimmed.length === 0) {
    // Empty input on save → treat as clear.
    const res = await api.clear(args.fileId, writeExif);
    if (res.success) {
      toast.success('Caption removed');
      window.dispatchEvent(new CustomEvent('pdr:captionsChanged', { detail: { fileId: args.fileId, caption: trimmed } }));
      return null;
    }
    toast.error('Couldn’t remove caption', { description: res.error });
    return undefined;
  }
  const res = await api.set(args.fileId, trimmed, writeExif);
  if (res.success) {
    toast.success(initial.length > 0 ? 'Caption updated' : 'Caption saved');
    window.dispatchEvent(new CustomEvent('pdr:captionsChanged', { detail: { fileId: args.fileId, caption: trimmed } }));
    return trimmed;
  }
  toast.error('Couldn’t save caption', { description: res.error });
  return undefined;
}

/**
 * Remove the caption without opening the editor — direct action from
 * a "Remove caption" context-menu item.
 */
export async function removePhotoCaption(args: {
  fileId: number;
  writeExif?: boolean;
}): Promise<boolean> {
  const api = getCaptionsApi();
  if (!api) {
    toast.error('Caption editor unavailable');
    return false;
  }
  const writeExif = args.writeExif !== false;
  const res = await api.clear(args.fileId, writeExif);
  if (res.success) {
    toast.success('Caption removed');
    window.dispatchEvent(new CustomEvent('pdr:captionsChanged', { detail: { fileId: args.fileId, caption: '' } }));
    return true;
  }
  toast.error('Couldn’t remove caption', { description: res.error });
  return false;
}
