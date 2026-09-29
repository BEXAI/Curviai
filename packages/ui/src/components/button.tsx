import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../cn";
import { Spinner } from "./spinner";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-ink-900 text-white shadow-[inset_0_1px_0_0_rgb(255_255_255/0.25)] hover:bg-ink-800 focus-visible:outline-ink-900",
  // The call to action: the logo's teal into pink, with a soft glow that
  // brightens on hover.
  secondary:
    "bg-brand-gradient text-white shadow-[0_8px_24px_-8px_rgb(236_72_153/0.6),inset_0_1px_0_0_rgb(255_255_255/0.3)] hover:shadow-[0_10px_32px_-6px_rgb(236_72_153/0.75),inset_0_1px_0_0_rgb(255_255_255/0.35)] hover:brightness-110 focus-visible:outline-accent-500",
  outline:
    "border border-ink-950/15 bg-white text-ink-900 hover:border-ink-950/30 hover:bg-ink-50 focus-visible:outline-ink-900",
  ghost: "text-ink-700 hover:bg-ink-50 hover:text-ink-950 focus-visible:outline-ink-900",
  danger: "bg-red-600 text-white hover:bg-red-700 focus-visible:outline-red-600",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

export interface ButtonVariantOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

/**
 * Shared class builder so links can render as buttons without copying class
 * strings. Usage: <Link className={buttonVariants({ variant: "secondary" })}>.
 */
export function buttonVariants({ variant = "primary", size = "md", className }: ButtonVariantOptions = {}) {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-xl font-medium tracking-tight transition-all duration-200 active:scale-[0.98]",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
    "disabled:pointer-events-none disabled:opacity-50",
    variantClasses[variant],
    sizeClasses[size],
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", type = "button", loading = false, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={buttonVariants({ variant, size, className })}
      {...props}
    >
      {loading ? <Spinner className="size-4" /> : null}
      {children}
    </button>
  );
});
