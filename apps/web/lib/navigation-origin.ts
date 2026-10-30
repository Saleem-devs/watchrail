export function safeInternalPath(value: string | null | undefined): string | undefined {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return undefined;
  return value;
}

export function monitorDetailHref(monitorId: string, origin: string, projectId?: string): string {
  const query = new URLSearchParams({ from: origin });
  const base = projectId ? `/projects/${projectId}` : '';
  return `${base}/monitors/${monitorId}?${query}`;
}

export function monitorEditHref(monitorId: string, origin: string, projectId?: string): string {
  const query = new URLSearchParams({ from: origin });
  const base = projectId ? `/projects/${projectId}` : '';
  return `${base}/monitors/${monitorId}/edit?${query}`;
}
