import { useRef } from 'react';

interface DraggableModalOptions {
  /** Pixels reserved at the top of the viewport the modal must never
   *  overlap. Used to keep draggable modals clear of the workspace's
   *  purple app-header bar (~56px). Defaults to 60px which covers
   *  every current header variant. */
  topSafeZone?: number;
}

/**
 * Shared drag-to-reposition hook for Trees modals. Clamps the drag so
 * the modal's drag handle stays inside the viewport AND clear of the
 * workspace's top header bar — both bugs Terry hit (modal stranded
 * off-screen; modal overlapping the banner).
 *
 * Returns:
 *   modalRef       — attach to the inner modal container div.
 *   dragHandleProps — spread onto the header div that should grab
 *                     drag events. The returned className already
 *                     includes cursor-grab/grabbing and select-none.
 */
export function useDraggableModal(options: DraggableModalOptions = {}) {
  const topSafe = options.topSafeZone ?? 60;
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

    // Clamp so the drag handle never leaves the viewport AND never
    // overlaps the top safe-zone (workspace banner). Without the top
    // safe-zone the modal could partially cover the app header.
    const rect = modalRef.current?.getBoundingClientRect();
    let newX = rawX;
    let newY = rawY;
    if (rect) {
      const winW = window.innerWidth;
      const winH = window.innerHeight;
      const MIN_VISIBLE_TOP = 40;
      const MIN_VISIBLE_SIDE = 80;
      // new top = rect.top + (newY - d.y) must be >= topSafe
      const minY = d.y + topSafe - rect.top;
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
