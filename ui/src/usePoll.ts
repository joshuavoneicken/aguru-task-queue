import { useEffect, useRef, useState } from 'react';

export function usePoll<T>(fn: () => Promise<T>, ms: number): {
  data: T | null;
  error: boolean;
  loading: boolean;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    // Monotonic run token: a slow poll that resolves after a newer one has
    // been issued must not clobber the fresher result.
    let latestRun = 0;
    const run = async () => {
      const token = ++latestRun;
      const isCurrent = () => alive && token === latestRun;
      try {
        const d = await fnRef.current();
        if (isCurrent()) {
          setData(d);
          setError(false);
        }
      } catch {
        if (isCurrent()) setError(true);
      } finally {
        if (isCurrent()) setLoading(false);
      }
    };
    void run();
    const t = setInterval(() => void run(), ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [ms]);
  return { data, error, loading };
}
