import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueuesView } from './QueuesView.js';

const rows = [
  { name: 'jobs', ready: 128, inFlight: 4, dlq: 3 },
  { name: 'webhooks', ready: 0, inFlight: 0, dlq: 0 },
];

it('renders a row per queue and flags a dlq>0 queue', () => {
  render(<QueuesView rows={rows} onSelect={() => {}} />);
  expect(screen.getByText('jobs')).toBeInTheDocument();
  expect(screen.getByText('webhooks')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /jobs/ })).toHaveClass('alert');
});

it('recedes a fully idle queue', () => {
  render(<QueuesView rows={rows} onSelect={() => {}} />);
  expect(screen.getByRole('button', { name: /webhooks/ })).toHaveClass('idle');
  expect(screen.getByRole('button', { name: /jobs/ })).not.toHaveClass('idle');
});

it('drills in on click', async () => {
  const onSelect = vi.fn();
  render(<QueuesView rows={rows} onSelect={onSelect} />);
  await userEvent.click(screen.getByRole('button', { name: /jobs/ }));
  expect(onSelect).toHaveBeenCalledWith('jobs');
});

it('summarises the fleet with the dead-letter total', () => {
  render(<QueuesView rows={rows} onSelect={() => {}} />);
  expect(screen.getByTestId('sum-ready')).toHaveTextContent('128');
  expect(screen.getByTestId('sum-inflight')).toHaveTextContent('4');
  expect(screen.getByTestId('sum-dlq')).toHaveTextContent('3');
});

it('feeds each row sparkline from the caller-owned sample buffer', () => {
  const sparks = new Map([['jobs', [1, 3, 2, 4]]]);
  const { container } = render(
    <QueuesView rows={rows} onSelect={() => {}} sparks={sparks} />,
  );
  expect(container.querySelectorAll('canvas.spark')).toHaveLength(rows.length);
});
