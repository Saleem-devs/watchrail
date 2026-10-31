import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Form } from './form';
import { Checkbox, Select } from './form-control';

describe('shared form controls', () => {
  it('uses the custom select and retains native form serialization', async () => {
    const user = userEvent.setup();
    const submitted = vi.fn();
    const changed = vi.fn();
    render(
      <Form
        onChange={changed}
        onSubmit={(event) => {
          submitted(Object.fromEntries(new FormData(event.currentTarget)));
        }}
      >
        <label>
          Operator
          <Select name="operator" defaultValue="exists">
            <option value="exists">exists</option>
            <option value="contains">contains</option>
          </Select>
        </label>
        <button type="submit">Save</button>
      </Form>,
    );

    const select = screen.getByRole('combobox', { name: 'Operator' });
    select.focus();
    await user.keyboard('{Enter}');
    expect(select).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('option', { name: 'contains' }));
    expect(select).toHaveTextContent('contains');
    expect(changed).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(submitted).toHaveBeenCalledWith({ operator: 'contains' }));
  });

  it('keeps checkbox semantics while using the shared visual treatment', async () => {
    const user = userEvent.setup();
    render(
      <label>
        <Checkbox />
        Store expected value as secret
      </label>,
    );

    const checkbox = screen.getByRole('checkbox', { name: 'Store expected value as secret' });
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
  });
});
