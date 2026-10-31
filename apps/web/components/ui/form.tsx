'use client';

import { FormProvider, useForm, type FieldValues } from 'react-hook-form';
import type { FormEvent, FormHTMLAttributes, ReactNode } from 'react';

export interface FormProps extends Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> {
  children: ReactNode;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
}

/**
 * Shared React Hook Form boundary for Watchrail forms.
 *
 * Existing forms can retain their native FormData contracts while moving onto one submission and
 * form-state foundation. New and incrementally migrated fields can consume the provider directly.
 */
export function Form({ children, onSubmit, ...props }: FormProps) {
  const methods = useForm<FieldValues>({ mode: 'onBlur' });

  function submit(event: FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    const retainedEvent = {
      ...event,
      currentTarget: form,
      target: form,
      preventDefault: () => event.preventDefault(),
      stopPropagation: () => event.stopPropagation(),
    } as FormEvent<HTMLFormElement>;

    return methods.handleSubmit(async () => {
      if (onSubmit) await onSubmit(retainedEvent);
    })(event);
  }

  return (
    <FormProvider {...methods}>
      <form {...props} onSubmit={onSubmit ? submit : undefined}>
        {children}
      </form>
    </FormProvider>
  );
}
