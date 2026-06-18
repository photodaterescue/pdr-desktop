/**
 * v2.1 round 277 (Terry) — Sharing Phase 1: shared OS file-drag helper.
 *
 * One place that every PDR photo surface (Memories, Albums, Search &
 * Discovery) calls from its tile `onDragStart` to start a NATIVE OS
 * drag of one OR MANY files out to another app (WhatsApp, Mail,
 * Photoshop, etc.). The underlying IPC (`window.pdr.drag.start`)
 * already accepts a files[] array + an icon dataURL and forwards to
 * Electron's `webContents.startDrag` in main — so this helper only
 * has to (a) resolve the drag effect, (b) build a NON-EMPTY drag
 * icon, and (c) hand the resolved string[] of paths to the bridge.
 *
 * THE CRITICAL INVARIANT — the icon must NEVER be empty.
 * Electron's `startDrag` SILENTLY no-ops on Windows when the icon is
 * an empty nativeImage (main defaults to nativeImage.createEmpty()).
 * The viewer's drag-to-app button hit exactly this trap and only
 * worked once it started passing a generated lavender square. So we
 * ALWAYS produce a canvas-rendered PNG dataURL here, falling back to
 * a solid PDR square if a thumbnail can't be drawn.
 *
 * SYNCHRONOUS-AT-DRAGSTART constraint — the drag icon has to be ready
 * the instant `dragstart` fires; there's no chance to await an image
 * decode. Even when `iconSrc` is a dataURL (PDR thumbs are 160px
 * dataURLs cached in component state), decoding it into a drawable
 * bitmap is async UNLESS that exact bitmap is already in the
 * browser's image cache (which it usually is — the same dataURL is
 * already painted in the visible <img> tile). So we create an Image,
 * point it at iconSrc, and draw it ONLY if it reports
 * `complete && naturalWidth > 0` synchronously; otherwise we fall
 * back to the solid square. Either branch yields a non-empty canvas.
 * We never await inside dragstart.
 *
 * Multi-file: when more than one path is dragged we stamp a gold
 * "(N)" count pill in the corner — this is the in-motion "Drag (N)"
 * badge the discoverability cue advertises.
 *
 * Renderer-canvas ONLY this phase: no main.ts / preload / sharp / SVG
 * changes (the IPC contract is already multi-file capable).
 */

// PDR brand tokens, inlined (this lib has no access to the CSS vars at
// canvas-draw time and the values must be concrete for the 2D context).
const PDR_LAVENDER = '#ad9eff';   // solid-square fallback fill
const PDR_INK = '#1a1a2e';        // PDR wordmark on the fallback square
const GOLD = '#FEC242';           // count-pill background
const GOLD_INK = '#1f1a08';       // count-pill text

const ICON_SIZE = 72;             // drag-icon canvas px (square)

/** Round-rect path helper (no Path2D dependency, broad support). */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Draw the solid lavender PDR square fallback into the whole canvas. */
function drawFallbackSquare(ctx: CanvasRenderingContext2D, size: number) {
  ctx.fillStyle = PDR_LAVENDER;
  roundRectPath(ctx, 0, 0, size, size, Math.round(size * 0.18));
  ctx.fill();
  ctx.fillStyle = PDR_INK;
  ctx.font = `bold ${Math.round(size * 0.3)}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText('PDR', size / 2, size / 2 + 1);
}

/** Stamp the gold "(N)" count pill into the bottom-right corner. */
function drawCountPill(ctx: CanvasRenderingContext2D, size: number, count: number) {
  const label = String(count);
  ctx.font = `bold ${Math.round(size * 0.26)}px sans-serif`;
  const textW = ctx.measureText(label).width;
  const padX = Math.round(size * 0.12);
  const pillH = Math.round(size * 0.4);
  const pillW = Math.max(pillH, Math.round(textW + padX * 2));
  const x = size - pillW - 3;
  const y = size - pillH - 3;
  // Soft dark backing so the gold pill reads against a light thumb.
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  roundRectPath(ctx, x - 1, y - 1, pillW + 2, pillH + 2, (pillH + 2) / 2);
  ctx.fill();
  ctx.fillStyle = GOLD;
  roundRectPath(ctx, x, y, pillW, pillH, pillH / 2);
  ctx.fill();
  ctx.fillStyle = GOLD_INK;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(label, x + pillW / 2, y + pillH / 2 + 1);
}

/**
 * Build the drag-icon dataURL on a canvas. GUARANTEED non-empty:
 * draws the thumbnail if it's synchronously available, else the solid
 * PDR square; stamps the count pill when count > 1.
 */
function buildDragIcon(iconSrc: string | undefined, count: number): string {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    let drewThumb = false;
    if (iconSrc) {
      // Only a SYNCHRONOUS draw is allowed — dragstart can't await a
      // decode. An Image pointed at an already-cached dataURL/URL
      // reports complete+naturalWidth immediately; if not, we skip it.
      try {
        const img = new Image();
        img.src = iconSrc;
        if (img.complete && img.naturalWidth > 0) {
          // Cover-fit into a rounded square (centre-crop the long side).
          const s = Math.min(img.naturalWidth, img.naturalHeight);
          const sx = (img.naturalWidth - s) / 2;
          const sy = (img.naturalHeight - s) / 2;
          ctx.save();
          roundRectPath(ctx, 0, 0, ICON_SIZE, ICON_SIZE, Math.round(ICON_SIZE * 0.18));
          ctx.clip();
          ctx.drawImage(img, sx, sy, s, s, 0, 0, ICON_SIZE, ICON_SIZE);
          ctx.restore();
          drewThumb = true;
        }
      } catch { /* tainted/undrawable source → fall through to square */ }
    }

    if (!drewThumb) drawFallbackSquare(ctx, ICON_SIZE);
    if (count > 1) drawCountPill(ctx, ICON_SIZE, count);

    const url = canvas.toDataURL('image/png');
    // toDataURL returns 'data:,' for a 0×0/failed canvas — treat that
    // as empty so the caller never feeds the no-op trap.
    return url && url.length > 'data:,'.length ? url : '';
  } catch {
    return '';
  }
}

export interface StartFileDragOpts {
  /** A thumbnail dataURL/URL to draw as the drag icon. If it isn't
   *  synchronously drawable the helper falls back to the PDR square. */
  iconSrc?: string;
}

/**
 * Start a native OS drag of `paths` (one or many) out of PDR.
 *
 * Call this from a tile's `onDragStart`. The caller resolves its own
 * selection shape into a plain string[] (whole selection when the
 * dragged tile is part of it, else just `[onePath]`) — this helper is
 * selection-agnostic.
 *
 * @returns true if a drag was started, false if there was nothing to drag.
 */
export function startFileDrag(
  e: React.DragEvent,
  paths: string[],
  opts?: StartFileDragOpts,
): boolean {
  if (!paths || paths.length === 0) return false;

  try { e.dataTransfer.effectAllowed = 'copy'; } catch { /* readonly in some contexts */ }
  // preventDefault so Chromium doesn't also kick off its own
  // (single-file, no-icon) drag alongside Electron's startDrag.
  e.preventDefault();

  const iconDataUrl = buildDragIcon(opts?.iconSrc, paths.length);
  try {
    (window as any).pdr?.drag?.start?.(paths, iconDataUrl);
  } catch { /* bridge missing in non-electron contexts → no-op */ }
  return true;
}
