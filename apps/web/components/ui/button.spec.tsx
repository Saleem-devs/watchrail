import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button';

describe('Button', () => {
  it('uses a safe non-submit type by default', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Run now</Button>);

    const button = screen.getByRole('button', { name: 'Run now' });
    expect(button).toHaveAttribute('type', 'button');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('preserves native disabled behavior', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Checking
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Checking' });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(onClick).not.toHaveBeenCalled();
  });
});
