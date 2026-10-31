'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '../lib/auth-client';

interface Org {
  id: string;
  name: string;
  slug: string;
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`}
      aria-hidden="true"
    >
      <path d="m6 8 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      className="size-4"
      aria-hidden="true"
    >
      <path d="m5 10 3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="size-4"
      aria-hidden="true"
    >
      <path d="M10 4v12M4 10h12" strokeLinecap="round" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="size-4"
      aria-hidden="true"
    >
      <path d="M6.5 5h9M6.5 10h9M6.5 15h9" strokeLinecap="round" />
      <circle cx="3.5" cy="5" r=".75" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="10" r=".75" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="15" r=".75" fill="currentColor" stroke="none" />
    </svg>
  );
}

function OrganizationIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
      aria-hidden="true"
    >
      <path d="M10 2.5 16 6v7l-6 3.5L4 13V6Z" />
      <path d="m4 6 6 3.5L16 6M10 9.5v7" />
    </svg>
  );
}

export function OrgSwitcher({
  reload,
  workspaceId,
}: { reload?: () => void; workspaceId?: string | undefined } = {}) {
  const { data: session } = authClient.useSession();

  if (!session?.user) return null;
  return <AuthenticatedOrgSwitcher session={session} reload={reload} workspaceId={workspaceId} />;
}

function AuthenticatedOrgSwitcher({
  session,
  reload,
  workspaceId,
}: {
  session: {
    user: { name: string };
    session: { activeOrganizationId?: string | null | undefined };
  };
  reload?: (() => void) | undefined;
  workspaceId?: string | undefined;
}) {
  const router = useRouter();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [open, setOpen] = useState(false);
  const [switchError, setSwitchError] = useState<string>();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    authClient.organization
      .list()
      .then((result) => {
        if (result.data) setOrgs(result.data);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const activeOrganizationId = workspaceId ?? session.session.activeOrganizationId;
  const activeOrg = orgs.find((org) => org.id === activeOrganizationId) ?? orgs[0];

  async function switchOrg(org: Org) {
    setSwitchError(undefined);
    try {
      const result = await authClient.organization.setActive({ organizationId: org.id });
      if (result.error) {
        setSwitchError('Could not switch organizations. Try again.');
        return;
      }
      setOpen(false);
      if (reload) {
        reload();
      } else {
        router.replace(`/workspaces/${org.id}`);
        router.refresh();
      }
    } catch {
      setSwitchError('Could not switch organizations. Try again.');
    }
  }

  async function handleSignOut() {
    setOpen(false);
    await authClient.signOut();
    router.push('/sign-in');
    router.refresh();
  }

  const displayName = activeOrg?.name ?? session.user.name;

  return (
    <div className="relative flex min-w-0 items-center gap-0" ref={wrapperRef}>
      <span className="px-1 text-sm text-rail-border-strong" aria-hidden="true">
        /
      </span>
      <Link
        href={activeOrg ? `/workspaces/${activeOrg.id}` : '/workspaces'}
        className="flex min-h-10 max-w-48 min-w-0 items-center gap-2 rounded-rail-control py-1 pr-1 pl-2 text-[13px] font-medium text-rail-text no-underline transition-colors hover:bg-rail-hover sm:min-h-8 sm:max-w-56"
      >
        <span className="grid size-5 shrink-0 place-items-center text-rail-muted">
          <OrganizationIcon />
        </span>
        <span className="truncate">{displayName}</span>
      </Link>
      <button
        ref={triggerRef}
        type="button"
        className="grid size-10 shrink-0 place-items-center rounded-rail-control border border-transparent bg-transparent text-rail-muted transition-colors hover:border-rail-border hover:bg-rail-hover hover:text-rail-text sm:size-8"
        aria-expanded={open}
        aria-controls="organization-menu"
        aria-haspopup="menu"
        aria-label={open ? 'Close workspace switcher' : 'Open workspace switcher'}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div
          id="organization-menu"
          role="menu"
          aria-label="Workspace switcher"
          className="absolute top-[calc(100%+0.5rem)] left-7 z-50 w-[18rem] overflow-hidden rounded-rail-panel border border-rail-border bg-rail-overlay shadow-[0_18px_50px_var(--color-rail-shadow)]"
        >
          <div className="flex items-center justify-between border-b border-rail-border px-3 py-2.5">
            <p className="text-xs font-medium text-rail-subtle">Switch workspace</p>
            <span className="text-[11px] tabular-nums text-rail-muted">
              {orgs.length} {orgs.length === 1 ? 'workspace' : 'workspaces'}
            </span>
          </div>

          <div className="p-1.5">
            {orgs.slice(0, 3).map((org) => {
              const isActive = org.id === activeOrganizationId;

              return (
                <button
                  key={org.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  className={`flex min-h-11 w-full items-center gap-2.5 rounded-rail-control border border-transparent px-2 text-left transition-colors focus-visible:!outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-rail-accent ${
                    isActive
                      ? 'bg-rail-selected text-rail-text'
                      : 'bg-transparent text-rail-subtle hover:bg-rail-hover hover:text-rail-text'
                  }`}
                  onClick={() => void switchOrg(org)}
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-rail-control border border-rail-border bg-rail-surface text-rail-muted">
                    <OrganizationIcon />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{org.name}</span>
                    <span className="block truncate text-[11px] text-rail-muted">/{org.slug}</span>
                  </span>
                  {isActive && (
                    <span className="shrink-0 text-rail-accent">
                      <CheckIcon />
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {switchError && (
            <p role="alert" className="mx-2 my-2 text-xs leading-5 text-rail-danger">
              {switchError}
            </p>
          )}

          <div className="border-t border-rail-border p-1.5">
            <Link
              role="menuitem"
              className="flex min-h-9 items-center gap-2.5 rounded-rail-control px-2 text-[13px] text-rail-subtle no-underline transition-colors hover:bg-rail-hover hover:text-rail-text focus-visible:!outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-rail-accent"
              href="/workspaces"
              onClick={() => setOpen(false)}
            >
              <span className="text-rail-muted">
                <ListIcon />
              </span>
              All workspaces
            </Link>
            <Link
              role="menuitem"
              className="flex min-h-9 items-center gap-2.5 rounded-rail-control px-2 text-[13px] text-rail-subtle no-underline transition-colors hover:bg-rail-hover hover:text-rail-text focus-visible:!outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-rail-accent"
              href="/workspaces/new"
              onClick={() => setOpen(false)}
            >
              <span className="text-rail-muted">
                <PlusIcon />
              </span>
              Create workspace
            </Link>
          </div>

          <div className="flex items-center justify-between border-t border-rail-border px-3 py-2">
            <Link
              role="menuitem"
              className="rounded-rail-control text-xs text-rail-muted no-underline transition-colors hover:text-rail-text focus-visible:!outline-none focus-visible:text-rail-text"
              href="/settings/organization"
              onClick={() => setOpen(false)}
            >
              Workspace settings
            </Link>
            <button
              type="button"
              role="menuitem"
              className="min-h-7 rounded-rail-control border border-transparent bg-transparent px-1.5 text-xs text-rail-muted transition-colors hover:bg-rail-hover hover:text-rail-danger focus-visible:!outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-rail-accent"
              onClick={() => void handleSignOut()}
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
