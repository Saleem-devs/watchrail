'use client';

/**
 * OrgSwitcher — shows the active organization name and lets the user switch
 * to another organization or sign out.
 *
 * Rendered client-side so it can use Better Auth's reactive session hook.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '../lib/auth-client';

interface Org {
  id: string;
  name: string;
  slug: string;
}

export function OrgSwitcher() {
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Fetch the user's organizations once they're authenticated.
  useEffect(() => {
    if (!session?.user) return;
    authClient.organization
      .list()
      .then((result) => {
        if (result.data) setOrgs(result.data);
      })
      .catch(() => {
        // Non-critical — org list failing shouldn't break the page.
      });
  }, [session?.user]);

  // Close dropdown on outside click.
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  if (!session?.user) return null;

  const activeOrg = orgs.find((o) => o.id === session.session.activeOrganizationId) ?? orgs[0];

  async function switchOrg(org: Org) {
    setOpen(false);
    try {
      await authClient.organization.setActive({ organizationId: org.id });
      // Refresh the page so the dashboard reloads with the new org context.
      window.location.reload();
    } catch {
      // Silently ignore — the user can try again.
    }
  }

  async function handleSignOut() {
    setOpen(false);
    await authClient.signOut();
    router.push('/sign-in');
    router.refresh();
  }

  return (
    <div className="org-switcher-wrapper" ref={wrapperRef}>
      <button
        type="button"
        className="org-switcher"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="org-switcher-name">{activeOrg?.name ?? session.user.name}</span>
        <span className="org-switcher-caret" aria-hidden="true">
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div className="org-dropdown" role="listbox" aria-label="Organizations">
          {orgs.map((org) => (
            <button
              key={org.id}
              type="button"
              role="option"
              aria-selected={org.id === activeOrg?.id}
              className={`org-dropdown-item${org.id === activeOrg?.id ? ' active' : ''}`}
              onClick={() => void switchOrg(org)}
            >
              <span>{org.name}</span>
              {org.id === activeOrg?.id && (
                <span aria-hidden="true" style={{ fontSize: 10 }}>
                  ✓
                </span>
              )}
            </button>
          ))}

          <div className="org-dropdown-divider" />

          <button
            type="button"
            className="org-dropdown-action"
            onClick={() => void handleSignOut()}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
