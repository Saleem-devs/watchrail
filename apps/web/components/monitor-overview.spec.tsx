import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MonitorOverview } from './monitor-overview';

describe('MonitorOverview', () => {
  it('shows genuine monitoring state, including degraded and unknown', () => {
    render(<MonitorOverview monitors={[
      { currentCheck: { availability: 'AVAILABLE' } },
      { currentCheck: { availability: 'AVAILABLE', aggregateOutcome: 'DEGRADED' }, incidentState: { currentIncident: { id: 'incident' } } },
      { currentCheck: null },
    ]} />);
    const region = screen.getByRole('region', { name: 'Monitor overview' });
    for (const [label, count] of [['Total monitors','3'],['Operational','1'],['Needs attention','1'],['Awaiting evidence','1']]) {
      expect(within(region).getByText(label).parentElement?.parentElement).toHaveTextContent(count);
    }
    expect(within(region).getByRole('status')).toHaveTextContent('1 monitor has an open incident');
  });
  it('renders an empty workspace without an invented incident', () => {
    render(<MonitorOverview monitors={[]} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
