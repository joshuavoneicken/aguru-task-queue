import { useEffect, useRef, useState } from 'react';
import type { QueueRow } from './types.js';
import { getStats, listQueues } from './api.js';
import { usePoll } from './usePoll.js';
import { QueuesView } from './QueuesView.js';
import { DlqView } from './DlqView.js';

type View = { kind: 'queues' } | { kind: 'dlq'; queue: string };

const POLL_MS = 2000;
const SPARK_CAP = 60;

async function fetchQueueRows(): Promise<QueueRow[]> {
  const names = await listQueues();
  return Promise.all(names.map(async (n) => ({ name: n, ...(await getStats(n)) })));
}

export function App() {
  // Retry after total failure remounts the dashboard, restarting the poll immediately.
  const [pollEpoch, setPollEpoch] = useState(0);
  return <Dashboard key={pollEpoch} onRetry={() => setPollEpoch((e) => e + 1)} />;
}

function Dashboard({ onRetry }: { onRetry: () => void }) {
  const { data, error, loading } = usePoll(fetchQueueRows, POLL_MS);
  const [view, setView] = useState<View>({ kind: 'queues' });

  // Session in-flight samples per queue. The ref owns the buffers; each poll
  // publishes fresh slices because the Sparkline effect keys on array identity.
  const buffers = useRef(new Map<string, number[]>());
  const [sparks, setSparks] = useState<ReadonlyMap<string, readonly number[]>>(new Map());
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (data === null) return;
    const changed = new Set<string>();
    const fresh = new Map<string, readonly number[]>();
    for (const q of data) {
      const buf = buffers.current.get(q.name) ?? [];
      const last = buf[buf.length - 1];
      if (last !== undefined && last !== q.inFlight) changed.add(q.name);
      buf.push(q.inFlight);
      if (buf.length > SPARK_CAP) buf.shift();
      buffers.current.set(q.name, buf);
      fresh.set(q.name, buf.slice());
    }
    setSparks(fresh);
    setFlash(changed);
  }, [data]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">Aguru</span>
          <span className="brand-name">Task Queue</span>
          <span className="brand-sub">UI</span>
        </div>
        <div className="status">
          <span className="freshness" title="Polling every 2s">
            <span className="pulse" />
            <span>{error ? 'Reconnecting…' : 'Live'}</span>
          </span>
        </div>
      </header>
      {view.kind === 'dlq' ? (
        <DlqView queue={view.queue} onBack={() => setView({ kind: 'queues' })} />
      ) : data !== null ? (
        <QueuesView
          rows={data}
          onSelect={(name) => setView({ kind: 'dlq', queue: name })}
          sparks={sparks}
          flash={flash}
        />
      ) : loading ? (
        <section>
          <div className="panel">
            <div className="panel-head">
              <span className="eyebrow">Queues</span>
              <div className="summary">
                <span>Loading queues…</span>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section>
          <div className="panel">
            <div className="empty">
              <h3>Can&rsquo;t reach the API</h3>
              <p>Polling keeps trying in the background — or retry now.</p>
              <button type="button" className="btn" onClick={onRetry}>
                Retry
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
