import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../cn";
import { Spinner } from "./spinner";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger" | "glass";
export type ButtonSize = "sm" | "md" | "lg";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-ink-900 text-white shadow-[inset_0_1px_0_0_rgb(255_255_255/0.25)] hover:bg-ink-800 focus-visible:outline-ink-900",
  // The call to action: a solid deep burgundy from the brand's pink family,
  // with a faint glow and a lighter wine on hover. The focus ring is the
  // light wine: at least 3:1 on the night page and on white (WCAG 1.4.11),
  // where the button's own darker wine is not.
  secondary:
    "bg-wine-700 text-white shadow-[0_8px_24px_-10px_rgb(122_31_61/0.7),inset_0_1px_0_0_rgb(255_255_255/0.18)] hover:bg-wine-600 hover:shadow-[0_10px_30px_-8px_rgb(143_39_73/0.8),inset_0_1px_0_0_rgb(255_255_255/0.22)] focus-visible:outline-wine-300",
  outline:
    "border border-ink-950/15 bg-white text-ink-900 hover:border-ink-950/30 hover:bg-ink-50 focus-visible:outline-ink-900",
  ghost: "text-ink-700 hover:bg-ink-50 hover:text-ink-950 focus-visible:outline-ink-900",
  danger: "bg-red-600 text-white hover:bg-red-700 focus-visible:outline-red-600",
  // A secondary action on a night surface: a translucent pane with a white
  // hairline, so the burgundy stays the one solid call to action. No
  // backdrop blur: on night it shows nothing and costs a repaint per frame
  // over animated content.
  glass:
    "border border-white/25 bg-white/5 text-white hover:border-white/40 hover:bg-white/10 focus-visible:outline-white",
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
