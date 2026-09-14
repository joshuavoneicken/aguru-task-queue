import type { QueueRow } from './types.js';
import { Sparkline } from './Sparkline.js';

type QueuesViewProps = {
  rows: QueueRow[];
  onSelect: (name: string) => void;
  /** Session in-flight samples per queue name; the app shell owns the buffer. */
  sparks?: ReadonlyMap<string, readonly number[]>;
  /** Queues whose in-flight count changed on the last poll; their cell replays the flash animation. */
  flash?: ReadonlySet<string>;
};

const NO_SAMPLES: readonly number[] = [];

export function QueuesView({ rows, onSelect, sparks, flash }: QueuesViewProps) {
  const sum = (pick: (q: QueueRow) => number) => rows.reduce((n, q) => n + pick(q), 0);

  return (
    <section>
      <div className="panel">
        <div className="panel-head">
          <span className="eyebrow">Queues</span>
          <div className="summary">
            <span>
              <b>{rows.length}</b> queues
            </span>
            <span className="dot-sep" />
            <span>
              <b data-testid="sum-ready">{sum((q) => q.ready)}</b> ready
            </span>
            <span className="dot-sep" />
            <span>
              <b data-testid="sum-inflight">{sum((q) => q.inFlight)}</b> in-flight
            </span>
            <span className="dot-sep" />
            <span className="crit">
              <b data-testid="sum-dlq">{sum((q) => q.dlq)}</b> dead-lettered
            </span>
          </div>
        </div>
        <div className="qgrid">
          <div className="qhead" aria-hidden="true">
            <span>Queue</span>
            <span className="num">Ready</span>
            <span
              className="num"
              title="In-flight now; sparkline traces the last ~2 min of this session"
            >
              In-flight
            </span>
            <span className="num">DLQ</span>
            <span />
          </div>
          {rows.map((q) => {
            const idle = q.ready + q.inFlight + q.dlq === 0;
            const flashing = flash?.has(q.name) ?? false;
            return (
              <button
                key={q.name}
                type="button"
                className={`qrow${q.dlq > 0 ? ' alert' : ''}${idle ? ' idle' : ''}`}
                aria-label={`${q.name}: ${q.ready} ready, ${q.inFlight} in-flight, ${q.dlq} dead-lettered`}
                onClick={() => onSelect(q.name)}
              >
                <span>
                  <span className="qname-main">{q.name}</span>
                </span>
                <span className={`num ready${q.ready ? '' : ' zero'}`}>{q.ready}</span>
                <span className="metric-cell">
                  <Sparkline values={sparks?.get(q.name) ?? NO_SAMPLES} />
                  {/* Keyed by value while flashing so consecutive changes remount the span
                      and the CSS animation restarts (the mockup's remove/reflow/add trick). */}
                  <span
                    key={flashing ? `flash-${q.inFlight}` : 'inflight'}
                    className={`num inflight${q.inFlight ? '' : ' zero'}${flashing ? ' flash' : ''}`}
                  >
                    {q.inFlight}
                  </span>
                </span>
                <span className={`num ${q.dlq ? 'dlq-hot' : 'zero'}`}>{q.dlq}</span>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <p className="hint">
        Select a queue to triage its dead-letter queue · counts refresh every <kbd>2s</kbd> ·
        sparklines trace this session
      </p>
    </section>
  );
}
