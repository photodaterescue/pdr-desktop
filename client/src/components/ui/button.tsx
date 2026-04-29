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
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground border border-primary-border shadow-sm",
        secondary:
          "bg-background border border-primary/70 text-primary hover:bg-primary/5 dark:border-primary/60 dark:hover:bg-primary/10",
        // information / success / caution / destructive are handled by
        // the chip-variant fast path below — these strings are kept so
        // VariantProps<typeof buttonVariants> still includes them and
        // TS infers the right union.
        information: "",
        success: "",
        caution: "",
        destructive: "",
        icon:
          "h-9 w-9 p-0 text-foreground hover:bg-secondary",
        link:
          "text-primary underline-offset-4 hover:underline",
        // ─── Legacy variants (deprecated) ───
        default:
          "bg-primary text-primary-foreground border border-primary-border",
        outline:
          " border [border-color:var(--button-outline)] shadow-xs active:shadow-none ",
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

// Chip-variant fast path. Applied via inline style (highest CSS
// specificity) AND via the data-pdr-variant attribute (matched by the
// !important rule in index.css) so the colour lands regardless of any
// other rule in the cascade. Both are needed because we found in
// production that going through cva → cn → twMerge silently dropped
// the background colour for these variants — the diagnostic test that
// proved this is documented in feedback_tailwind_v4_pale_palette.md.
const CHIP_VARIANTS = ['information', 'success', 'caution', 'destructive'] as const;
type ChipVariant = typeof CHIP_VARIANTS[number];
const isChipVariant = (v: unknown): v is ChipVariant =>
  typeof v === 'string' && (CHIP_VARIANTS as readonly string[]).includes(v);

const chipInlineStyle: Record<ChipVariant, React.CSSProperties> = {
  information: { backgroundColor: '#dbeafe', borderColor: '#3b82f6', color: '#1e3a8a', borderWidth: '1px', borderStyle: 'solid' },
  success:     { backgroundColor: '#d1fae5', borderColor: '#10b981', color: '#064e3b', borderWidth: '1px', borderStyle: 'solid' },
  caution:     { backgroundColor: '#fde68a', borderColor: '#f59e0b', color: '#78350f', borderWidth: '1px', borderStyle: 'solid' },
  destructive: { backgroundColor: '#fecaca', borderColor: '#ef4444', color: '#7f1d1d', borderWidth: '1px', borderStyle: 'solid' },
};

// Static class string for chip variants — the layout/typography parts
// of the button look. We build this manually instead of going through
// cva+cn because that pipeline was producing buttons with no chip
// colour despite the bundle clearly including the right classes and
// inline styles. Keeping this hand-rolled is uglier but reliable.
const CHIP_BASE_CLASS =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 cursor-pointer';
const CHIP_SIZE_CLASS: Record<NonNullable<ButtonProps['size']>, string> = {
  default: 'min-h-9 px-4 py-2',
  sm: 'min-h-8 rounded-md px-3 text-xs',
  lg: 'min-h-10 rounded-md px-8',
  icon: 'h-9 w-9',
};

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, style, ...props }, ref) => {
    // Chip-variant fast path: emit a plain HTML button with inline
    // style + data attribute. Bypasses cva/cn/twMerge entirely.
    if (!asChild && isChipVariant(variant)) {
      const sizeClass = CHIP_SIZE_CLASS[size ?? 'default'];
      const inlineStyle: React.CSSProperties = {
        ...chipInlineStyle[variant],
        ...style,
      };
      return (
        <button
          ref={ref}
          {...props}
          className={[CHIP_BASE_CLASS, sizeClass, className].filter(Boolean).join(' ')}
          data-pdr-variant={variant}
          style={inlineStyle}
        />
      );
    }
    // Non-chip variants keep the original cva path.
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        ref={ref}
        {...props}
        className={cn(buttonVariants({ variant, size, className }))}
        style={style}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
