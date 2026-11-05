import type { WorkspaceSecret } from './workspace-secret-types';

export function WorkspaceSecretOptions({
  loaded,
  secrets,
}: {
  loaded: boolean;
  secrets: readonly WorkspaceSecret[];
}) {
  if (loaded && secrets.length === 0) {
    return (
      <option value="" disabled>
        No active workspace secrets
      </option>
    );
  }

  return (
    <>
      <option value="">Select a secret</option>
      {secrets.map((secret) => (
        <option key={secret.id} value={secret.id}>
          {secret.key}
        </option>
      ))}
    </>
  );
}
