import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export type ToastVariant = 'success' | 'error' | 'info';

export type Toast = {
  id: number;
  variant: ToastVariant;
  content: ReactNode;
};

const DISMISS_MS = 4000;

export function useToasts() {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (variant: ToastVariant, content: ReactNode): number => {
      const id = nextId.current++;
      setToasts((ts) => [...ts, { id, variant, content }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DISMISS_MS),
      );
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  return { toasts, push, dismiss };
}

const ICON_STROKE: Record<ToastVariant, string> = {
  success: 'var(--accent)',
  error: 'var(--dlq)',
  info: 'var(--text-dim)',
};

function ToastIcon({ variant }: { variant: ToastVariant }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={ICON_STROKE[variant]}
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {variant === 'success' ? (
        <path d="M20 6 9 17l-5-5" />
      ) : (
        <>
          <circle cx="12" cy="12" r="9" />
          {variant === 'error' ? (
            <>
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </>
          ) : (
            <>
              <path d="M12 11v5" />
              <path d="M12 8h.01" />
            </>
          )}
        </>
      )}
    </svg>
  );
}

export function ToastRegion({ toasts }: { toasts: readonly Toast[] }) {
  return (
    <div className="toast-wrap" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`toast${t.variant === 'success' ? '' : ` ${t.variant}`}`}
        >
          <ToastIcon variant={t.variant} />
          <span>{t.content}</span>
        </div>
      ))}
    </div>
  );
}
