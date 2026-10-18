'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

type Member = {
  id: string;
  userId: string;
  role: string;
  user?: { name?: string; email?: string };
};
type Invitation = { id: string; email: string; role: string; status: string; expiresAt: string };
type Credential = {
  id: string;
  name: string;
  start: string;
  permissions: string[];
  enabled: boolean;
  expiresAt: string | null;
};

const credentialScopes = [
  ['monitor:read', 'Read monitors'],
  ['monitor:create', 'Create monitors'],
  ['monitor:update', 'Update monitors'],
  ['monitor:execute', 'Run checks'],
  ['check:read', 'Read check history'],
  ['incident:read', 'Read incidents'],
  ['availability:read', 'Read availability'],
] as const;

export default function OrganizationSettingsPage() {
  const router = useRouter();
  const [organization, setOrganization] = useState<{ name: string; slug: string } | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    const [org, memberPage, invitationPage, credentialPage] = await Promise.all([
      fetch('/api/organizations/current'),
      fetch('/api/organizations/current/members'),
      fetch('/api/organizations/current/invitations'),
      fetch('/api/api-credentials'),
    ]);
    if (![org, memberPage, invitationPage, credentialPage].every((response) => response.ok)) {
      setMessage('Could not load organization settings.');
      return;
    }
    setOrganization(((await org.json()) as { data: { name: string; slug: string } }).data);
    setMembers(((await memberPage.json()) as { data: Member[] }).data);
    setInvitations(((await invitationPage.json()) as { data: Invitation[] }).data);
    setCredentials(((await credentialPage.json()) as { data: Credential[] }).data);
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, []);

  async function saveOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/organizations/current', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: form.get('name'), slug: form.get('slug') }),
    });
    setMessage(response.ok ? 'Organization updated.' : 'Could not update organization.');
    if (response.ok) await load();
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/organizations/current/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: form.get('email'), role: form.get('role') }),
    });
    setMessage(response.ok ? 'Invitation queued for delivery.' : 'Could not create invitation.');
    if (response.ok) {
      event.currentTarget.reset();
      await load();
    }
  }

  async function changeRole(memberId: string, role: string) {
    const response = await fetch(`/api/organizations/current/members/${memberId}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    setMessage(response.ok ? 'Member role updated.' : 'Could not update member role.');
    if (response.ok) await load();
  }

  async function createCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const permissions = credentialScopes
      .map(([scope]) => scope)
      .filter((scope) => form.get(scope) === 'on');
    const response = await fetch('/api/api-credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: form.get('name'), permissions }),
    });
    if (!response.ok) {
      setMessage('Could not create API credential.');
      return;
    }
    const body = (await response.json()) as { data: Credential & { token: string } };
    setSecret(body.data.token);
    setMessage('Credential created. Copy the secret now; it will not be shown again.');
    event.currentTarget.reset();
    await load();
  }

  async function remove(path: string, success: string) {
    const response = await fetch(path, { method: 'DELETE' });
    setMessage(response.ok ? success : 'The operation was not permitted.');
    if (response.ok) await load();
  }

  async function transferOwnership(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/organizations/current/transfer-ownership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: form.get('userId') }),
    });
    setMessage(response.ok ? 'Ownership transferred.' : 'Could not transfer ownership.');
    if (response.ok) await load();
  }

  async function leaveOrganization() {
    if (!window.confirm('Leave this organization?')) return;
    const response = await fetch('/api/organizations/current/leave', { method: 'POST' });
    if (!response.ok) {
      setMessage(
        'Could not leave the organization. Transfer ownership first if you are its owner.',
      );
      return;
    }
    router.push('/');
    router.refresh();
  }

  async function deleteOrganization() {
    if (!window.confirm('Permanently delete this organization? This cannot be undone.')) return;
    const response = await fetch('/api/organizations/current', { method: 'DELETE' });
    if (!response.ok) {
      setMessage('Could not delete the organization.');
      return;
    }
    router.push('/');
    router.refresh();
  }

  return (
    <main className="settings-shell">
      <header className="settings-header">
        <div>
          <p className="eyebrow">Workspace administration</p>
          <h1>Organization settings</h1>
        </div>
        <Link href="/">Back to monitors</Link>
      </header>
      {message && (
        <p role="status" className="settings-notice">
          {message}
        </p>
      )}

      <section className="settings-card">
        <h2>General</h2>
        {organization && (
          <form onSubmit={saveOrganization} className="settings-form">
            <label>
              Name
              <input name="name" defaultValue={organization.name} required maxLength={120} />
            </label>
            <label>
              Slug
              <input name="slug" defaultValue={organization.slug} required />
            </label>
            <button type="submit">Save organization</button>
          </form>
        )}
      </section>

      <section className="settings-card">
        <h2>Members</h2>
        <div className="settings-list">
          {members.map((member) => (
            <div key={member.id} className="settings-row">
              <div>
                <strong>{member.user?.name ?? member.user?.email ?? member.userId}</strong>
                <small>{member.user?.email}</small>
              </div>
              <select
                aria-label="Member role"
                value={member.role}
                onChange={(event) => void changeRole(member.id, event.target.value)}
                disabled={member.role === 'owner'}
              >
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>
              {member.role !== 'owner' && (
                <button
                  className="danger"
                  onClick={() =>
                    void remove(
                      `/api/organizations/current/members/${member.id}`,
                      'Member removed.',
                    )
                  }
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="settings-card">
        <h2>Invitations</h2>
        <form onSubmit={invite} className="settings-form inline">
          <label>
            Email
            <input name="email" type="email" required />
          </label>
          <label>
            Role
            <select name="role" defaultValue="viewer">
              <option value="admin">Admin</option>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
          </label>
          <button type="submit">Invite member</button>
        </form>
        <div className="settings-list">
          {invitations.map((invitation) => (
            <div key={invitation.id} className="settings-row">
              <div>
                <strong>{invitation.email}</strong>
                <small>
                  {invitation.role} · {invitation.status}
                </small>
              </div>
              <button
                className="danger"
                onClick={() =>
                  void remove(
                    `/api/organizations/current/invitations/${invitation.id}`,
                    'Invitation revoked.',
                  )
                }
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-card">
        <h2>API credentials</h2>
        <form onSubmit={createCredential} className="settings-form">
          <label>
            Name
            <input name="name" required maxLength={120} />
          </label>
          <fieldset>
            <legend>Permissions</legend>
            {credentialScopes.map(([scope, label]) => (
              <label className="scope-option" key={scope}>
                <input type="checkbox" name={scope} /> {label}
              </label>
            ))}
          </fieldset>
          <button type="submit">Create credential</button>
        </form>
        {secret && (
          <div className="credential-secret">
            <strong>One-time secret</strong>
            <code>{secret}</code>
            <button onClick={() => void navigator.clipboard.writeText(secret)}>Copy</button>
          </div>
        )}
        <div className="settings-list">
          {credentials.map((credential) => (
            <div key={credential.id} className="settings-row">
              <div>
                <strong>{credential.name}</strong>
                <small>
                  {credential.start}… · {credential.permissions.join(', ')}
                </small>
              </div>
              <button
                className="danger"
                onClick={() =>
                  void remove(`/api/api-credentials/${credential.id}`, 'Credential revoked.')
                }
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-card danger-zone">
        <h2>Organization lifecycle</h2>
        <form onSubmit={transferOwnership} className="settings-form inline">
          <label>
            Transfer ownership to
            <select name="userId" required defaultValue="">
              <option value="" disabled>
                Select a member
              </option>
              {members
                .filter((member) => member.role !== 'owner')
                .map((member) => (
                  <option key={member.id} value={member.userId}>
                    {member.user?.email ?? member.userId}
                  </option>
                ))}
            </select>
          </label>
          <button type="submit">Transfer ownership</button>
        </form>
        <div className="settings-actions">
          <button type="button" className="danger" onClick={() => void leaveOrganization()}>
            Leave organization
          </button>
          <button type="button" className="danger" onClick={() => void deleteOrganization()}>
            Delete organization
          </button>
        </div>
      </section>
    </main>
  );
}
