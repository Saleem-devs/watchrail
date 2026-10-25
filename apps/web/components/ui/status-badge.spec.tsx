import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge, type MonitoringStatus } from './status-badge';

describe('StatusBadge', () => {
  it.each([
    ['UP', 'Up'],
    ['DOWN', 'Down'],
    ['DEGRADED', 'Degraded'],
    ['UNKNOWN', 'Unknown'],
    ['PAUSED', 'Paused'],
  ] satisfies [MonitoringStatus, string][])(
    'presents %s with a visible text label',
    (status, label) => {
      render(<StatusBadge status={status} />);

      const badge = screen.getByText(label);
      expect(badge).toHaveAttribute('data-monitor-status', status);
      expect(badge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    },
  );
});
