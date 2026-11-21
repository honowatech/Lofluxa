import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 py-px text-xs font-medium leading-[1.125rem]",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted text-foreground/80",
        success: "border-success/25 bg-success-soft text-success",
        warning: "border-warning/30 bg-warning-soft text-warning",
        blocking: "border-blocking/30 bg-blocking-soft text-blocking",
        info: "border-info/25 bg-info-soft text-info",
        primary: "border-primary/25 bg-accent text-accent-foreground",
        muted: "border-transparent bg-transparent text-muted-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);
export type Tone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
