import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import * as api from './api.js';
import { DlqView } from './DlqView.js';
import type { DlqTask } from './types.js';

vi.mock('./api.js', async (orig) => ({
  ...(await orig<typeof api>()),
  listDlq: vi.fn(),
  requeue: vi.fn(),
}));

const listDlq = vi.mocked(api.listDlq);
const requeue = vi.mocked(api.requeue);

const task: DlqTask = {
  id: '7f3a1c9e',
  type: 'http',
  failureKind: 'handler_terminal',
  lastError: 'blocked address',
  failedAt: new Date().toISOString(),
};

it('optimistically removes a row and calls requeue', async () => {
  listDlq.mockResolvedValue({ tasks: [task], nextCursor: null });
  requeue.mockResolvedValue(undefined);
  render(<DlqView queue="jobs" onBack={() => {}} />);
  await screen.findByText('7f3a1c9e');
  await userEvent.click(screen.getByRole('button', { name: /requeue/i }));
  expect(requeue).toHaveBeenCalledWith('7f3a1c9e');
  await waitFor(() => expect(screen.queryByText('7f3a1c9e')).not.toBeInTheDocument());
  expect(screen.getByText(/requeued/i)).toBeInTheDocument(); // confirmatory toast
});

it('rolls the row back when requeue fails transiently', async () => {
  listDlq.mockResolvedValue({ tasks: [task], nextCursor: null });
  requeue.mockRejectedValue(new Error('network'));
  render(<DlqView queue="jobs" onBack={() => {}} />);
  await screen.findByText('7f3a1c9e');
  await userEvent.click(screen.getByRole('button', { name: /requeue/i }));
  await waitFor(() => expect(screen.getByText('7f3a1c9e')).toBeInTheDocument()); // returned
  expect(screen.getByText(/could not requeue/i)).toBeInTheDocument();
});

it.each([404, 409])(
  'keeps the row removed when requeue reports %i — the task already left the DLQ',
  async (status) => {
    listDlq.mockResolvedValue({ tasks: [task], nextCursor: null });
    requeue.mockRejectedValue(new api.ApiError(status, 'task is not in the DLQ'));
    render(<DlqView queue="jobs" onBack={() => {}} />);
    await screen.findByText('7f3a1c9e');
    await userEvent.click(screen.getByRole('button', { name: /requeue/i }));
    expect(await screen.findByText(/already cleared/i)).toBeInTheDocument(); // informational
    await waitFor(() =>
      expect(screen.queryByRole('cell', { name: '7f3a1c9e' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/could not requeue/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/requeued —/)).not.toBeInTheDocument(); // confirmation withdrawn
  },
);

it('expands the error text from the keyboard', async () => {
  listDlq.mockResolvedValue({ tasks: [task], nextCursor: null });
  render(<DlqView queue="jobs" onBack={() => {}} />);
  const errtext = await screen.findByRole('button', { name: 'blocked address' });
  expect(errtext).toHaveAttribute('aria-expanded', 'false');

  errtext.focus();
  await userEvent.keyboard('{Enter}');
  expect(errtext).toHaveAttribute('aria-expanded', 'true');
  expect(errtext.closest('.drow')).toHaveClass('open');

  await userEvent.keyboard(' ');
  expect(errtext).toHaveAttribute('aria-expanded', 'false');
  expect(errtext.closest('.drow')).not.toHaveClass('open');
});

it('shows the positive empty state when the queue is clear', async () => {
  listDlq.mockResolvedValue({ tasks: [], nextCursor: null });
  render(<DlqView queue="jobs" onBack={() => {}} />);
  expect(await screen.findByText(/nothing to triage/i)).toBeInTheDocument();
});
