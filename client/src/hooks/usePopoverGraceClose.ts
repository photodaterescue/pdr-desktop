import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * v2.1 round 41 (Terry 2026-06-08) — auto-close Radix Popover /
 * DropdownMenu after the mouse leaves the trigger AND the content,
 * with a configurable grace window so brief leaves (e.g. the user
 * crosses the trigger→content gap, or wobbles the mouse just outside
 * the panel border) don't snap the popover closed.
 *
 * Terry: "The dropdown should have a period of grace for when the
 * mouse is no longer near or hovering, maybe a second or two...
 * I do know that having it permanently there is annoying."
 *
 * Returns:
 *   • `open` / `setOpen`     — wire to the Radix `open` / `onOpenChange` props.
 *   • `triggerHoverProps`    — spread onto the trigger element (or its
 *                              parent if asChild is in play).
 *   • `contentHoverProps`    — spread onto the popover/dropdown content.
 *
 * Behaviour:
 *   • Hovering either the trigger or the content cancels any pending close.
 *   • Leaving both starts a timer; after `graceMs` (default 1500 ms) the
 *     popover closes.
 *   • Click-to-close (Radix's `onPointerDownOutside`) and Esc still work
 *     normally — the grace window only governs the hover-out path.
 *   • setOpen(false) called explicitly (e.g. from an item onSelect)
 *     cancels any pending timer too.
 */
export function usePopoverGraceClose(graceMs = 1500) {
  const [open, setOpenState] = useState(false);
  const timerRef = useRef<number | null>(null);

  const cancelTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setOpenState(false);
    }, graceMs);
  }, [cancelTimer, graceMs]);

  const setOpen = useCallback((v: boolean) => {
    cancelTimer();
    setOpenState(v);
  }, [cancelTimer]);

  // Cleanup on unmount.
  useEffect(() => () => cancelTimer(), [cancelTimer]);

  const triggerHoverProps = {
    onMouseEnter: cancelTimer,
    onMouseLeave: scheduleClose,
  };
  const contentHoverProps = {
    onMouseEnter: cancelTimer,
    onMouseLeave: scheduleClose,
  };

  return { open, setOpen, triggerHoverProps, contentHoverProps };
}
