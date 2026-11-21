import * as React from "react";

import { cn } from "@/lib/utils";

export const inputClass =
  "flex h-8 w-full rounded-md border border-input bg-card px-2 text-sm placeholder:text-muted-foreground/70 focus-ring disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-70 aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/30";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = "text", ...props }, ref) => (
    <input ref={ref} type={type} className={cn(inputClass, className)} {...props} />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, rows = 3, ...props }, ref) => (
  <textarea ref={ref} rows={rows} className={cn(inputClass, "h-auto py-1.5", className)} {...props} />
));
Textarea.displayName = "Textarea";

/** Liste déroulante native : dense, entièrement utilisable au clavier, fiable dans les tableaux. */
export const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn(inputClass, "cursor-pointer pr-6", className)} {...props}>
    {children}
  </select>
));
NativeSelect.displayName = "NativeSelect";
