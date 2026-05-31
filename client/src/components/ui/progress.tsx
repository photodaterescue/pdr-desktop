"use client"

import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "@/lib/utils"

// v2.0.15 (Terry 2026-05-31) — added optional `indeterminate` prop.
// When set, the bar pulses gently across its full width instead of
// rendering a determinate fill. Used by surfaces that are actively
// working but don't know the total upfront (e.g. the Fix modal's
// destination-prescan phase, which discovers the file count as it
// walks). Determinate behaviour is unchanged when `indeterminate`
// is omitted, so every existing caller keeps working.
const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & { indeterminate?: boolean }
>(({ className, value, indeterminate, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn(
      "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
      className
    )}
    {...props}
  >
    {indeterminate ? (
      <div className="absolute inset-0 bg-primary rounded-full animate-pulse" />
    ) : (
      <ProgressPrimitive.Indicator
        className="h-full w-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    )}
  </ProgressPrimitive.Root>
))
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
