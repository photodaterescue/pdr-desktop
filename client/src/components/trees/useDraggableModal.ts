import { useRef } from 'react';

/**
 * Shared drag-to-reposition hook for Trees modals. Clamps the drag so
 * the modal's drag handle stays inside the viewport — without this,
 * shoving the modal up too far can hide the header that the user
 * needs to drag it back, stranding the modal off-screen (the exact
 * bug Terry hit with the People modal).
 *
 * Returns:
 *   modalRef       — attach to the inner modal container div.
 *   dragHandleProps — spread onto the header div that should grab
 *                     drag events. The returned className already
 *                     includes cursor-grab/grabbing and select-none.
 *
 * The caller is responsible for rendering the header content and any
 * close button inside the handle element (button clicks bubble up but
 * the hook skips drag init when the target is an interactive child).
 */
export function useDraggableModal() {
  const modalRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ x: 0, y: 0, dragging: false, sx: 0, sy: 0, bx: 0, by: 0 });

  const onPointerDown = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('button, input, textarea, a, select')) return;
    const d = dragRef.current;
    d.dragging = true;
    d.sx = e.clientX; d.sy = e.clientY;
    d.bx = d.x; d.by = d.y;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.dragging) return;
    const rawX = d.bx + e.clientX - d.sx;
    const rawY = d.by + e.clientY - d.sy;

    // Clamp so the drag handle never leaves the viewport. The old
    // ±half-window clamp let the user shove the modal so far up that
    // the header disappeared above the top edge, making the modal
    // unreachable. New clamp is based on the modal's CURRENT bounding
    // rect — we allow the user to move it far, but never past the
    // point where at least MIN_VISIBLE_TOP px of the modal top stays
    // on-screen (and the header lives inside those top pixels).
    const rect = modalRef.current?.getBoundingClientRect();
    let newX = rawX;
    let newY = rawY;
    if (rect) {
      const winW = window.innerWidth;
      const winH = window.innerHeight;
      const MIN_VISIBLE_TOP = 40;     // enough of the header stays visible at bottom edge
      const MIN_VISIBLE_SIDE = 80;    // minimum horizontal visibility on each side
      // Derive min/max translate deltas from the current rect:
      //   new top  = rect.top + (newY - d.y) => constrain between 0 and winH-MIN_VISIBLE_TOP
      //   new left = rect.left + (newX - d.x) similarly
      const minY = d.y - rect.top;
      const maxY = d.y + winH - MIN_VISIBLE_TOP - rect.top;
      const minX = d.x + MIN_VISIBLE_SIDE - rect.right;
      const maxX = d.x + winW - MIN_VISIBLE_SIDE - rect.left;
      newX = Math.max(minX, Math.min(maxX, rawX));
      newY = Math.max(minY, Math.min(maxY, rawY));
    }

    d.x = newX;
    d.y = newY;
    if (modalRef.current) modalRef.current.style.transform = `translate3d(${d.x}px, ${d.y}px, 0)`;
  };

  const onPointerUp = () => { dragRef.current.dragging = false; };

  return {
    modalRef,
    dragHandleProps: {
      style: { touchAction: 'none' as const },
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      className: 'cursor-grab active:cursor-grabbing select-none',
    },
  };
}
