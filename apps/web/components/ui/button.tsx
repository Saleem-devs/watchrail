import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
export type ButtonSize = 'default' | 'compact';

const variants: Record<ButtonVariant, string> = {
  primary:
    'border-transparent bg-rail-accent text-rail-on-accent hover:bg-rail-accent-hover disabled:hover:bg-rail-accent',
  secondary:
    'border-rail-border-strong bg-rail-surface text-rail-text hover:border-rail-selected-border hover:bg-rail-hover',
  quiet:
    'border-transparent bg-transparent text-rail-subtle hover:bg-rail-hover hover:text-rail-text',
  danger:
    'border-rail-danger/40 bg-rail-danger/10 text-rail-danger hover:border-rail-danger/60 hover:bg-rail-danger/15',
};

const sizes: Record<ButtonSize, string> = {
  default: 'min-h-10 px-3 py-1.5 text-sm sm:min-h-9',
  compact: 'min-h-9 px-2.5 py-1 text-xs sm:min-h-8',
};

export function actionClassName({
  variant = 'secondary',
  size = 'default',
  className = '',
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string | undefined;
} = {}): string {
  return `inline-flex items-center justify-center gap-2 rounded-rail-control border font-medium no-underline transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rail-accent disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`.trim();
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = 'secondary',
  size = 'default',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button type={type} className={actionClassName({ variant, size, className })} {...props} />
  );
}
