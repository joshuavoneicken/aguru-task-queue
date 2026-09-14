import { useCallback, useEffect, useRef, useState } from 'react';
import type { DlqTask } from './types.js';
import { ApiError, listDlq, requeue } from './api.js';
import { ToastRegion, useToasts } from './Toast.js';

type DlqViewProps = {
  queue: string;
  onBack: () => void;
};

/** Matches the .drow leave transition in styles.css. */
const LEAVE_MS = 300;

export function timeAgo(iso: string | null): string {
  if (iso === null) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function failureClass(kind: string): 'timeout' | 'terminal' {
  return kind.includes('timeout') ? 'timeout' : 'terminal';
}

function requeueFailureReason(err: unknown): string {
  if (err instanceof ApiError) return `HTTP ${err.status}`;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

// 404 (not_found) and 409 (not_in_dlq) both mean the task provably left the DLQ
// before our call landed — requeued elsewhere, or moved by a worker. The optimistic
// removal was right; re-inserting would show the operator a row that no longer exists.
function taskAlreadyLeftDlq(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 409);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function DlqView({ queue, onBack }: DlqViewProps) {
  const [tasks, setTasks] = useState<readonly DlqTask[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const [leavingIds, setLeavingIds] = useState<ReadonlySet<string>>(new Set());
  const pendingRemovals = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const { toasts, push, dismiss } = useToasts();

  useEffect(() => {
    let cancelled = false;
    setTasks(null);
    setLoadError(null);
    listDlq(queue)
      .then((page) => {
        if (!cancelled) setTasks(page.tasks);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'unknown error');
      });
    return () => {
      cancelled = true;
    };
  }, [queue]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  useEffect(() => {
    const pending = pendingRemovals.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const toggleOpen = useCallback((id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setLeaving = useCallback((id: string, on: boolean) => {
    setLeavingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Optimistic, no undo — requeue has no inverse operation. The row leaves
  // immediately; a transient failure re-inserts it at its original index, while
  // a 404/409 (the task already left the DLQ) keeps it removed.
  const handleRequeue = useCallback(
    async (task: DlqTask, index: number) => {
      const removeRow = () => {
        pendingRemovals.current.delete(task.id);
        setLeaving(task.id, false);
        setTasks((ts) => (ts === null ? ts : ts.filter((t) => t.id !== task.id)));
      };

      setLeaving(task.id, true);
      if (prefersReducedMotion()) removeRow();
      else pendingRemovals.current.set(task.id, setTimeout(removeRow, LEAVE_MS));

      const confirmation = push(
        'success',
        <>
          <span className="tid">Task {task.id}</span> requeued — attempts reset
        </>,
      );

      try {
        await requeue(task.id);
      } catch (err) {
        dismiss(confirmation);
        if (taskAlreadyLeftDlq(err)) {
          push(
            'info',
            <>
              <span className="tid">Task {shortId(task.id)}</span> was already cleared from the
              queue.
            </>,
          );
          return;
        }
        const pending = pendingRemovals.current.get(task.id);
        if (pending !== undefined) {
          clearTimeout(pending);
          pendingRemovals.current.delete(task.id);
        }
        setLeaving(task.id, false);
        setTasks((ts) => {
          if (ts === null || ts.some((t) => t.id === task.id)) return ts;
          const next = [...ts];
          next.splice(Math.min(index, next.length), 0, task);
          return next;
        });
        push('error', `Could not requeue ${task.id} — ${requeueFailureReason(err)}`);
      }
    },
    [push, dismiss, setLeaving],
  );

  const count = tasks?.length ?? 0;

  return (
    <section>
      <nav className="crumb" aria-label="Breadcrumb">
        <button type="button" onClick={onBack}>
          ← Queues
        </button>
        <span className="sep">/</span>
        <span className="here">{queue}</span>
      </nav>
      <div className="panel">
        <div className="panel-head">
          <span className="eyebrow">Dead-letter queue</span>
          <div className="summary">
            <span>
              {tasks === null ? (
                'loading…'
              ) : count > 0 ? (
                <>
                  <b>{count}</b> task{count === 1 ? '' : 's'} awaiting triage
                </>
              ) : (
                <>
                  <b>0</b> tasks
                </>
              )}
            </span>
          </div>
        </div>
        <div className="dgrid" role="table" aria-label="Dead-lettered tasks">
          <div className="dhead" role="row">
            <span role="columnheader">Task</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Failure</span>
            <span role="columnheader">Last error</span>
            <span role="columnheader">Failed</span>
            <span />
          </div>
          {tasks?.map((t, i) => {
            const isLeaving = leavingIds.has(t.id);
            return (
              <div
                key={t.id}
                role="row"
                className={`drow${openIds.has(t.id) ? ' open' : ''}${isLeaving ? ' leaving' : ''}`}
              >
                <span className="task-id" role="cell" title={t.id}>
                  {shortId(t.id)}
                </span>
                <span role="cell">
                  <span className="chip type">{t.type}</span>
                </span>
                <span role="cell">
                  {t.failureKind !== null ? (
                    <span className={`chip fail ${failureClass(t.failureKind)}`}>
                      {t.failureKind}
                    </span>
                  ) : (
                    '—'
                  )}
                </span>
                <span className="errcell" role="cell">
                  <button
                    type="button"
                    className="errtext"
                    title="Click to expand"
                    aria-expanded={openIds.has(t.id)}
                    onClick={() => toggleOpen(t.id)}
                  >
                    {t.lastError ?? '—'}
                  </button>
                </span>
                <span className="relts" role="cell">
                  {timeAgo(t.failedAt)}
                </span>
                <span className="actcell" role="cell">
                  <button
                    type="button"
                    className="btn"
                    disabled={isLeaving}
                    onClick={() => void handleRequeue(t, i)}
                  >
                    {isLeaving ? 'Requeuing…' : 'Requeue'}
                  </button>
                </span>
              </div>
            );
          })}
          {loadError !== null && (
            <div className="empty">
              <h3>Could not load the dead-letter queue</h3>
              <p>{loadError}</p>
            </div>
          )}
          {tasks !== null && tasks.length === 0 && (
            <div className="empty">
              <div className="mark" aria-hidden="true">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </div>
              <h3>Nothing to triage</h3>
              <p>This queue is clear — no dead-lettered tasks remain.</p>
            </div>
          )}
        </div>
      </div>
      <ToastRegion toasts={toasts} />
    </section>
  );
}
