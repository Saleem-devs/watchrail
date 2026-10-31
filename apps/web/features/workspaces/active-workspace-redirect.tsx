'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { authClient } from '../../lib/auth-client';

export function ActiveWorkspaceRedirect() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const workspaceId = session?.session.activeOrganizationId;

  useEffect(() => {
    if (isPending) return;
    router.replace(workspaceId ? `/workspaces/${workspaceId}` : '/workspaces');
  }, [isPending, router, workspaceId]);

  return (
    <main className="grid min-h-screen place-items-center bg-rail-workspace px-4">
      <p className="m-0 text-sm text-rail-muted" role="status">
        Opening workspace…
      </p>
    </main>
  );
}
