import type { Clock } from '../clock.js';
import type { QueueClient } from '../contracts.js';

export interface HeldTask {
  readonly id: string;
  readonly claimId: string;
}

/** Why a held task stopped being ours. `refused`: the queue answered the renewal with null — the
 * lease was reclaimed or the attempt is past its execution budget. `deadline`: no successful renewal
 * for a whole lease of local time; ownership is unknown. */
export type LossReason = 'refused' | 'deadline';

interface HeartbeatDeps {
  client: Pick<QueueClient, 'extend'>;
  leaseMs: number;
  clock: Clock;
  onLost: (id: string, reason: LossReason) => void;
}

interface Entry {
  readonly claimId: string;
  lastRenewedAt: number;
  renewalInFlight: boolean;
}

// Renews every held lease each leaseMs/3 tick, so two renewals may fail before the lease expires.
// The verdicts differ: a null renewal is the queue refusing — the lease is gone, the task is lost
// immediately — while a renewal that throws or hangs says nothing about ownership, so the task is
// lost only once leaseMs of monotonic time passes without a successful renewal. That bounds how long
// a partitioned worker can execute alongside its replacement to one lease.
export class Heartbeat {
  private readonly entries = new Map<string, Entry>();
  private ticker: NodeJS.Timeout | null = null;

  constructor(private readonly deps: HeartbeatDeps) {}

  start(): void {
    if (this.ticker !== null) throw new Error('heartbeat already started');
    this.ticker = this.deps.clock.setInterval(() => this.tick(), this.deps.leaseMs / 3);
  }

  stop(): void {
    if (this.ticker === null) return;
    this.deps.clock.clearInterval(this.ticker);
    this.ticker = null;
  }

  /** Claiming counts as a renewal: the lease-loss deadline runs from track time. */
  track(task: HeldTask): void {
    this.entries.set(task.id, {
      claimId: task.claimId,
      lastRenewedAt: this.deps.clock.now(),
      renewalInFlight: false,
    });
  }

  /** Forgets the task only if it is still held under this claim: a stale execution's release must
   * not un-heartbeat a re-claim of the same task under a newer claim id. */
  release(id: string, claimId: string): void {
    if (this.entries.get(id)?.claimId === claimId) this.entries.delete(id);
  }

  held(): HeldTask[] {
    return [...this.entries].map(([id, entry]) => ({ id, claimId: entry.claimId }));
  }

  heldIds(): string[] {
    return [...this.entries.keys()];
  }

  private tick(): void {
    const now = this.deps.clock.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.lastRenewedAt >= this.deps.leaseMs) {
        // Checked at the tick, not only when a renewal settles, so a renewal that never settles
        // cannot hold the task forever. The client's transport timeout makes that unlikely; this
        // deadline is the harness's own bound and depends on nobody else.
        this.lose(id, 'deadline');
        continue;
      }
      if (entry.renewalInFlight) continue; // one hung renewal must not become a pile of them
      entry.renewalInFlight = true;
      void this.renew(id, entry);
    }
  }

  private async renew(id: string, entry: Entry): Promise<void> {
    try {
      const renewed = await this.deps.client.extend(id, entry.claimId);
      if (this.entries.get(id) !== entry) return; // released, or re-claimed under a new claim id
      entry.renewalInFlight = false;
      if (renewed === null) {
        this.lose(id, 'refused');
        return;
      }
      entry.lastRenewedAt = this.deps.clock.now();
    } catch {
      if (this.entries.get(id) !== entry) return;
      entry.renewalInFlight = false;
      if (this.deps.clock.now() - entry.lastRenewedAt >= this.deps.leaseMs) this.lose(id, 'deadline');
    }
  }

  private lose(id: string, reason: LossReason): void {
    this.entries.delete(id);
    this.deps.onLost(id, reason);
  }
}
