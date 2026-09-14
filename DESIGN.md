# DESIGN

A task queue on PostgreSQL, with an HTTP API, a worker harness, and three handlers (`llm`, `js`,
`http`). Delivery is at-least-once.

## 1. Storage: PostgreSQL

I chose Postgres because it lets the claim be a single statement whose correctness the database
guarantees. `FOR UPDATE SKIP LOCKED` means concurrent claimers step over each other's rows instead of
queueing behind them, so there is no application lock, no leader, and nothing to coordinate.

The alternatives the brief allows:

- **SQLite** serialises writers. The concurrency test would pass, but only because the database ran
  the workers one at a time. There would be very little to defend.
- **Redis** can do an atomic claim in Lua, but leases, the DLQ and dedupe windows would each have to
  be built by hand on top of it, and I would then have to argue separately that none of them loses
  data on a restart.

Schema decisions worth knowing about:

- One `tasks` table. The DLQ is a status, not a second table, so dead-lettering and requeue are
  single-row updates.
- A `queues` table holds each queue's retry policy. Every task copies that policy onto its own row at
  enqueue, so the reaper can compute backoff in SQL and changing a policy never re-times work already
  in flight.

## 2. How claim works under concurrency

This is the statement, from `src/store/tasks.ts`:

```sql
WITH claimable AS (
  SELECT id FROM tasks
  WHERE queue_name = $1 AND status = 'ready' AND run_after <= now()
  ORDER BY run_after
  FOR UPDATE SKIP LOCKED
  LIMIT $2
)
UPDATE tasks t
   SET status = 'in_flight', worker_id = $3, claim_id = gen_random_uuid(),
       claimed_at = now(), lease_expires_at = now() + make_interval(secs => $4::numeric / 1000.0),
       attempts = attempts + 1
  FROM claimable c WHERE t.id = c.id
RETURNING t.id, t.type, t.payload, t.attempts, t.claim_id, t.lease_expires_at;
```

Why ten workers calling this at the same instant never receive the same task:

- Every candidate row is either locked by this statement or skipped. There is no third state.
- The race that matters is a row committing to `in_flight` while another claimer is mid-scan. It is
  closed because the `status = 'ready'` predicate sits *inside* the locking subquery. Under
  `READ COMMITTED`, Postgres re-checks that predicate after it acquires the lock, and by then it no
  longer holds.
- The obvious alternative, `UPDATE ... WHERE id IN (SELECT ...)`, is broken. The subquery takes no
  locks, and the outer update re-checks only `id`, so both claimers succeed and the second silently
  overwrites the first. The required test fails against that form and passes against this one.

## 3. Leases

**Duration.** A claim holds a task for 30 seconds. That is the only lease setting: it comes from
`LEASE_MS`, both API and worker read it, and the heartbeat (10 s) and reaper tick (15 s) derive from
it. A third of the lease lets two heartbeats fail before it lapses; half the lease bounds how long an
expired one waits to be noticed. Expiry is always `now()` in Postgres, so worker clock skew cannot
affect it.

**Renewal.** The worker calls `extend` every 10 s per held task. The statement is a compare-and-swap
on task id, worker id and the `claim_id` that claim handed out. The claim id is there because a worker
id alone is not enough: a worker whose lease was reclaimed can later claim the same task again, and its
old execution would then be renewing the new claim. Two rules on top of the CAS:

- Refused once the attempt is older than the execution budget (5 minutes by default). The harness
  enforces the same budget, but the harness is where a bug would live, so the server holds a bound no
  client can stretch.
- Not refused for arriving after expiry but before reclaim. Refusing there would only manufacture a
  duplicate execution.

Zero rows back means the attempt is dead: the harness aborts the handler and sends one fenced terminal
timeout nack, which lands only if the row is still this claim's (the budget case) and is refused
otherwise. No response at all for one lease of local time means the worker assumes it has lost
everything it holds and aborts it, which bounds double-execution under a partition to roughly one and
a third leases, since the check runs on the heartbeat tick.

