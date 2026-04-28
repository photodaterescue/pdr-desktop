import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Button taxonomy — see STYLE_GUIDE.md at the repo root for the
 * full intent → tier mapping. Eight tiers, one visual treatment per
 * tier, no per-call className border/text overrides:
 *
 *   primary       — the main action on a screen
 *   secondary     — alternative or cancel that's still important
 *   information   — opens an informational view, doesn't mutate
 *   success       — affirmative completion / status confirmed
 *   caution       — action with consequences but not destructive
 *   destructive   — irreversible
 *   icon          — square icon-only control
 *   link          — inline text link inside copy
 *
 * Legacy variants (default, outline, ghost) are kept for backwards
 * compat during the migration sweep, and are deprecated. New code
 * must pick from the eight tiers above.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0" +
" hover-elevate active-elevate-2",
  {
    variants: {
      variant: {
        // ─── New 8-tier system (use these going forward) ──────────────
        primary:
          "bg-primary text-primary-foreground border border-primary-border shadow-sm",
        secondary:
          "bg-background border border-primary/70 text-primary hover:bg-primary/5 dark:border-primary/60 dark:hover:bg-primary/10",
        // Chip-style tints. Tailwind v4 redesigned its default colour
        // palette to oklch with much lower chroma than v3's RGB
        // equivalents — `bg-blue-200` in v4 is ~88% L / ~6% C
        // (effectively white-with-a-rumour-of-blue) where in v3 it
        // was #bfdbfe, clearly tinted. PDR's near-white dashboard
        // background means the v4 tokens read as "white card with no
        // border" no matter how high we push the scale. Bypass the
        // theme tokens entirely with explicit hex arbitrary values
        // (Tailwind v3 defaults) so the visual result is predictable.
        // Verified visible: see commit message + the diagnostic
        // pink-button confirmation that the pipeline works correctly.
        information:
          "bg-[#dbeafe] border border-[#3b82f6] text-[#1e3a8a] hover:bg-[#bfdbfe] hover:border-[#1d4ed8] dark:bg-blue-900/50 dark:border-blue-500 dark:text-blue-200 dark:hover:bg-blue-900/70",
        success:
          "bg-[#d1fae5] border border-[#10b981] text-[#064e3b] hover:bg-[#a7f3d0] hover:border-[#059669] dark:bg-emerald-900/50 dark:border-emerald-500 dark:text-emerald-200 dark:hover:bg-emerald-900/70",
        caution:
          "bg-[#fde68a] border border-[#f59e0b] text-[#78350f] hover:bg-[#fcd34d] hover:border-[#d97706] dark:bg-amber-900/50 dark:border-amber-500 dark:text-amber-200 dark:hover:bg-amber-900/70",
        destructive:
          "bg-[#fecaca] border border-[#ef4444] text-[#7f1d1d] hover:bg-[#fca5a5] hover:border-[#dc2626] dark:bg-red-900/50 dark:border-red-500 dark:text-red-200 dark:hover:bg-red-900/70",
        icon:
          "h-9 w-9 p-0 text-foreground hover:bg-secondary",
        link:
          "text-primary underline-offset-4 hover:underline",

        // ─── Legacy variants (deprecated, kept until sweep migrates) ──
        // @deprecated use `primary`
        default:
          "bg-primary text-primary-foreground border border-primary-border",
        // @deprecated use `secondary` / `information` / `success` / `caution`
        outline:
          " border [border-color:var(--button-outline)] shadow-xs active:shadow-none ",
        // @deprecated use `secondary` (low-emphasis) or `icon`
        ghost: "border border-transparent",
      },
      size: {
        default: "min-h-9 px-4 py-2",
        sm: "min-h-8 rounded-md px-3 text-xs",
        lg: "min-h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

// Inline-style fallback for the four chip variants. This belt-and-braces
// approach guarantees the colour shows regardless of:
//   • twMerge stripping arbitrary-value classes it doesn't recognise,
//   • a higher-specificity rule somewhere in the cascade overriding the
//     `.bg-\[\#dbeafe\]` Tailwind utility,
//   • a parent element's CSS variable interfering.
// If the Tailwind classes ARE applying, this is a no-op (the inline
// styles match what the classes would set anyway).
const variantInlineStyle: Record<string, React.CSSProperties | undefined> = {
  information: { backgroundColor: '#dbeafe', borderColor: '#3b82f6', color: '#1e3a8a', borderWidth: '1px', borderStyle: 'solid' },
  success:     { backgroundColor: '#d1fae5', borderColor: '#10b981', color: '#064e3b', borderWidth: '1px', borderStyle: 'solid' },
  caution:     { backgroundColor: '#fde68a', borderColor: '#f59e0b', color: '#78350f', borderWidth: '1px', borderStyle: 'solid' },
  destructive: { backgroundColor: '#fecaca', borderColor: '#ef4444', color: '#7f1d1d', borderWidth: '1px', borderStyle: 'solid' },
};

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, style, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    const fallbackStyle = variant ? variantInlineStyle[variant] : undefined;
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        style={fallbackStyle ? { ...fallbackStyle, ...style } : style}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
