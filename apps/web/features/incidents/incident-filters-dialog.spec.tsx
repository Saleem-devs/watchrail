import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IncidentFiltersDialog } from './incident-filters-dialog';

describe('IncidentFiltersDialog', () => {
  it('applies state and impact together', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<IncidentFiltersDialog status="all" severity="all" onApply={onApply} />);

    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(screen.getByLabelText('State'));
    await user.click(screen.getByRole('option', { name: 'Open' }));
    await user.click(screen.getByLabelText('Impact'));
    await user.click(screen.getByRole('option', { name: 'Unavailable' }));
    await user.click(screen.getByRole('button', { name: 'Apply filter' }));

    expect(onApply).toHaveBeenCalledWith({ status: 'open', severity: 'down' });
  });
});
