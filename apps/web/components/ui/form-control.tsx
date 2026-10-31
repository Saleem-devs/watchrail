'use client';

import * as SelectPrimitive from '@radix-ui/react-select';
import {
  Children,
  isValidElement,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

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

interface SelectOption {
  disabled: boolean;
  label: ReactNode;
  value: string;
}

const EMPTY_VALUE = '__watchrail_empty_select_value__';

function selectOptions(children: ReactNode): SelectOption[] {
  return Children.toArray(children).flatMap((child) => {
    if (
      !isValidElement<{ children?: ReactNode; disabled?: boolean; value?: string | number }>(child)
    ) {
      return [];
    }

    if (child.type !== 'option') return [];
    return [
      {
        disabled: Boolean(child.props.disabled),
        label: child.props.children,
        value: String(child.props.value ?? ''),
      },
    ];
  });
}

export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'multiple' | 'size'
> {
  controlSize?: FormControlSize;
}

/**
 * Token-driven select built on Radix behavior. It keeps the familiar option-child API used by
 * Watchrail while replacing the browser popup with a keyboard-accessible, portal-based menu.
 */
export function Select({
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  children,
  className,
  controlSize = 'default',
  defaultValue,
  disabled,
  id,
  name,
  onChange,
  required,
  value,
}: SelectProps) {
  const generatedId = useId();
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const options = selectOptions(children);
  const controlled = value !== undefined;
  const initialValue = String(value ?? defaultValue ?? options[0]?.value ?? '');
  const [uncontrolledValue, setUncontrolledValue] = useState(initialValue);
  const currentValue = String(controlled ? value : uncontrolledValue);
  const radixValue = currentValue === '' ? EMPTY_VALUE : currentValue;

  function change(nextRadixValue: string) {
    const nextValue = nextRadixValue === EMPTY_VALUE ? '' : nextRadixValue;
    if (!controlled) setUncontrolledValue(nextValue);
    onChange?.({ target: { value: nextValue } } as ChangeEvent<HTMLSelectElement>);
    hiddenInputRef.current?.dispatchEvent(new Event('change', { bubbles: true }));
  }

  return (
    <>
      {name ? <input ref={hiddenInputRef} type="hidden" name={name} value={currentValue} /> : null}
      <SelectPrimitive.Root
        value={radixValue}
        onValueChange={change}
        disabled={disabled}
        required={required}
      >
        <SelectPrimitive.Trigger
          id={id ?? generatedId}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-required={required || undefined}
          className={formControlClassName({
            size: controlSize,
            className: `flex items-center justify-between gap-3 text-left data-[placeholder]:text-rail-muted ${className ?? ''}`,
          })}
        >
          <SelectPrimitive.Value />
          <SelectPrimitive.Icon aria-hidden="true" className="shrink-0 text-rail-muted">
            <svg
              viewBox="0 0 16 16"
              fill="none"
              className="size-4"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            position="popper"
            sideOffset={6}
            collisionPadding={12}
            className="z-50 max-h-[min(22rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-rail-panel border border-rail-border-strong bg-rail-overlay p-1 shadow-[0_16px_48px_var(--color-rail-shadow)]"
          >
            <SelectPrimitive.Viewport>
              {options.map((option) => {
                const optionValue = option.value === '' ? EMPTY_VALUE : option.value;
                return (
                  <SelectPrimitive.Item
                    key={optionValue}
                    value={optionValue}
                    disabled={option.disabled}
                    className="relative flex min-h-9 cursor-pointer select-none items-center rounded-[calc(var(--radius-rail-control)-1px)] py-2 pr-3 pl-8 text-sm text-rail-text outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-rail-hover data-[state=checked]:bg-rail-selected"
                  >
                    <SelectPrimitive.ItemIndicator className="absolute left-2 grid size-4 place-items-center text-rail-accent">
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        className="size-4"
                        stroke="currentColor"
                        strokeWidth="1.8"
                      >
                        <path
                          d="m3.5 8.5 2.7 2.7 6.3-6.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </SelectPrimitive.ItemIndicator>
                    <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  </SelectPrimitive.Item>
                );
              })}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  ref?: Ref<HTMLInputElement>;
}

/** Native checkbox semantics with a shared Watchrail visual treatment. */
export function Checkbox({ className, ref, ...props }: CheckboxProps) {
  return (
    <span className={`relative inline-grid size-4 shrink-0 place-items-center ${className ?? ''}`}>
      <input
        ref={ref}
        type="checkbox"
        className="peer absolute inset-0 m-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
        {...props}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none grid size-4 place-items-center rounded-[4px] border border-rail-border-strong bg-rail-input text-rail-on-accent transition-colors peer-checked:border-rail-accent peer-checked:bg-rail-accent peer-checked:[&>svg]:opacity-100 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-rail-accent peer-disabled:opacity-50"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          className="size-3 opacity-0 transition-opacity"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="m3.5 8.5 2.7 2.7 6.3-6.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </span>
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
