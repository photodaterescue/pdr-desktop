import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import PeopleManager from './PeopleManager';

interface DockedPeopleManagerProps {
  open: boolean;
  onClose: () => void;
}

const WIDTH_KEY = 'pdr-docked-pm-width';
const MIN_WIDTH = 360;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 480;

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_WIDTH;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
  } catch {
    return DEFAULT_WIDTH;
  }
}

export function DockedPeopleManager({ open, onClose }: DockedPeopleManagerProps) {
  const [width, setWidth] = useState<number>(readStoredWidth);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  useEffect(() => {
    if (!draggingRef.current) return;
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = startXRef.current - e.clientX;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta));
      setWidth(next);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem(WIDTH_KEY, String(width)); } catch {}
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [open, width]);

  if (!open) return null;

  const beginDrag = (e: React.MouseEvent) => {
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  };

  return (
    <div
      className="fixed top-0 right-0 h-screen z-40 flex shadow-2xl border-l border-border bg-background"
      style={{ width }}
      data-testid="docked-people-manager"
    >
      {/* Resize handle — sits on the left edge of the drawer */}
      <div
        onMouseDown={beginDrag}
        className="absolute top-0 left-0 h-full w-1 cursor-col-resize hover:bg-purple-400/40 transition-colors"
        title="Drag to resize"
      />

      {/* Collapse button — floats on top-left so it doesn't collide with
          PeopleManager's own header controls. Collapses the drawer back
          to the sidebar click toggle. */}
      <button
        type="button"
        onClick={onClose}
        className="absolute top-2 left-2 z-10 w-7 h-7 rounded-lg hover:bg-accent flex items-center justify-center transition-colors"
        aria-label="Collapse People Manager"
        title="Collapse panel"
      >
        <ChevronRight className="w-4 h-4 text-muted-foreground" />
      </button>

      <div className="flex-1 min-w-0 h-full overflow-hidden">
        <PeopleManager />
      </div>
    </div>
  );
}
