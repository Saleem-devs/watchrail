'use client';

import { useId, useState } from 'react';
import { Checkbox, Select } from '../../components/ui/form-control';
import type { TlsCertificatePolicy } from './types';

const EXPIRY_WINDOWS = [1, 2, 3, 7, 14, 30, 60] as const;

export function TlsCertificatePolicyField({
  initialPolicy,
  httpsEndpoint,
  error,
}: {
  initialPolicy: TlsCertificatePolicy;
  httpsEndpoint: boolean;
  error?: string;
}) {
  const id = useId();
  const [enabled, setEnabled] = useState(initialPolicy.type === 'MINIMUM_VALIDITY');
  const [days, setDays] = useState(
    initialPolicy.type === 'MINIMUM_VALIDITY' ? String(initialPolicy.days) : '30',
  );
  const active = enabled && httpsEndpoint;

  return (
    <fieldset className="m-0 border-0 border-t border-rail-border px-5 py-5 sm:px-6">
      <legend className="sr-only">TLS certificate monitoring</legend>
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0">
          <h2 className="m-0 text-sm font-semibold text-rail-text">TLS certificate</h2>
          <p className="mt-1 mb-0 max-w-2xl text-xs leading-5 text-rail-muted">
            Verify the certificate on every HTTPS hop and alert before it expires.
          </p>
        </div>
        <label className="flex min-h-10 shrink-0 cursor-pointer items-center gap-2.5 rounded-rail-control border border-rail-border px-3 text-xs font-medium text-rail-subtle hover:border-rail-border-strong has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
          <Checkbox
            name="tlsExpiryEnabled"
            checked={active}
            disabled={!httpsEndpoint}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Monitor expiry
        </label>
      </div>
      {httpsEndpoint ? (
        active ? (
          <label
            className="mt-4 grid max-w-sm gap-1.5 text-xs font-medium text-rail-subtle"
            htmlFor={`${id}-window`}
          >
            Minimum remaining validity
            <Select
              id={`${id}-window`}
              name="tlsExpiryDays"
              value={days}
              onChange={(event) => setDays(event.target.value)}
              aria-invalid={Boolean(error)}
            >
              {EXPIRY_WINDOWS.map((window) => (
                <option key={window} value={window}>
                  {window} {window === 1 ? 'day' : 'days'}
                </option>
              ))}
            </Select>
          </label>
        ) : null
      ) : (
        <p className="mt-3 mb-0 text-xs leading-5 text-rail-muted">
          Certificate monitoring becomes available when the endpoint uses HTTPS.
        </p>
      )}
      {error ? <p className="mt-2 mb-0 text-xs text-rail-danger">{error}</p> : null}
    </fieldset>
  );
}
