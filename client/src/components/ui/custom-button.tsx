import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

/**
 * THIS is the Button used by workspace.tsx and most of the
 * dashboard surface. There is also a `button.tsx` next to this file
 * that's used by some modals (LibraryPlanner, FeatureTeaser, etc.).
 * Both Button components must keep the chip-tier variants in sync.
 *
 * See STYLE_GUIDE.md at the repo root for the eight-tier taxonomy.
 */

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-full text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        // ─── New 8-tier system (use these going forward) ──────────────
        primary:
          "bg-primary text-primary-foreground hover:bg-[#988BF2] button-shadow hover:translate-y-[-2px] hover:scale-[1.02] duration-400 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]",
        // information / success / caution / destructive: empty here —
        // their visuals are applied by the chip-variant fast path
        // below (inline style + data-pdr-variant). Listed in cva
        // anyway so VariantProps types include them.
        information: "",
        success: "",
        caution: "",
        destructive: "",
        secondary:
          "bg-background border border-primary/70 text-primary hover:bg-primary/5 dark:border-primary/60 dark:hover:bg-primary/10",
        icon:
          "h-9 w-9 p-0 text-foreground hover:bg-secondary",
        link:
          "text-primary underline-offset-4 hover:underline",

        // ─── Legacy variants (kept for unmigrated callers) ──
        default:
          "bg-primary text-primary-foreground hover:bg-[#988BF2] button-shadow hover:translate-y-[-2px] hover:scale-[1.02] duration-400 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]",
        outline:
          "border border-accent bg-transparent text-secondary-foreground hover:bg-secondary hover:translate-y-[-2px] hover:scale-[1.02] duration-400 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]",
        ghost: "hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        default: "h-10 px-6 py-2",
        sm: "h-9 rounded-full px-4",
        lg: "h-12 rounded-full px-8 text-base",
        icon: "h-10 w-10",
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

// Chip-variant fast path. See feedback_tailwind_v4_pale_palette.md and
// the prop-priority diagnostic transcript that led here. Inline style
// + data-pdr-variant attribute (matched by !important rule in
// index.css) ensure the colour lands regardless of any other rule in
// the cascade.
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

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, style, ...props }, ref) => {
    if (!asChild && isChipVariant(variant)) {
      const inlineStyle: React.CSSProperties = {
        ...chipInlineStyle[variant],
        ...style,
      };
      return (
        <button
          ref={ref}
          {...props}
          className={cn(buttonVariants({ variant, size, className }))}
          data-pdr-variant={variant}
          style={inlineStyle}
        />
      );
    }
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
        style={style}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
