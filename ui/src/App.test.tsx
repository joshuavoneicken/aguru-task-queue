import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from './api.js';
import { App } from './App.js';

vi.mock('./api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api.js')>()),
  listQueues: vi.fn(),
  getStats: vi.fn(),
  listDlq: vi.fn(),
  requeue: vi.fn(),
}));

const listQueues = vi.mocked(api.listQueues);
const getStats = vi.mocked(api.getStats);
const listDlq = vi.mocked(api.listDlq);

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Advance fake time inside act, letting pending promise chains settle. */
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

it('shows a skeleton first, then renders queues once loaded, reading Live', async () => {
  listQueues.mockResolvedValue(['jobs']);
  getStats.mockResolvedValue({ ready: 1, inFlight: 0, dlq: 0 });

  render(<App />);
  expect(screen.getByText('Loading queues…')).toBeInTheDocument();

  expect(await screen.findByText('jobs')).toBeInTheDocument();
  expect(screen.getByText('Live')).toBeInTheDocument();
});

it('shows a banner when the API is unreachable, and Retry re-polls', async () => {
  listQueues.mockRejectedValueOnce(new Error('down')).mockResolvedValue(['jobs']);
  getStats.mockResolvedValue({ ready: 1, inFlight: 0, dlq: 0 });

  render(<App />);
  expect(await screen.findByText(/can.t reach the API/i)).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('jobs')).toBeInTheDocument();
});

it('drills into a queue DLQ and comes back', async () => {
  listQueues.mockResolvedValue(['jobs']);
  getStats.mockResolvedValue({ ready: 0, inFlight: 0, dlq: 1 });
  listDlq.mockResolvedValue({ tasks: [], nextCursor: null });

  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: /jobs/ }));
  expect(await screen.findByText('Dead-letter queue')).toBeInTheDocument();
  expect(listDlq).toHaveBeenCalledWith('jobs');

  await userEvent.click(screen.getByRole('button', { name: '← Queues' }));
  expect(await screen.findByText('jobs')).toBeInTheDocument();
});

it('keeps stale data on screen and reads Reconnecting… when a poll fails', async () => {
  vi.useFakeTimers();
  listQueues.mockResolvedValueOnce(['jobs']).mockRejectedValue(new Error('down'));
  getStats.mockResolvedValue({ ready: 3, inFlight: 0, dlq: 0 });

  render(<App />);
  await advance(0);
  expect(screen.getByText('jobs')).toBeInTheDocument();
  expect(screen.getByText('Live')).toBeInTheDocument();

  await advance(2000);
  expect(screen.getByText('jobs')).toBeInTheDocument(); // stale data stays
  expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
});

it('flashes the in-flight cell when the count changes between polls', async () => {
  vi.useFakeTimers();
  listQueues.mockResolvedValue(['jobs']);
  getStats
    .mockResolvedValueOnce({ ready: 1, inFlight: 0, dlq: 0 })
    .mockResolvedValue({ ready: 1, inFlight: 2, dlq: 0 });

  const { container } = render(<App />);
  await advance(0);
  expect(container.querySelector('.num.inflight')).not.toHaveClass('flash');

  await advance(2000);
  const cell = container.querySelector('.num.inflight');
  expect(cell).toHaveClass('flash');
  expect(cell).toHaveTextContent('2');

  await advance(2000); // unchanged poll: the flash clears
  expect(container.querySelector('.num.inflight')).not.toHaveClass('flash');
});
