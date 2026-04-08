import React from 'react';

/**
 * Custom title bar — PDR branding left (white), lavender right.
 * Rendered once at the app root so it appears on all views.
 * The white section width tracks --sidebar-width (set by the Sidebar component)
 * so it stays aligned when the user resizes the sidebar.
 */
export function TitleBar() {
  return (
    <div
      className="custom-title-bar flex items-center shrink-0 select-none z-50"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Left: white section with logo + app name — tracks sidebar width */}
      <div
        className="flex items-center gap-2 px-4 h-full bg-white dark:bg-sidebar shrink-0 border-r sidebar-container transition-[width] duration-0"
        style={{ WebkitAppRegion: 'drag', width: 'var(--sidebar-width, 280px)' } as React.CSSProperties}
      >
        <img
          src="./assets/pdr-logo_transparent.png"
          className="w-5 h-5 object-contain"
          alt="PDR"
        />
        <span className="text-[12px] text-foreground font-semibold tracking-wide whitespace-nowrap font-heading">
          Photo Date Rescue
        </span>
      </div>
      {/* Rest: lavender draggable area */}
      <div className="flex-1" />
      {/* Spacer for native window controls overlay area */}
      <div className="w-[140px] shrink-0" />
    </div>
  );
}
