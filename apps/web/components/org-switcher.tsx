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

export function OrgSwitcher() {
  const { data: session } = authClient.useSession();

  if (!session?.user) return null;
  return <AuthenticatedOrgSwitcher session={session} />;
}

function AuthenticatedOrgSwitcher({
  session,
}: {
  session: {
    user: { name: string };
    session: { activeOrganizationId?: string | null | undefined };
  };
}) {
  const router = useRouter();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [open, setOpen] = useState(false);
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

  const activeOrg = orgs.find((org) => org.id === session.session.activeOrganizationId) ?? orgs[0];

  async function switchOrg(org: Org) {
    setOpen(false);
    try {
      await authClient.organization.setActive({ organizationId: org.id });
      window.location.reload();
    } catch {
      triggerRef.current?.focus();
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
    <div className="relative min-w-0" ref={wrapperRef}>
      <button
        ref={triggerRef}
        type="button"
        className="flex min-h-11 max-w-56 min-w-0 items-center gap-2 rounded-lg border border-rail-border bg-rail-raised px-3 text-[13px] font-medium text-rail-text transition-colors hover:border-rail-border-strong hover:bg-rail-hover"
        aria-expanded={open}
        aria-controls="organization-menu"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-rail-selected text-xs font-semibold text-rail-accent">
          {displayName.trim().charAt(0).toUpperCase()}
        </span>
        <span className="truncate">{displayName}</span>
        <span className="shrink-0 text-rail-muted">
          <ChevronIcon open={open} />
        </span>
      </button>

      {open && (
        <div
          id="organization-menu"
          role="group"
          aria-label="Organization switcher"
          className="absolute top-[calc(100%+0.5rem)] right-0 z-50 w-64 rounded-xl border border-rail-border bg-rail-overlay p-2 shadow-[0_18px_50px_var(--color-rail-shadow)]"
        >
          <p className="px-2 pt-1 pb-2 text-xs font-medium text-rail-muted">Organizations</p>
          {orgs.map((org) => (
            <button
              key={org.id}
              type="button"
              aria-pressed={org.id === activeOrg?.id}
              className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-2 text-left text-[13px] text-rail-text transition-colors hover:bg-rail-hover"
              onClick={() => void switchOrg(org)}
            >
              <span className="truncate">{org.name}</span>
              {org.id === activeOrg?.id && (
                <span className="shrink-0 text-rail-accent">
                  <CheckIcon />
                </span>
              )}
            </button>
          ))}

          <div className="my-2 h-px bg-rail-border" />

          <Link
            className="flex min-h-11 items-center rounded-lg px-2 text-[13px] text-rail-subtle no-underline transition-colors hover:bg-rail-hover hover:text-rail-text"
            href="/settings/organization"
            onClick={() => setOpen(false)}
          >
            Organization settings
          </Link>
          <button
            type="button"
            className="flex min-h-11 w-full items-center rounded-lg px-2 text-left text-[13px] text-rail-subtle transition-colors hover:bg-rail-hover hover:text-rail-text"
            onClick={() => void handleSignOut()}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
