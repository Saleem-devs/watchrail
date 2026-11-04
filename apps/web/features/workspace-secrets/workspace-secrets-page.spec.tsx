import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSecretsPage } from './workspace-secrets-page';
import type { WorkspaceSecret } from './workspace-secret-types';

const secret: WorkspaceSecret = {
  id: 'c4bf0120-c3d8-4743-b832-4465cf4358a3',
  key: 'STRIPE_API_KEY',
  description: 'Billing health checks',
  versionNumber: 2,
  usageCount: 1,
  value: { hasValue: true },
  status: 'ACTIVE',
  createdAt: '2026-11-04T12:00:00.000Z',
  updatedAt: '2026-11-04T13:00:00.000Z',
  archivedAt: null,
};

function requestJson(call: readonly unknown[] | undefined): unknown {
  const init = call?.[1];
  const body = typeof init === 'object' && init !== null && 'body' in init ? init.body : undefined;
  if (typeof body !== 'string') throw new TypeError('Expected a JSON request body.');
  return JSON.parse(body) as unknown;
}

afterEach(() => vi.restoreAllMocks());

describe('workspace secrets page', () => {
  it('constructs a secret request without rendering the secret value after saving', async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(json({ data: { ...secret, versionNumber: 1, usageCount: 0 } }, 201))
      .mockResolvedValueOnce(json({ data: [{ ...secret, versionNumber: 1, usageCount: 0 }] }));

    render(<WorkspaceSecretsPage />);
    await screen.findByText('No workspace secrets yet');
    await user.click(screen.getByRole('button', { name: 'Add secret' }));
    await user.type(screen.getByLabelText(/^Key/), 'STRIPE_API_KEY');
    await user.type(screen.getByLabelText(/^Secret value/), 'sk_launch_sensitive');
    await user.type(screen.getByLabelText(/^Description/), 'Billing health checks');
    await user.click(screen.getByRole('button', { name: 'Save secret' }));

    await screen.findByText('STRIPE_API_KEY encrypted and saved.');
    const [, request] = fetchMock.mock.calls[1]!;
    expect(request).toMatchObject({ method: 'POST' });
    expect(requestJson(fetchMock.mock.calls[1])).toEqual({
      key: 'STRIPE_API_KEY',
      description: 'Billing health checks',
      value: 'sk_launch_sensitive',
    });
    expect(screen.queryByDisplayValue('sk_launch_sensitive')).not.toBeInTheDocument();
    expect(screen.queryByText('sk_launch_sensitive')).not.toBeInTheDocument();
  });

  it('rotates a value while keeping the existing value unavailable', async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: [secret] }))
      .mockResolvedValueOnce(json({ data: { ...secret, versionNumber: 3 } }, 201))
      .mockResolvedValueOnce(json({ data: [{ ...secret, versionNumber: 3 }] }));

    render(<WorkspaceSecretsPage />);
    await screen.findByText('STRIPE_API_KEY');
    await user.click(screen.getByRole('button', { name: 'Rotate' }));
    expect(screen.getByLabelText(/^New secret value/)).toHaveValue('');
    await user.type(screen.getByLabelText(/^New secret value/), 'sk_rotated_value');
    await user.click(screen.getByRole('button', { name: 'Rotate secret' }));

    await screen.findByText('STRIPE_API_KEY rotated to version 3.');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/workspace-secrets/${secret.id}/rotations`);
    expect(requestJson(fetchMock.mock.calls[1])).toEqual({
      value: 'sk_rotated_value',
    });
  });

  it('keeps referenced secrets protected from archive and surfaces field validation', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: [secret] }))
      .mockResolvedValueOnce(
        json(
          {
            code: 'VALIDATION_FAILED',
            message: 'Workspace secret settings are invalid.',
            fields: { key: ['Use only letters, numbers, and underscores.'] },
          },
          400,
        ),
      );

    render(<WorkspaceSecretsPage />);
    await screen.findByText('STRIPE_API_KEY');
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive' })).toHaveAttribute(
      'title',
      'Remove references before archiving',
    );

    await user.click(screen.getByRole('button', { name: 'Add secret' }));
    await user.type(screen.getByLabelText(/^Key/), 'VALID_KEY');
    await user.type(screen.getByLabelText(/^Secret value/), 'secret');
    await user.click(screen.getByRole('button', { name: 'Save secret' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Use only letters, numbers, and underscores.',
    );
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
