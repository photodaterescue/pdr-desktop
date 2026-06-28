/**
 * Shared Trees canvas export helpers.
 *
 * Lifted out of ManageTreesModal.tsx (round 475) so both the Manage
 * Trees panel AND the Trees toolbar "Actions ▾" menu can drive the
 * same PNG / PDF export from a single source of truth. The Trees
 * canvas SVG is found via `getTreeCanvasSvg()` (the
 * `svg[data-tree-canvas="true"]` node TreesCanvas renders).
 */

/** Locate the live Trees canvas SVG element. Null when nothing is
 *  rendered yet (no focus person / empty tree). */
export function getTreeCanvasSvg(): SVGSVGElement | null {
  return document.querySelector<SVGSVGElement>('svg[data-tree-canvas="true"]');
}

/** Serialise an SVG element and rasterise to a PNG blob at `scale` (2x
 *  for retina-quality output). Embedded images (avatar href="data:…")
 *  ride along with the serialisation; plain text uses system fonts. */
export async function svgToPngBlob(svg: SVGSVGElement, scale: number): Promise<Blob> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  // Ensure the clone carries its current on-screen dimensions as
  // attributes (the original uses CSS sizing which doesn't serialise).
  const rect = svg.getBoundingClientRect();
  clone.setAttribute('width', String(rect.width));
  clone.setAttribute('height', String(rect.height));
  // White background so light-theme exports aren't transparent.
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
  bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%');
  bg.setAttribute('fill', 'white');
  clone.insertBefore(bg, clone.firstChild);

  const serialized = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));
  const ctx = canvas.getContext('2d')!;

  return new Promise<Blob>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas export failed'));
      }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG load failed')); };
    img.src = url;
  });
}

/** Trigger a browser download of `blob` as `filename`. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]);
}

/** Export the given SVG to a PNG file download. Returns false when the
 *  raster step fails (caller can surface a toast). */
export async function exportTreeSvgToPng(svg: SVGSVGElement, treeName: string): Promise<void> {
  const blob = await svgToPngBlob(svg, 2);
  downloadBlob(blob, `${treeName || 'tree'}.png`);
}

/** Render the given SVG to a PNG and open a printable window (the
 *  user's browser print dialog doubles as "Save as PDF"). */
export async function exportTreeSvgToPdf(svg: SVGSVGElement, treeName: string): Promise<void> {
  // Render PNG first, then wrap in a printable window.
  const blob = await svgToPngBlob(svg, 2);
  const url = URL.createObjectURL(blob);
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) { URL.revokeObjectURL(url); return; }
  w.document.write(`<!doctype html><html><head><title>${escapeHtml(treeName || 'Tree')}</title>
    <style>
      body { margin: 0; display: flex; align-items: center; justify-content: center; background: white; }
      img { max-width: 100%; max-height: 100vh; }
      @media print { body { align-items: flex-start; justify-content: flex-start; } img { max-height: none; width: 100%; } }
    </style></head><body><img src="${url}" onload="window.focus(); window.print();" /></body></html>`);
  w.document.close();
}
