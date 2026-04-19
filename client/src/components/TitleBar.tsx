import React, { useEffect, useState } from 'react';
import { Sun, Moon } from 'lucide-react';
import { LicenseStatusBadge } from '@/components/LicenseModal';

/**
 * Custom title bar — PDR branding left, lavender right.
 * Rendered once at the app root so it appears on all views.
 *
 * Hosts two app-global controls on the right side of the lavender area so
 * they stay visible regardless of which view is active (Dashboard, S&D,
 * Memories, Trees):
 *   - Light/dark theme toggle
 *   - Licensed / Unlicensed status badge
 *
 * Behaviour:
 *  - When sidebar is expanded (> ~100px): title "Photo Date Rescue" sits next to the logo on the left
 *    over the white sidebar-matching background
 *  - When sidebar is collapsed (narrow strip): logo stays at its natural size (not squished),
 *    and the title "Photo Date Rescue" moves to the horizontal center of the lavender bar
 */
export function TitleBar() {
  const [sidebarWidth, setSidebarWidth] = useState<number>(280);
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    if (typeof document === 'undefined') return false;
    return document.documentElement.classList.contains('dark');
  });

  useEffect(() => {
    // Observe the --sidebar-width CSS variable changes
    const update = () => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim();
      const px = parseFloat(raw) || 280;
      setSidebarWidth(px);
    };
    update();
    // Poll occasionally — CSS var changes don't trigger observers directly
    const interval = setInterval(update, 200);
    return () => clearInterval(interval);
  }, []);

  // Sync local dark-mode state when another surface (Settings, keyboard
  // shortcut) flips the documentElement class.
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setIsDarkMode(document.documentElement.classList.contains('dark'));
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  const toggleDarkMode = () => {
    const next = !isDarkMode;
    if (next) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
    setIsDarkMode(next);
    try { localStorage.setItem('pdr-dark-mode', next ? 'true' : 'false'); } catch {}
    (window as any).pdr?.setTitleBarColor?.(next);
  };

  const isSidebarCollapsed = sidebarWidth < 100;
  // When collapsed, the white section holds just the logo at a fixed minimum width
  const whiteSectionWidth = isSidebarCollapsed ? 48 : sidebarWidth;

  return (
    <div
      className="custom-title-bar flex items-center shrink-0 select-none z-50 relative"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Left: white section with logo (+ text when expanded) */}
      <div
        className="flex items-center gap-2 h-full bg-white dark:bg-sidebar shrink-0 border-r sidebar-container"
        style={{
          WebkitAppRegion: 'drag',
          width: `${whiteSectionWidth}px`,
          transition: 'width 0.35s cubic-bezier(0.22, 1, 0.36, 1), padding 0.35s cubic-bezier(0.22, 1, 0.36, 1)',
          willChange: 'width',
          justifyContent: isSidebarCollapsed ? 'center' : 'flex-start',
          paddingLeft: isSidebarCollapsed ? 0 : '16px',
          paddingRight: isSidebarCollapsed ? 0 : '16px',
        } as React.CSSProperties}
      >
        <img
          src="./assets/pdr-logo_transparent.png"
          className="w-5 h-5 object-contain shrink-0"
          alt="PDR"
        />
        {!isSidebarCollapsed && (
          <span className="text-[12px] text-foreground font-semibold tracking-wide whitespace-nowrap font-heading">
            Photo Date Rescue
          </span>
        )}
      </div>

      {/* When collapsed: "Photo Date Rescue" title left-aligned, starting right after the white section */}
      {isSidebarCollapsed && (
        <span
          className="text-[12px] text-foreground/80 font-semibold tracking-wide whitespace-nowrap font-heading pl-3"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          Photo Date Rescue
        </span>
      )}

      {/* Rest: lavender draggable area */}
      <div className="flex-1" />

      {/* App-global controls — visible on every view. The no-drag wrapper is
          required so clicks aren't swallowed by the title-bar's drag region. */}
      <div
        className="flex items-center gap-1.5 pr-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={toggleDarkMode}
          className="flex items-center justify-center w-7 h-7 rounded-full hover:bg-white/20 text-white/80 hover:text-white transition-all"
          title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDarkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
        </button>
        <LicenseStatusBadge
          onClick={() => window.dispatchEvent(new CustomEvent('pdr:openLicenseModal'))}
        />
      </div>

      {/* Spacer for native window controls overlay area */}
      <div className="w-[140px] shrink-0" />
    </div>
  );
}
