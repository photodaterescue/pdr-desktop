import { useId } from 'react';

/**
 * The Companion's "AI" sparkle, stroked with PDR's Share-button gradient (violet #8b5cf6 →
 * fuchsia #d946ef) so every Ask-PDR / AI mark reads as the same intelligent accent (Terry, r590).
 *
 * Self-contained: each instance carries its own <linearGradient> with a unique id, so it renders
 * correctly anywhere (a titlebar menu item, a panel header) without a shared document-level def.
 * Size it with a Tailwind width/height class, e.g. <AiSparkle className="w-4 h-4" />.
 */
export function AiSparkle({ className }: { className?: string }) {
  // useId() contains colons (":r0:") which can break url(#…) refs — strip them for a safe SVG id.
  const id = 'aisp-' + useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="2" y1="3" x2="22" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#d946ef" />
        </linearGradient>
      </defs>
      <g stroke={`url(#${id})`} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
        <path d="M19 14l.7 1.9L22 17l-2.3.6L19 20l-.7-1.9L16 17l2.3-.6L19 14z" />
      </g>
    </svg>
  );
}