**Expiry.** Nothing happens at the instant a lease lapses. The row still says `in_flight`, the
`task_state` view already reports `ready` (or `dlq` if attempts are exhausted), and the next reaper
tick makes the row match. The attempt is consumed: a dead worker never nacks, so expiry has to count
or a task that kills its worker would retry forever.

**Recovery.** The reaper runs in the API process on a timer. Claim never reclaims an expired lease
itself; routing it through the reaper is what applies backoff. The recovery query, from
`src/store/reaper.ts`:

```sql
WITH expired AS (
  SELECT id FROM tasks
   WHERE status = 'in_flight' AND lease_expires_at <= now() AND attempts < max_attempts
   FOR UPDATE SKIP LOCKED LIMIT $1
)
UPDATE tasks t
   SET status = 'ready', worker_id = NULL, lease_expires_at = NULL,
       claim_id = NULL, claimed_at = NULL,
       last_error = 'lease expired', failure_kind = NULL,
       run_after = backoff_run_after(t.attempts, t.backoff_base_ms, t.backoff_cap_ms)
  FROM expired e WHERE t.id = e.id;
```

A sibling statement moves expired rows with no attempts left to `dlq`, and a third releases expired
dedupe keys.

## 4. What happens when a worker dies holding a task

A worker is `SIGKILL`ed mid-call at `t=0`, with a 30 s lease and `attempts` now 1:

| Time | What the row says | What is actually true |
|---|---|---|
| `t=0…30` | `in_flight`, held by the dead worker | Invisible to claim. Dead looks exactly like slow; the lease is the only evidence |
| `t=30` | Columns unchanged | The lease has lapsed. The `task_state` view already reports `ready` |
| `t=30…45` | Reaper sets `ready`, clears the claim, sets `run_after` with backoff | Claimable once the backoff passes |
| after backoff | An ordinary claim takes it, `attempts` becomes 2 | Or it moved to `dlq` if attempts were exhausted, where `requeue` resets them |

If the worker's LLM call had already completed and been billed, nothing rolls that back. That is the
at-least-once trade, stated up front.

Graceful shutdown is the fast path through the same states. On `SIGTERM` the harness stops claiming,
drains within a grace window shorter than the lease, and nacks whatever is left as blameless: back to
`ready`, no backoff, no attempt consumed. It can do that because it is alive to ask. A crash cannot,
which is why a crash costs an attempt and a shutdown does not.

## 5. Dispatch and isolation

The harness is a small library the worker process imports. Its loop:

- Register one handler per type, each with a classifier that maps thrown errors to retryable or
  terminal.
- Claim a batch, then look up the handler by `task.type`. No handler registered is a terminal
  failure; waiting will not install one.
- On return, ack with the result. On throw, ask the classifier and nack with its verdict.

Payloads are untrusted input the system then executes, so each handler is isolated according to
its risk:

- **`js`** runs in a forked child process, never in the worker. The child gets a scrubbed environment,
  a heap cap, and a parent-owned `SIGKILL` timeout, and returns its result over IPC. It keeps network
  access on purpose: there is no task chaining, so a script that has to fetch something and transform
  it has nowhere else to do the fetch. The cost is that the SSRF guard below does not cover `js`, and
  the child keeps filesystem access too. Real containment is OS-level: a container or seccomp (§9).
- **`http`** treats SSRF as the threat. It resolves the host, checks every resolved address against
  private, loopback, link-local and metadata ranges, pins the approved address for the connection so
  DNS rebinding cannot swap it after the check, re-validates each redirect hop, and caps response size
  and time.
- **`llm`** sits behind a provider interface with a stub implementation. The stub can be told to fail,
  so the call path, error handling and result capture are real even though no key is involved.

## 6. Retry policy

```
delay = random(0, min(cap, base × 4^attempts))     defaults: base 3 s, cap 5 min, 5 attempts
```

Base, cap and max attempts are per queue. I went with a factor of 4 rather than 2 because with a 3 s
base, doubling burns all five attempts inside about a minute and a half, which is shorter than most
outages. Factor 4 spreads them over five to nine minutes depending on the jitter. The jitter is
full-range because failures are correlated: when a dependency returns `503`, every task hits it at
once, and a fixed curve sends them all back together.

