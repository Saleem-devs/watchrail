import type { InputHTMLAttributes, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

export type FormControlSize = 'default' | 'compact';

const sizes: Record<FormControlSize, string> = {
  default: 'min-h-10 px-3 text-sm',
  compact: 'min-h-9 px-2.5 text-xs sm:min-h-8',
};

export function formControlClassName({
  size = 'default',
  className = '',
}: {
  size?: FormControlSize;
  className?: string | undefined;
} = {}): string {
  return `w-full rounded-rail-control border border-rail-border-strong bg-rail-input font-normal text-rail-text transition-colors placeholder:text-rail-muted hover:border-rail-selected-border focus:border-rail-accent focus-visible:!outline-none disabled:cursor-not-allowed disabled:opacity-50 ${sizes[size]} ${className}`.trim();
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  controlSize?: FormControlSize;
  ref?: Ref<HTMLInputElement>;
}

export function Input({ controlSize, className, ref, type, ...props }: InputProps) {
  const isChoiceControl = type === 'checkbox' || type === 'radio';

  return (
    <input
      ref={ref}
      type={type}
      className={
        isChoiceControl
          ? `shrink-0 ${className ?? ''}`.trim()
          : formControlClassName({ size: controlSize ?? 'default', className })
      }
      {...props}
    />
  );
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  controlSize?: FormControlSize;
  ref?: Ref<HTMLSelectElement>;
}

export function Select({ controlSize, className, ref, ...props }: SelectProps) {
  return (
    <select
      ref={ref}
      className={formControlClassName({ size: controlSize ?? 'default', className })}
      {...props}
    />
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  controlSize?: FormControlSize;
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ controlSize, className, ref, ...props }: TextareaProps) {
  return (
    <textarea
      ref={ref}
      className={formControlClassName({ size: controlSize ?? 'default', className })}
      {...props}
    />
  );
}
