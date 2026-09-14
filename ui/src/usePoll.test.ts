import { act, renderHook } from '@testing-library/react';
import { usePoll } from './usePoll.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Advance fake time inside act, letting pending promise chains settle. */
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

it('polls immediately and again after the interval', async () => {
  const fn = vi.fn().mockResolvedValue('tick');
  const { result } = renderHook(() => usePoll(fn, 2000));
  expect(fn).toHaveBeenCalledTimes(1);

  await advance(0);
  expect(result.current).toEqual({ data: 'tick', error: false, loading: false });

  await advance(2000);
  expect(fn).toHaveBeenCalledTimes(2);
});

it('keeps the last good data and sets error when a poll rejects', async () => {
  const fn = vi.fn().mockResolvedValueOnce('good').mockRejectedValue(new Error('down'));
  const { result } = renderHook(() => usePoll(fn, 2000));

  await advance(0);
  expect(result.current.data).toBe('good');
  expect(result.current.error).toBe(false);

  await advance(2000);
  expect(result.current.data).toBe('good');
  expect(result.current.error).toBe(true);
});

it('clears error on a later successful poll', async () => {
  const fn = vi
    .fn()
    .mockRejectedValueOnce(new Error('down'))
    .mockResolvedValue('recovered');
  const { result } = renderHook(() => usePoll(fn, 2000));

  await advance(0);
  expect(result.current.error).toBe(true);
  expect(result.current.data).toBeNull();

  await advance(2000);
  expect(result.current.error).toBe(false);
  expect(result.current.data).toBe('recovered');
});

it('ignores a slow earlier poll that resolves after a fresher one', async () => {
  const resolvers: Array<(v: string) => void> = [];
  const fn = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        resolvers.push(resolve);
      }),
  );
  const resolveRun = (i: number, v: string) => {
    const r = resolvers[i];
    if (r === undefined) throw new Error(`poll ${i} was never issued`);
    r(v);
  };
  const { result } = renderHook(() => usePoll(fn, 2000));

  await advance(2000); // second poll issued while the first is still in flight
  expect(fn).toHaveBeenCalledTimes(2);

  resolveRun(1, 'fresh');
  await advance(0);
  expect(result.current.data).toBe('fresh');
  expect(result.current.loading).toBe(false);

  resolveRun(0, 'stale'); // the earlier poll lands late …
  await advance(0);
  expect(result.current.data).toBe('fresh'); // … and must not clobber the newer data
});

it('stops the interval and stays silent after unmount', async () => {
  let release!: (v: string) => void;
  const fn = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const { result, unmount } = renderHook(() => usePoll(fn, 2000));
  expect(fn).toHaveBeenCalledTimes(1);

  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  unmount();

  // Resolve the in-flight poll after unmount and let more intervals elapse.
  release('late');
  await advance(6000);

  expect(fn).toHaveBeenCalledTimes(1); // the interval was cleared
  expect(result.current.loading).toBe(true); // no state landed after unmount
  expect(errorSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
});