`attempts` is counted on claim, not on nack. A worker that dies never nacks, so counting nacks would
let a task that crashes its worker retry forever. Graceful shutdown (§4) is the one case that hands
the attempt back, capped by a `CHECK` at `max_attempts`, so a task is delivered at most
`2 × max_attempts` times.

Whether a failure is retryable is decided by the handler that saw it, since only it knows its own
error shapes, and sent as `retryable` on the nack body: `POST /tasks/:id/nack { reason, retryable? }`.
With `{ reason }` alone the server could only count, and a `SyntaxError` would retry five times like a
`503`. Omitted, it defaults to true. What each handler's classifier recognises:

| Type | Retryable | Terminal |
|---|---|---|
| `http` | `429`, `5xx`, connection reset, timeout | other `4xx`, SSRF-blocked target, malformed URL |
| `llm` | rate limit, `5xx`, timeout | invalid model, auth failure, content refusal |
| `js` | transport failures in the script's own I/O: reset, refused, `EAI_AGAIN` | `SyntaxError`, thrown errors, non-serialisable result, timeout |

Anything not in the table is terminal, since a wrong terminal call costs a requeue and a wrong retry
hammers a struggling dependency. A terminal nack goes straight to the DLQ whatever the attempt count.

## 7. Idempotency

**Enqueue.** If two enqueues arrive with the same `dedupeKey` within the queue's window (10 minutes by
default), the second returns the id of the first instead of creating a new task. A partial unique
index on `(queue_name, dedupe_key)` enforces it, not a check-then-insert, so two producers racing on
the same key still get one task. The reaper clears the key when the window expires.

**Consumer.** Delivery is at-least-once, so a handler may run more than once for the same task. Each
handler is given the task id, which is stable across attempts, to pass on as an idempotency key to
whatever it calls. The `http` handler does so, as `Idempotency-Key`, unless the payload names its own.
The queue cannot do this part for it: an `http` task that does a `POST` will POST twice if its worker
dies between the request and the ack, unless the receiving end dedupes on that key.

## 8. Assumptions

Decisions the requirements left open, and why they went the way they did:

- **Lease expiry:** consumes an attempt. A dead worker never nacks, so without this a task that kills
  its worker retries forever.
- **`js` retries:** only transport failures in the script's own I/O. The script's logic is
  deterministic given its source and input, so a `SyntaxError` or a throw recurs on the next attempt;
  a reset connection may not. The child reports the two apart, using the same transport allowlist as
  the `http` handler. A script can forge a network error to buy retries, bounded by `max_attempts`.
  Timeout stays terminal because an infinite loop is the likelier cause.
- **`js` payload:** an async function body that receives `input` and returns the result. A function
  body needs no filesystem write, unlike a module, and keeping `input` separate from `source` keeps
  data out of code.
- **Queue creation:** implicit on first enqueue, with a configured default policy; queues named in the
  queues file take their own. No endpoint creates a queue, and declare-on-use is how queues are
  normally managed.
- **Harness transport:** the harness talks to the queue over HTTP, and only the API touches the
  database. Confirmed by the author after the fact; built that way because it makes the required
  endpoints the real interface and the concurrency test end-to-end.
- **Reading results:** `GET /tasks/:id` is added, and `ack` carries the result. Results must be
  retrievable after ack, and no listed endpoint returns one.
- **Nack body:** `{ reason, retryable? }`, defaulting to retryable. See §6.
- **`X-Worker-Id`:** identifies a caller, does not authenticate one. A static header is spoofable, so
  the service assumes a private network.
- **Shutdown versus crash:** a shutdown nack is blameless and refunds the attempt; a crash is not. The
  worker knows a shutdown was not the task's fault; it cannot know that of a crash.

## 9. With another day

- `LISTEN/NOTIFY` to replace polling, for the UI and idle workers.
- Retention policy for succeeded rows, with `fillfactor` and autovacuum tuning.
- Backpressure: a per-queue depth cap answered with `429`.
- Observability: age of oldest ready task, DLQ rate, reaper staleness, etc.
- OS-level sandboxing for `js`, batch `extend`, per-worker credentials.
