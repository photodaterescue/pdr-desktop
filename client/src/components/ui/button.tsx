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
        information:
          "bg-blue-50 border border-blue-300 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/30 dark:border-blue-700/50 dark:text-blue-300 dark:hover:bg-blue-900/50",
        success:
          "bg-emerald-50 border border-emerald-300 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:border-emerald-700/50 dark:text-emerald-300 dark:hover:bg-emerald-900/50",
        caution:
          "bg-amber-50 border border-amber-300 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/30 dark:border-amber-700/50 dark:text-amber-300 dark:hover:bg-amber-900/50",
        destructive:
          "bg-red-50 border border-red-300 text-red-700 hover:bg-red-100 dark:bg-red-900/30 dark:border-red-700/50 dark:text-red-300 dark:hover:bg-red-900/50",
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

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
