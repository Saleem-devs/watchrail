import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTable, type DataTableColumn } from './data-table';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

type Row = { id: string; name: string };
const rows: Row[] = [{ id: 'api', name: 'Production API' }];
const columns: Array<DataTableColumn<Row>> = [
  {
    id: 'name',
    header: 'Name',
    cell: (row) => <a href={`/external/${row.id}`}>{row.name}</a>,
  },
];

describe('DataTable', () => {
  afterEach(() => {
    vi.useRealTimers();
    push.mockReset();
  });

  it('opens a row after a single click and supports keyboard navigation', async () => {
    vi.useFakeTimers();
    renderTable();
    const row = screen.getByRole('row', { name: 'Open Production API' });

    fireEvent.click(row, { detail: 1 });
    expect(push).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(220));
    expect(push).toHaveBeenCalledWith('/monitors/api');

    fireEvent.keyDown(row, { key: 'Enter' });
    expect(push).toHaveBeenLastCalledWith('/monitors/api');
  });

  it('cancels navigation and highlights the row on a double click', async () => {
    vi.useFakeTimers();
    renderTable();
    const row = screen.getByRole('row', { name: 'Open Production API' });

    fireEvent.click(row, { detail: 1 });
    fireEvent.doubleClick(row);
    await act(() => vi.advanceTimersByTime(220));

    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('row', { name: 'Open Production API, highlighted' })).toHaveAttribute(
      'data-highlighted',
      'true',
    );
  });

  it('keeps nested links and extensible actions independent from row navigation', async () => {
    vi.useFakeTimers();
    const onDelete = vi.fn();
    renderTable(onDelete);

    fireEvent.click(screen.getByRole('link', { name: 'Production API' }));
    await act(() => vi.advanceTimersByTime(220));
    expect(push).not.toHaveBeenCalled();

    vi.useRealTimers();
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Production API' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith(rows[0]);
  });
});

function renderTable(onDelete = vi.fn()) {
  return render(
    <DataTable
      rows={rows}
      columns={columns}
      actions={[{ id: 'delete', label: 'Delete', onSelect: onDelete, tone: 'danger' }]}
      getRowKey={(row) => row.id}
      getRowHref={(row) => `/monitors/${row.id}`}
      getRowLabel={(row) => row.name}
      ariaLabel="Services"
    />,
  );
}
