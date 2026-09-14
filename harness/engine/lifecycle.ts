import { systemClock, type Clock } from '../clock.js';
import type { QueueClient } from '../contracts.js';
import type { HeldTask } from './heartbeat.js';

export interface LifecycleOptions {
  harness: { stop(): Promise<void>; heldTasks(): HeldTask[] };
  client: Pick<QueueClient, 'nack'>;
  shutdownGraceMs: number;
  onExit: (code: number) => void;
  clock?: Clock;
  /** Where the drain and release are reported; the entrypoint passes console.log. */
  log?: (message: string) => void;
}

export interface Lifecycle {
  /** The SIGTERM/SIGINT path: stop claiming, drain within the grace, release the rest, exit 0. */
  shutdown(): Promise<void>;
  /** The uncaughtException/unhandledRejection path: release everything held, exit 1. */
  crash(): Promise<void>;
}

// The worker's two exits. Both end in the blameless release: whatever this process still holds is
// nacked worker_shutdown with the attempt forgiven, because the interruption is the deployment's
// fault, not the task's. The nack is fenced by claimId, so a release racing an ack whose response
// was lost in transport resolves correctly either way.
export function createLifecycle(options: LifecycleOptions): Lifecycle {
  const clock = options.clock ?? systemClock;
  const log = options.log ?? ((): void => undefined);
  let draining = false;
  let crashed = false;
  let exited = false;

  const exit = (code: number): void => {
    if (exited) return;
    exited = true;
    options.onExit(code);
  };

  // Best-effort by construction: one nack failing (or being refused) must not strand the others or
  // the exit — allSettled, never all.
  const releaseHeld = (): Promise<unknown> =>
    Promise.allSettled(
      options.harness.heldTasks().map((task) =>
        options.client.nack(task.id, {
          reason: 'worker shutting down',
          retryable: true,
          kind: 'worker_shutdown',
          forgiveAttempt: true,
          claimId: task.claimId,
        }),
      ),
    );

  return {
    async shutdown(): Promise<void> {
      if (draining || crashed) return; // a repeated signal must not double-run the drain
      draining = true;
      const inFlight = options.harness.heldTasks().length;
      log(`shutdown: draining ${inFlight} in-flight ${inFlight === 1 ? 'task' : 'tasks'}, ${options.shutdownGraceMs} ms grace`);
      // stop() halts claiming but keeps the heartbeat ticking, so tasks finishing inside the grace
      // ack normally under a live lease; the grace timer bounds a drain a hung handler would
      // otherwise stretch forever.
      let graceTimer: NodeJS.Timeout | null = null;
      const drained = options.harness.stop().then(
        () => undefined,
        () => undefined,
      );
      const grace = new Promise<void>((resolve) => {
        graceTimer = clock.setTimeout(resolve, options.shutdownGraceMs);
      });
      await Promise.race([drained, grace]);
      if (graceTimer !== null) clock.clearTimeout(graceTimer);
      if (crashed) return; // the crash path already released and exited
      const stillHeld = options.harness.heldTasks().length;
      await releaseHeld();
      log(`shutdown: released ${stillHeld} still-held ${stillHeld === 1 ? 'task' : 'tasks'} without charging an attempt; exiting`);
      exit(0);
    },

    async crash(): Promise<void> {
      if (crashed) return;
      crashed = true; // wins over an in-progress drain: the process state is no longer trusted
      await releaseHeld();
      exit(1);
    },
  };
}

/**
 * Wires the lifecycle to the real process — installed once, by the entrypoint. Kept apart from
 * createLifecycle so unit tests drive the handlers directly without touching process signal state.
 */
export function installLifecycle(options: LifecycleOptions): Lifecycle {
  const lifecycle = createLifecycle({ log: (message) => console.log(message), ...options });
  process.on('SIGTERM', () => void lifecycle.shutdown());
  process.on('SIGINT', () => void lifecycle.shutdown());
  process.on('uncaughtException', (thrown) => {
    console.error('uncaught exception; releasing held tasks', thrown);
    void lifecycle.crash();
  });
  process.on('unhandledRejection', (reason) => {
    console.error('unhandled rejection; releasing held tasks', reason);
    void lifecycle.crash();
  });
  return lifecycle;
}
