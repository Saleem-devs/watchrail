import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceSecretsPage } from './workspace-secrets-page';
import { WorkspaceSecretForm } from './workspace-secret-form';
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
  it('constructs a secret request from the reusable create form', async () => {
    const user = userEvent.setup();
    const created = { ...secret, versionNumber: 1, usageCount: 0 };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: created }, 201));
    const onSaved = vi.fn();

    render(<WorkspaceSecretForm formId="secret-form" onSaved={onSaved} />);
    await user.type(screen.getByLabelText(/^Key/), 'STRIPE_API_KEY');
    await user.type(screen.getByLabelText(/^Secret value/), 'sk_launch_sensitive');
    await user.type(screen.getByLabelText(/^Description/), 'Billing health checks');
    fireEvent.submit(screen.getByRole('form', { name: 'Add workspace secret' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(created));
    const [, request] = fetchMock.mock.calls[0]!;
    expect(request).toMatchObject({ method: 'POST' });
    expect(requestJson(fetchMock.mock.calls[0])).toEqual({
      key: 'STRIPE_API_KEY',
      description: 'Billing health checks',
      value: 'sk_launch_sensitive',
    });
  });

  it('rotates a value while keeping the existing value unavailable', async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: { ...secret, versionNumber: 3 } }, 201));

    render(<WorkspaceSecretForm formId="secret-form" secret={secret} onSaved={vi.fn()} />);
    expect(screen.getByLabelText(/^Replace secret value/)).toHaveValue('');
    await user.type(screen.getByLabelText(/^Replace secret value/), 'sk_rotated_value');
    fireEvent.submit(screen.getByRole('form', { name: 'Edit workspace secret' }));

    await waitFor(() =>
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/workspace-secrets/${secret.id}/rotations`),
    );
    expect(requestJson(fetchMock.mock.calls[0])).toEqual({
      value: 'sk_rotated_value',
    });
  });

  it('keeps referenced secrets protected from archive and routes edits to dedicated pages', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ data: [secret] }));

    render(<WorkspaceSecretsPage />);
    await screen.findByText('STRIPE_API_KEY');
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive' })).toHaveAttribute(
      'title',
      'Remove references before archiving',
    );
    expect(screen.getByRole('link', { name: 'Add secret' })).toHaveAttribute(
      'href',
      '/settings/secrets/new',
    );
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute(
      'href',
      `/settings/secrets/${secret.id}/edit`,
    );
    expect(screen.getByRole('link', { name: 'Rotate' })).toHaveAttribute(
      'href',
      `/settings/secrets/${secret.id}/edit#replace-value`,
    );
  });

  it('surfaces create validation beside the reusable form', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      json(
        {
          code: 'VALIDATION_FAILED',
          message: 'Workspace secret settings are invalid.',
          fields: { key: ['Use only letters, numbers, and underscores.'] },
        },
        400,
      ),
    );

    render(<WorkspaceSecretForm formId="secret-form" onSaved={vi.fn()} />);
    await user.type(screen.getByLabelText(/^Key/), 'VALID_KEY');
    await user.type(screen.getByLabelText(/^Secret value/), 'secret');
    fireEvent.submit(screen.getByRole('form', { name: 'Add workspace secret' }));
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
