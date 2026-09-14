# SPEC — PostgreSQL Task Queue

The full engineering specification of the system as built: a PostgreSQL-backed task queue with an HTTP
API, a worker harness, and three handlers (`llm`, `js`, `http`). Delivery is **at-least-once** (§7 for
why exactly-once is unavailable). The design argument, for one sitting, is [`DESIGN.md`](DESIGN.md);
the schema lives in `migrations/`, quoted here only where the reasoning needs it.

§1 storage · §2 claim · §3 leases · §4 worker death · §5 dispatch/isolation · §6 retry ·
§7 idempotency · §8 API · §9 security · §10 testing · §11 assumptions · §12 roadmap.

## Code structure

One responsibility per file. Unit tests sit beside the code they cover; anything needing a database or
a running server lives under `test/`.

```
harness/                 @aguru/harness — the worker library, a workspace package (zero imports into src/)
  package.json           workspace manifest; no runtime deps, generic over task types
  index.ts               public surface (barrel)
  contracts.ts           ClaimedTask, Handler, Classifier, the QueueClient interface
  failure.ts             the generic Failure primitives (kind is an opaque string)
  clock.ts               injected monotonic clock; tests drive a manual one
  engine/                the runtime machinery
    harness.ts           claim loop and dispatch
    registry.ts          type → handler
    heartbeat.ts         renewal, and the local lease-loss rule (§3)
    idle-backoff.ts      poll backoff when a claim comes back empty
    lifecycle.ts         shutdown and crash handling (§4)
  testing/
    manual-clock.ts      the Clock test double
src/
  config.ts              two loaders: the API's (needs the database) and the worker's (needs only the API URL); shared timing values
  http-queue-client.ts   the HTTP implementation of the harness's QueueClient
  domain/                pure — no I/O, exhaustively unit tested
    task.ts              payload schemas per type, branded task and claim ids
    failure.ts           the closed FailureKind set and the retryability each kind implies (§6)
    cursor.ts            DLQ keyset cursor encode/decode
  store/                 the only directory that imports `pg`
    contract.ts          the exported surface type (§1)
    pool.ts
    tasks.ts             enqueue, claim, ack, nack, extend, requeue, getTask
    reaper.ts            the recovery query and dedupe-window release (§3, §7)
    queues.ts            policy seeding, implicit creation with the default policy, lookup
    stats.ts             the counters
    dlq.ts               paginated listing
  api/
    server.ts            wiring
    reaper-scheduler.ts  the recovery timer; a failing tick is logged and the next still fires (§3)
    routes.ts            the ten endpoints (the nine + GET /queues for the UI)
    validation.ts        edge schemas
    problem.ts           RFC 9457 mapping
    host.ts              the Host-header guard (§9)
  handlers/
    llm.ts               + provider.ts: the interface and its stub
    http.ts              + ssrf.ts: address validation and pinned lookup
    js.ts                + js-child.ts: the forked entrypoint
    network-errors.ts    the transient-transport allowlist shared by http and the js child (§6)
  bin/
    api.ts, worker.ts    thin entrypoints
migrations/
test/                    component and integration tests, including concurrent-claim.test.ts
  helpers/               per-test database from a template, an HTTP server, ensure-then-enqueue
```

Dependencies point inward: `harness/` is the `@aguru/harness` workspace package and imports nothing
from `src/` (it hardcodes no task types); the app consumes it by name — `bin/worker` wires the harness
to a `QueueClient`. Only `store/` imports `pg`; only `handlers/` and `http-queue-client.ts` reach the
network.

## 1. Storage: PostgreSQL via `pg`

Postgres reduces the claim path to one atomic statement the database guarantees correct:
`SELECT ... FOR UPDATE SKIP LOCKED` inside `UPDATE ... RETURNING`. `SKIP LOCKED` makes a claimer step
over rows another transaction holds rather than block on them, so N claimers progress independently.
No application lock, no leader, no coordination.

Rejected:

- **SQLite** — serialises writers, so the concurrency test would pass while demonstrating far less.
- **Redis** — an atomic claim is achievable in Lua, but lease expiry, the DLQ and dedupe windows
  become hand-rolled structures, each needing its own durability argument.

**Tables.** One `tasks` table, DLQ as a status rather than a separate table, so exhaustion and requeue
are single-row transitions. A `queues` table holds per-queue retry policy — seeded from config at
startup, or created on first enqueue with the configured default (A7); each task copies that policy
onto its row at enqueue, so the reaper computes backoff in SQL
without app config and a config change never re-times work in flight.

**Boundary.** `store/` owns every line of SQL and every runtime `pg` import; elsewhere the driver
appears only as the `Pool` *type* in the API's wiring. Swapping databases means rewriting that
directory and the migrations, nothing else. The surface is an exported TypeScript type satisfied
structurally — a compile-time check that the whole contract is implemented, and the entire port
readable in one place.

There is deliberately **no polymorphic `TaskStore` interface**. The operations would port; the
guarantees would not. `claim`'s real contract — no two concurrent callers receive the same task — is
Postgres's `SKIP LOCKED`, SQLite's serialised writers, or Redis's Lua-plus-durability. An interface
would advertise a substitutability that doesn't exist; correctness *is* the database's concurrency
semantics, so the two stay behind one boundary.

The harness's `QueueClient` *is* an interface, for the opposite reason: it is a seam that genuinely
varies. The harness's unit tests substitute a fake through it, as they do for the clock and the LLM
provider, and it keeps A9 (the harness speaks HTTP) cheap to reverse. Only the HTTP implementation
ships; an in-process one would be speculative.

## 2. Claim under concurrency

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

Every candidate row is locked by this statement or skipped, so two workers can't receive the same row.
One statement, no explicit transaction.

The simpler form — `UPDATE ... WHERE id IN (SELECT id ... WHERE status = 'ready' LIMIT n)` — is broken
under contention: the subquery takes no locks, two claimers select the same ids from the same
snapshot, and the loser's `UPDATE` re-checks only `id` after blocking, which still matches. Both
"succeed", the second silently overwriting the first. Putting the whole predicate inside the locking
subquery makes the post-lock re-check re-test `status`; `SKIP LOCKED` makes the losers wait-free
instead of queued.

**Isolation.** Correct under `READ COMMITTED`, the default. Under `REPEATABLE READ` the same statement
raises serialization failures under contention and would need a retry loop.

**Two deliberate omissions from the predicate:**

- *No expired-lease reclaim* — the reaper does that, with backoff (§3); leaving it out keeps the
  predicate sargable against one partial index.
- *No `attempts < max_attempts` test* — a `CHECK` guarantees no `ready` row is exhausted, so the
  invariant is enforced once by the database, not per query.

`CHECK` constraints extend the principle: `in_flight` requires a non-null lease, worker, claim id and
claim time; `dlq` requires a non-null `failed_at`. No row can enter a state the reaper, the DLQ
listing or the state view can't see.

**A short batch is not an empty queue.** Locked rows are skipped beneath the `LIMIT`, so a claim comes
back short only when unlocked eligible rows run out — under contention, because other claimers hold
them. The harness treats only an empty result as idle; reading a short batch as idle would park a
worker with work pending.

**Ordering is approximate FIFO, promised as nothing more.** `ORDER BY run_after` states the intent, but
`SKIP LOCKED` can take a later row while an earlier one sits locked, and at-least-once redelivery
reorders anyway — a strict-FIFO promise on a concurrent queue of this kind would be false. Ties are
left unordered rather than widening the hot index for a tiebreaker nothing reads.

**`attempts` increments at claim, not at nack.** A killed worker never nacks, so counting nacks alone
retries a worker-killing task indefinitely. Cost: a task whose worker died for unrelated reasons burns
an undeserved attempt — bounded retries on poison tasks is the safer failure mode.

**`stats` derives from a view.** Counting the claim predicates back leaves a task with an expired lease
*and* exhausted attempts in no bucket. A `task_state` view maps every row to an effective state;
`stats` uses index-backed counters that never touch succeeded history, pinned to the view by test.
`ready` counts everything that becomes claimable without intervention, including tasks still on `delay`
or backoff, so it can be non-zero while `claim` returns nothing (A18).

## 3. Lease model

| Parameter | Value | Derivation |
|---|---|---|
| `leaseMs` | 30 s | The single configured knob — set identically in API and worker; a mismatch silently widens the §3 abort bound |
| Heartbeat | 10 s | `leaseMs / 3` — two renewals may fail before expiry |
| Reaper cadence | 15 s | `leaseMs / 2` — bounds how long an expired lease waits |

Heartbeat and reaper cadence are derived, not configured, so no configuration can express a broken
relationship between them.

**Renewal is a compare-and-swap on the claim, not just the worker:**

```sql
UPDATE tasks SET lease_expires_at = now() + make_interval(secs => $3::numeric / 1000.0)
 WHERE id = $1 AND worker_id = $2 AND status = 'in_flight'
   AND claimed_at > now() - make_interval(secs => $4::numeric / 1000.0)
   AND ($5::uuid IS NULL OR claim_id = $5)
RETURNING lease_expires_at;
```

Each claim stamps the row with a fresh `claim_id` and returns it; `ack`, `nack` and `extend` echo it
(optional on the wire — §8; a null `$5` is the worker-only match, and the harness always sends the id). Matching
`worker_id` alone isn't enough: a worker whose lease was reclaimed mid-execution can later claim the
same task back, and the stale execution's heartbeat, ack or nack would then land on the new claim. A
claim id never repeats, so a stale execution's writes match zero rows whatever has happened to the task
since — forgiveness, requeue and re-claim included (A20). The fence guards against stale executions,
not access: the token is optional on the wire (§8) and the spoofable header stays the only credential,
so the security boundary remains §9's private network, not this UUID.

There is no `lease_expires_at > now()` condition. Reclaim rewrites `worker_id`, so the CAS is already
sufficient; refusing a renewal from a worker a moment past expiry but not yet reclaimed would only
manufacture a duplicate execution. Zero rows means the attempt is dead — reclaimed, or over the budget
below — and the harness aborts the handler through its `AbortSignal`; for a refused renewal it also
sends one fenced terminal `timeout` nack (see below) unless the task has already settled locally; the
nack lands only if the row is still this claim's.

The `claimed_at` bound is the opposite call: renewal is refused once the attempt is older than
`maxTaskExecutionMs` (default 5 minutes). A renewal accepted just inside that bound grants a full
lease, so the server-side ceiling on one attempt is `maxTaskExecutionMs + leaseMs`, 5 min 30 s by
default. The harness enforces that budget itself (§4), but the harness
is the process the bug lives in — a wedged one would heartbeat a stuck task forever, and no client may
extend an attempt without limit. The refusal aborts the handler and sends one fenced terminal nack,
kind `timeout`: it lands only if the row is still this claim's (the budget case) and is refused
otherwise (the row was reclaimed), so a timed-out task reaches the DLQ rather than being requeued as
retryable when its lease lapses. A harness too broken to do even that is reclaimed one reaper tick
after the lease lapses (A13).

**A worker that cannot reach the API assumes it has lost its leases.** A renewal that errors, as opposed
to one that returns zero rows, says nothing about ownership, so the harness aborts every held task once
`leaseMs` of local monotonic time has passed without a successful renewal, checked at each heartbeat
tick, so the loss registers between `leaseMs` and `leaseMs + leaseMs/3` (40 s by default) after the
last success — elapsed duration on one clock, not a comparison against a server timestamp, so skew
can't affect it. It bounds the window in which a partitioned worker and its replacement both execute
to roughly one and a third leases (A19).

**Postgres is the sole authority on time.** Every expiry decision is `now()` evaluated in the database.
Worker clocks disagree with each other; the database can't disagree with itself. The injected `Clock`
drives heartbeat cadence only, and must never subtract a local timestamp from a server-returned
`leaseUntil` — that difference is skew, not duration.

**The recovery query.** The reaper runs on a `leaseMs / 2` timer in the API process, the only one that
holds a database connection, since the harness speaks HTTP (A9). It reuses claim's `SKIP LOCKED` +
`LIMIT` shape, so several API instances partition the work rather than contend. Expired leases with
attempts remaining return to `ready` with backoff; exhausted ones move to the DLQ; the same tick
releases expired dedupe keys (§7). Recovery depends on the API being up, already true of every claim.

The tick guards itself: a failure is caught so the next still fires, each tick drains in `LIMIT`-sized
batches until a short batch so a mass death clears in one pass, and the time of the last completed tick
is exposed on the health endpoint. Recovery infrastructure that fails silently is the one failure the
lease model cannot see, so the reaper is the one component made to report its own liveness.

```sql
-- retryable: back to ready, backoff computed from the row's own policy columns
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

-- exhausted: to the DLQ
WITH exhausted AS (
  SELECT id FROM tasks
   WHERE status = 'in_flight' AND lease_expires_at <= now() AND attempts >= max_attempts
   FOR UPDATE SKIP LOCKED LIMIT $1
)
UPDATE tasks t
   SET status = 'dlq', failed_at = now(), worker_id = NULL, lease_expires_at = NULL,
       claim_id = NULL,
       failure_kind = 'lease_expired', last_error = 'lease expired; attempts exhausted'
  FROM exhausted e WHERE t.id = e.id;
```

`backoff_run_after` is a SQL function, so §6's curve has exactly one definition, shared by this path and
`nack`. There's no TypeScript copy: a second would drift and the reaper couldn't use it anyway, so it's
tested by calling the function itself. (The harness's *idle* backoff, a different curve, is TypeScript
and unit tested.) Routing reclaim through the reaper is what applies backoff: reclaiming directly in
`claim` makes a task that OOM-kills its worker instantly re-claimable, so it kills the next worker as
fast as the fleet can claim it.

**Heartbeat racing the reaper is safe.** Both take the row lock. Reaper wins: the heartbeat blocks,
re-checks its `WHERE` against the committed row (`READ COMMITTED`), and matches zero rows. Heartbeat
wins: the reaper skips the still-locked row (`SKIP LOCKED`) or its re-check sees the renewed lease.
Every interleaving leaves exactly one owner.

**Renewal is also the hottest write in the system**, so no index covers `lease_expires_at` or
`worker_id`: each heartbeat is then a heap-only-tuple update that touches no index at all. The reaper
pays for that, filtering the `in_flight` partial index for expired leases — the right side of the
trade, since heartbeats outnumber reaper ticks by orders of magnitude.

## 4. When a worker dies holding a task

Worker `SIGKILL`ed mid-`llm` call at `t=0`, `leaseMs` = 30 s:

| Time | State |
|---|---|
| `t=0` | `in_flight`, `worker_id=w1`, lease to `t+30`, `attempts=1`. No nack or heartbeat will follow |
| `t=0…30` | Invisible to `claim`, reported `in_flight`. The system cannot distinguish a dead worker from a slow one, and the lease is its only evidence |
| `t=30` | Lease lapses. `task_state` already reports `ready` — or `dlq` if attempts are exhausted. The row's columns are stale; its effective state is not |
| `t=30…45` | A reaper tick sets `ready`, clears the lease, applies backoff. Had `w1` been partitioned rather than dead, it aborts its own execution at `t≈30` by the local rule in §3, and any later ack it sends is fenced out by its stale `claim_id` |
| after backoff | An ordinary claim takes it; `attempts` becomes 2 |

If attempts were exhausted, the reaper moves it to the DLQ with `failed_at`, where
`POST /tasks/:id/requeue` replays it. Requeue resets the attempt count (per the brief); so does
`attempts_forgiven` — a task requeued at the forgiveness cap must be forgivable again — and
`failed_at`, `failure_kind` and `last_error` are cleared, so the row re-enters `ready` clean with its
DLQ lineage in the logs rather than on the live row.

The in-flight LLM call may have completed and been billed. Nothing rolls that back — the at-least-once
trade.

**Graceful shutdown** optimises this path, it doesn't replace it. On `SIGTERM` the harness stops
claiming, keeps heartbeating, drains, then nacks the remainder as blameless, so redelivery costs
milliseconds rather than a full lease: back to `ready`, no backoff, no attempt consumed — the worker
knows the task was blameless, unlike a crash. Forgiveness is capped by a `CHECK` (a decrement reachable
from an unauthenticated endpoint is otherwise an unbounded retry); at the cap a forgiving nack degrades
to an ordinary counted one rather than erroring, so a fleet in a restart loop spends attempts instead of
surfacing constraint violations. Total bound: `2 × max_attempts` deliveries — forgiving every failure
buys one extra ladder, never an unbounded one.

**The API dies, or a connection drops mid-statement.** Every store operation is a single autocommit
statement, so it either committed or did not. A claim whose response is lost lapses to the reaper
like any other expired lease. A lost ack or nack response is resolved by the worker's next renewal:
if the settle committed the row is no longer `in_flight` under this claim, `extend` returns nothing,
and the harness abandons the task. If the settle never committed, renewals continue until the budget
refuses them and the reaper requeues the task. A dead API stops every worker's renewals at once;
each aborts its held tasks after a lease of local time, and when the API returns the reaper requeues
them.

**A crashing worker damages its neighbours.** A task that kills the worker *process* — not just its
handler — takes every other in-flight task on that worker down with it; each loses its lease and burns
an attempt for a fault that wasn't theirs. At concurrency 10, one crash-looping task damages nine
innocents per cycle until it exhausts its own attempts. Three bounds, one accepted case:

- **The dominant vectors are already isolated** — arbitrary `js` runs in a forked child (§5), and
  `http` response bodies stream to the 256 KiB cap (§8) rather than buffering — so the two obvious
  payload kill-paths are closed before this matters.
- **Best-effort blameless release on crash** — `uncaughtException` and `unhandledRejection` handlers
  nack every held task retryable and attempt-free, exactly as shutdown does, then exit non-zero: "N
  tasks lose leases and burn attempts" becomes "N immediately reclaimable, blameless".
- **`concurrency` defaults low (4)** — it's the blast radius, so raising it is a deliberate act.
- **Accepted:** `SIGKILL` and OOM-kill run no handler, so those tasks fall back to lease expiry and do
  consume an attempt — the at-least-once cost, bounded by the measures above rather than eliminated.

**The failure a lease cannot detect** is a worker that's alive and stuck — a request accepted and never
answered, heartbeating faithfully forever. Worker liveness isn't task progress, so the harness enforces
`maxTaskExecutionMs` independently of any payload timeout, and every handler receives an `AbortSignal`
(without real cancellation, a timeout abandons a promise that keeps its socket and memory). The server
holds the independent backstop — `extend` refuses renewal past the same budget (§3) — so the bound
survives a harness too broken to enforce it.

## 5. Dispatch and handler isolation

A registry maps `type → handler`. An unregistered type is terminal, since waiting won't install one.
`concurrency` bounds handlers in flight, and claim `max` is the free-slot count — claiming beyond
capacity holds leases on work that hasn't started.

**`js` — forked child process.** In-process, `while(true){}` blocks the event loop and stalls every
heartbeat the worker owes, and the script would see `process.env` and the connection pool. The child
gets a scrubbed environment, a memory cap and a parent-owned timeout, and communicates over `fork`'s
IPC channel rather than stdout framing (a single `console.log` would corrupt that). The inspector's
SIGUSR1 trigger is disabled, so a script cannot open a debugger port on loopback; `--disable-sigusr1`
needs Node 22.14 or later, which is the project's floor. `node:vm` is not a security boundary;
`worker_threads` isolates CPU but not credentials.
The child keeps network access deliberately: there is no task chaining, so a script that must fetch and
transform has nowhere else to do the fetch, and its transport failures are classified like `http`'s
(§6). *Residual:* a forked child retains filesystem access and unguarded network access, and a parent
killed with `SIGKILL` can't kill its child — the orphan is reparented, a busy loop never notices the closed IPC channel, and
an in-child watchdog is blocked by the very loop it would police, so a hostile script can outlive its
worker, memory-capped but with nothing bounding its CPU or lifetime. That network access is also why
the SSRF guard below bounds only `http` — a `js` payload can issue any request the host can.
Containment for `js` is the OS layer: Node's `--permission` flags would close the filesystem half
without native code; real containment, orphans included, needs a container's PID namespace or
seccomp/cgroups.

**`http` — SSRF is the threat.** Resolve the host, validate every resolved address against the denied
set, and pin the chosen address via a custom `lookup`, so DNS rebinding can't swap it after the check.
The denied set is private, loopback, link-local (where the cloud metadata address lives),
carrier-grade NAT, unspecified, multicast and reserved space in both address families, plus unique-local
IPv6 and the IPv4-mapped and IPv4-compatible IPv6 forms — the last two are how a literal such as
`::ffff:169.254.169.254` walks past a guard that only knows dotted quads. Redirects are followed
manually so each hop is validated (`fetch`'s automatic follow would walk past the guard on hop two).
Pinning by rewriting the URL to the IP is rejected — it breaks TLS certificate validation. Only `http`
and `https`; a URL carrying credentials is rejected; redirects cap at five hops; the request runs under
a payload timeout bounded above by `maxTaskExecutionMs`.

**`llm` — behind a provider interface**, stubbed by default, with injectable failures so §6's retry
paths are testable.

## 6. Retry policy

Exponential with full jitter — base and cap configurable per queue, factor fixed at 4:

```
delay = random(0, min(cap, base × 4^attempts))     base 3 s, cap 5 min, 5 attempts
```

The ladder must span a real outage, not a blip: successive draws come from [0, 12 s), [0, 48 s),
[0, 192 s), [0, 5 min), so the default budget stretches across several minutes and the cap genuinely
binds on the last delay. The reflexive curve — factor 2 on a 1 s base — spends every attempt inside
~30 seconds, dead-lettering a whole queue during a two-minute `503` and leaving the cap as decoration.
Jitter is full-range because the failures that matter are correlated: a dependency returning `503` is
failing for every task at once, and a deterministic curve marches them back in lockstep onto a service
attempting to recover.

| Type | Retryable | Terminal |
|---|---|---|
| `http` | `429`, `5xx`, connection reset, timeout | other `4xx`, SSRF-blocked target, malformed URL |
| `llm` | rate limit, `5xx`, timeout | invalid model, malformed request, auth failure, content refusal |
| `js` | transport failures in the script's own I/O (the `http` allowlist: reset, refused, `EAI_AGAIN`, …) | `SyntaxError`, thrown errors, non-serialisable result, timeout kill, OOM |

Retry only what a later attempt could plausibly resolve: a `4xx` will be wrong again, a `SyntaxError`
won't parse differently in 30 seconds. Unclassified exceptions default to terminal — the DLQ is visible
and replayable, so a wrong terminal call costs a requeue, whereas retrying an unreasoned error
amplifies an unknown failure against a dependency. `nack` acts on the classification: a terminal
failure moves to the DLQ regardless of attempts; counting attempts alone would make this table
decorative.

**The taxonomy is a closed set**, stored as `failure_kind` on the row rather than free text in
`last_error`: triage needs to tell a bad payload from a dead dependency without parsing prose, and a
free-text column can't be grouped or counted.

| `failure_kind` | Meaning | Retryable |
|---|---|---|
| `handler_error` | The handler threw; the type's classifier judged it transient | yes |
| `handler_terminal` | The handler threw; classified as permanent | no |
| `unclassified` | Nothing matched, so the §6 default applied | no |
| `timeout` | Exceeded `maxTaskExecutionMs`, the harness budget. A handler's own payload timeout is a thrown error, classified per type — retryable for `http`/`llm`; `js` deliberately maps its payload timeout here too, since an infinite loop is the likelier cause (A2) | no |
| `lease_expired` | Reclaimed by the reaper: requeued with backoff while attempts remain, dead-lettered otherwise; provenance, not a verdict | — |
| `result_too_large` | Succeeded, but a `js` or `llm` result exceeded the stored cap; `http` truncates instead | no |
| `no_handler` | No handler registered for the task's type | no |
| `worker_shutdown` | Drained at shutdown; blameless, consumes no attempt | yes |

Each handler exports a classifier from thrown value to `{ kind, retryable, message }` — the single
place retryability is decided, pure and exhaustively unit tested, which is why the table above is
testable rather than aspirational.

## 7. Idempotency, end to end

**Enqueue.** Two enqueues with the same key within a window collapse to one task, so the window governs
rather than liveness: a task deduplicates a resubmission until its window lapses, whatever state it's
reached. A resubmission doesn't extend the window (the collapse is a no-op), so the window runs once,
from the first enqueue (A4). Only window expiry releases a key, and that's the reaper's job: each tick
nulls `dedupe_key` where `dedupe_expires_at` has passed, so a key outlives its window by at most one
tick. The unique index needs no time term, and enqueue stays one statement.

One consequence: resubmitting work whose original permanently failed returns the existing dead task's
id, not a new task. `GET /tasks/:id` exposes its state and `POST /tasks/:id/requeue` replays it. Keeping
the key also makes a requeue collision impossible — only one row can hold a given key.

`dedupeKey` is enforced by a partial unique index, not a read-then-write that would race. The insert
uses a no-op `ON CONFLICT DO UPDATE`, not `DO NOTHING`: `DO NOTHING` returns no row on conflict, so the
existing id costs a second statement, and between the two the reaper could release the key. The
simultaneous-enqueue race is safe either way (verified against real Postgres: the second insert blocks
on the first's speculative insertion until it commits). `xmax = 0` distinguishes `201` from `200`, and
both callers receive the same id.

**Consumer.** At-least-once means a handler can run twice, so effect-uniqueness is the handler's
responsibility. `task.id` and `attempts` are passed in so an idempotency key can travel downstream. The
`http` handler sends it as `Idempotency-Key` unless the payload supplies its own. An `http` task
issuing `POST` is not automatically safe.

**Why exactly-once is unavailable.** Acking and performing the side effect are writes to two systems
with no atomic commit between them. A crash after the side effect but before the ack is
indistinguishable from a crash before it. Ack first and risk dropping work, or act first and risk
repeating it — this queue acts first. Exactly-once *effects* remain reachable, but only by making the
consumer idempotent.

## 8. API contract

Errors are RFC 9457 problem+json. `type` identifies the problem where a status code can't: `409` covers
both a lapsed lease and a task not in the DLQ.

| Code | Used for |
|---|---|
| `400` | Body does not parse |
| `404` | Unknown task or queue |
| `409` | Lost lease, or a requeue of a task not in the DLQ |
| `413` | Payload over cap |
| `422` | Body parses but fails validation |

`claim`'s `max` is bounded by the deployment's `CLAIM_MAX_LIMIT` (default 100) and a request above it is
`422`, not clamped: the caller learns the bound.

`GET /tasks/:id` returns `200` or `404`. `GET /queues` returns the queue names for the UI's list (A22).

`X-Worker-Id` is required on the worker surface only: `claim` and the ownership assertions
`ack`/`nack`/`extend` (a missing or malformed header there is `400`). Producers, the reads and requeue
send none. On `ack`/`nack`/`extend` it is the ownership credential — `worker_id` is matched against
the row; `claim` and `extend` carry `workerId` in their bodies per the brief, and each must agree with the
header (`422` otherwise), so a claim is never taken under an identity other than the one that will
have to ack it. All three assertions accept an optional `claimId` from the
claimed task as §3's fence — the harness always sends it, and a caller that omits it gets the
worker-only match the brief describes (A20). No read endpoint returns `claim_id`: the token exists only
in the claim response, so the ability to read a task never confers the ability to ack, nack or extend it.

`409` rather than `404` on a lost lease: the task exists, so `404` would be false — what's gone is the
caller's claim on it. A retried `ack` whose first attempt landed finds the task `succeeded` and also
gets `409`; ack isn't idempotent over retries and needn't be, since either way the caller has released
the task and at-least-once already covers the ambiguity. An empty claim returns `200` with an empty
array rather than `204`, so clients parse a single shape. `claim` doesn't `404` on an unknown queue
(unlike `stats` and `dlq`): it's the highest-frequency endpoint, the foreign key already makes an
unknown queue indistinguishable from an empty one to a worker, and the check would cost a lookup per
poll.

**Two additions to the listed surface, both resolving contradictions within the brief rather than
departing from it.**

`GET /tasks/:id` → `200` with the task and its `result`, `404` otherwise, and `ack` carries `{ result }`
so the harness can deliver one over HTTP. The brief requires a result be "retrievable after ack" and
lists no endpoint that returns one; persisting a result nothing can read satisfies the letter and
defeats the purpose.

`POST /tasks/:id/nack` takes `{ reason, retryable? }`. As listed the server sees only prose, can't
distinguish a `503` from a `SyntaxError`, and can only count attempts — which makes §6's classification
decorative and leaves the brief's explicit "decide where that line sits" unanswered in behaviour. The
flag is set by the handler's classifier, because the handler's author is the only party who knows that
domain's error shapes; moving the decision server-side would force the API to learn every handler's
taxonomy and go stale whenever one changed. Omitted, `retryable` defaults **true**: a client using the
brief's own `{ reason }` shape must get the brief's own behaviour — retry with backoff until attempts
exhaust — so terminal is opted into by a classifier that knows the error, never inferred from silence.
The body also accepts `forgiveAttempt` (§4's blameless release, inherently a retryable nack; combined
with `retryable: false` it self-contradicts and is `422`) and an optional `kind` from §6's closed set
(the classifier's verdict would otherwise die at the API; omitted, it derives from the flags —
`worker_shutdown` when forgiven, else `handler_error` or `handler_terminal` by `retryable`).
When `kind` is present it must agree with `retryable` (`422` otherwise), so a row can never be
labelled terminal and sit in `ready`; since `retryable` defaults true, a terminal kind must be sent
with `retryable: false` explicitly, which the harness always does.

Payloads are a discriminated union validated at the edge, unknown fields rejected so a typo fails
loudly. Results are capped at 256 KiB stored. An `http` response body is streamed and cut at that cap —
counted after decompression, so a small gzipped body can't inflate past it — then flagged `truncated`,
since a partial body is still useful. A `js` or `llm` result over the cap is terminal (the work
happened but won't fit, and a retry would only repeat it): the API refuses the oversized `ack` with
`413`, and the harness answers with a terminal nack, `kind = result_too_large`. The DLQ listing returns
triage fields only (no `payload`/`result` — read those via `GET /tasks/:id`) and paginates by keyset on
`(failed_at, id)`, since requeueing while reading is the expected usage and offset pagination silently
skips rows when the set shifts underneath.

## 9. Security

Payloads are untrusted input the system then executes, so handler containment (§5) is the principal
control. At the edge: schema validation, bounded payload and batch sizes, and parameterised SQL
throughout. The database role would be least-privilege in production; the dev compose runs the image's
bootstrap role — a stated residual, not a claim. The compose file publishes Postgres on loopback
only, so the bootstrap credentials are reachable from the developer's machine and nowhere else.
Payloads, results and handler error messages are never logged, since they carry prompts, response
bodies, script source and potentially PII; a process crash logs the fatal error in full. What is
logged: the worker writes one line per ack or nack it delivers (a fenced-out settle writes none) —
task id, type, attempt, and for a nack the failure kind and whether it retries; the API writes one
line per failed reaper tick and one per internal error (method, route pattern and error class, never
the message). Secrets (a provider key, the database URL) come from the environment only: they are
never written to a task row, and never appear in an error response, which carries a problem code and
a bounded detail string.

Auth is a static `X-Worker-Id` header (the brief's non-goal). It identifies a caller; it does not
authenticate one. Despite the name it is a caller identity, and it does real work only on the worker
surface — `claim` and the ownership assertions `ack`/`nack`/`extend`, where `worker_id` is matched
against the row so one worker cannot act on another's task. It is required there and nowhere else:
producers (enqueue), the UI (reads, requeue) and `/healthz` are not workers and send no id. A
missing or malformed header on a worker endpoint is a `400`. With naming freedom it would be
`X-Caller-Id`, but the brief fixes the name; because it is spoofable it stops no hostile caller
regardless. **The service therefore assumes a private network and must not be internet-exposed.**
Two controls narrow the browser-facing surface the UI adds: the API rejects any request whose `Host`
header is not loopback or an `ALLOWED_HOSTS` entry (a 400 before any handler), so a hostile page
can't use DNS rebinding to reach the local API as same-origin; and the DLQ *listing* projects only
triage fields — `payload` and `result`, which may carry prompts, URLs, script source or PII, come
only from `GET /tasks/:id`, which any caller on the private network can read given the task's
unguessable id; they are not part of the listing every dashboard viewer loads. A reverse proxy
forwarding a public hostname must name it in `ALLOWED_HOSTS`. Payloads and results are stored as
plaintext `jsonb`; encryption at rest is the next step if they ever carry sensitive data. The `http`
handler sends the task id as `Idempotency-Key` to the target and to every redirect hop, so a target
on the private network learns an id it could read back through `GET /tasks/:id`; stated as a
residual.

## 10. Testing

**Test-first, and unit-heavy.** Every behaviour is driven by a failing test written before the
implementation. The weight sits on unit tests because most of this system's difficulty is decidable
without a database — backoff curves, retryability classification, cursor encoding, the harness's
claim/dispatch/heartbeat/shutdown state machine, handler error mapping. Component and integration tests
are used where they earn their cost.

| Level | Covers | Why at this level |
|---|---|---|
| **Unit** | Domain logic, harness state machine, error classification, handler behaviour against fakes | No I/O needed, so they run in milliseconds and can be exhaustive about edge cases |
| **Component** | One module against real collaborators — `store/` against Postgres, a handler against a local server or stub provider | The seam is where the assumptions live; a mock here would test the mock |
| **Integration** | API + store + harness together over HTTP | Concurrency, leases and recovery are properties of the whole, not of any part |

Anything asserting a *concurrency* property must be integration-level against real Postgres, because the
behaviour under test **is** Postgres behaviour — `SKIP LOCKED`, `READ COMMITTED` re-checks, row-lock
ordering. A unit test of the claim path would test a fiction.

**Isolation** uses a template database: migrations run once, then each test takes its own
`CREATE DATABASE ... TEMPLATE`, a filesystem copy on the order of 10 ms, so tests parallelise freely.
Transaction-rollback isolation is rejected — faster, but it changes the locking semantics `SKIP LOCKED`
tests depend on, so a pass would prove nothing. Lease expiry is tested with genuinely short leases
rather than a mocked clock, since Postgres owns `now()`; the injected `Clock` keeps heartbeat and
backoff scheduling testable without real waiting.

**One named test per invariant:** no double-claim under contention; automatic recovery from an expired
lease; terminal errors reaching the DLQ immediately; attempts bounded including forgiveness; `stats`
counters equalling the state view; duplicate enqueues collapsing; a dedupe key freed at window expiry;
requeue resetting attempts and forgiveness; a heartbeat racing the reaper leaving exactly one owner; a
renewal past the execution budget refused; a stale execution unable to ack a task its worker has since
re-claimed. A fix, once made, stays made.

`concurrent-claim.test.ts` runs over HTTP: 50 tasks across all three types, four concurrent
claim-and-process loops, each recording start and end timestamps per task. It asserts every task is
processed at least once and that no task's processing intervals overlap — weaker than "processed exactly
once", deliberately, since at-least-once permits sequential reprocessing after a lease expiry.
Two properties make it a proof rather than a likelihood. The span is the hold interval, from the
claim response to the ack response, so two claimants of one task overlap by construction whatever
their sleeps do; and it is recorded whether or not the ack succeeded, since gating on the ack would
let the claim-id fence hide a double-claim. Because the run takes about two seconds against a 30 s
lease, no legitimate redelivery is possible, so the test also asserts exactly one span per task.
Checked by running it against the broken `UPDATE ... WHERE id IN (SELECT ...)` form: it fails every
time.

## 11. Assumptions and open questions

Each entry is classified, since the kinds carry different weight:

- **Gap** — the brief is silent; something had to be chosen.
- **Delegated** — the brief explicitly hands the decision over.
- **Departure** — a deliberate divergence from the brief's literal reading. The register contains none.
- **Extension** — the brief contradicts itself, and this is the reading chosen. Declared, not silent.
- **Confirmed** — a reading the author has since confirmed in writing. Kept in the register so the
  reasoning stays with the decision.

Decisions the brief specifies are not listed here; they are compliance and appear in the body.

| # | Kind | Assumption | Reasoning |
|---|---|---|---|
| A1 | Gap | A lease expiry consumes an attempt | The brief's retry language addresses handler failure only, and a dead worker never nacks. Otherwise a task that kills its worker retries forever |
| A2 | Delegated | `js` failures are terminal except transport failures in the script's own I/O, which retry; timeout is terminal | The brief gives `SyntaxError` as its example and asks where the line sits. The script's logic is deterministic given source and input, so a compile error or a throw recurs; its I/O is not, and with no task chaining a script has to do its own fetching, so a reset or refused connection is classified by the same allowlist as `http`. A script can forge a network error to buy retries, bounded by `max_attempts`. Timeout stays terminal: an infinite loop is the likelier cause, and retrying hostile CPU burn is the worse error |
| A3 | Delegated | Unclassified errors default to terminal | Same delegation. A requeue is cheaper than amplifying an unknown failure against a struggling dependency |
| A4 | Gap | The dedupe window is per queue, 10 minutes by default (`dedupe_window_ms`, `QUEUE_DEDUPE_WINDOW_MS`), measured from the first enqueue and independent of the task's state | A window is specified, no duration. Ten minutes absorbs a retrying producer without suppressing legitimate repeat work. Time-based rather than held-while-live because "within a window" is what was specified, and holding the key for a task's lifetime would make a resubmission of a dead-lettered task collapse silently until someone requeued it |
| A5 | Gap | `delay` is relative milliseconds | No units given. Node convention; absolute timestamps invite clock skew |
| A6 | Delegated | A deduplicated enqueue returns the existing id with `200`, versus `201` | The brief explicitly delegates status codes and error shapes. Idempotent means the same answer, not an error |
| A7 | Gap | Queues are implicit on first enqueue, taking the API's default policy (`QUEUE_*` environment, defaults 5 attempts / 3 s / 5 min / 10 min); queues named in `QUEUES_FILE` are seeded with their own at startup. The schema carries no policy defaults, only the `CHECK` | Nothing in the brief creates or configures a queue. Declare-on-use is the established model — AMQP declares queues from client code, and operator-created queues do not survive contact with scale. Policy is operational tuning, so it lives with the other environment knobs and changes per deployment without a migration; a DDL default would need one and would only reach rows created afterwards. Config belongs in version control, not in a UI. Cost: a mistyped name becomes a real queue, and an implicit queue's policy is fixed at creation |
| A8 | Gap | The `http` handler refuses private, loopback and metadata addresses, allowlisting loopback in dev and test | The brief is silent on hostile URLs. An added bound of the same kind as the response-size cap and request timeout; without the dev allowlist the required test could not target anything |
| A9 | Confirmed | The harness speaks HTTP, behind a `QueueClient` interface; only the API process touches the database | The brief describes a library and separately specifies the endpoints without saying which the harness uses. HTTP makes the required surface real rather than UI decoration, and makes `concurrent-claim.test.ts` a genuine integration test. Confirmed by the author on 2026-09-14: workers call `claim`, `ack`, `nack` and `extend` over HTTP, and only the API service touches the database directly |
| A10 | Delegated | The UI polls `stats` every 2 s | "Polling or SSE — your call." SSE without `LISTEN/NOTIFY` is polling with a connection lifecycle attached |
| A11 | Delegated | RFC 9457 errors; `400` unparseable, `422` invalid | The brief explicitly delegates shapes and codes, subject to consistency |
| A12 | Gap | `js` `source` is an async function body taking `input`; non-serialisable returns are terminal | The calling convention is undefined; module semantics would require a filesystem write |
| A13 | Gap | `maxTaskExecutionMs` bounds every attempt: enforced by the harness, and independently by `extend` refusing renewal past it | Unaddressed by the brief. A lease measures worker liveness, not task progress — and the harness is the process the bug lives in, so the server holds a bound no client behaviour can stretch |
| A14 | Gap | A shutdown nack does not consume an attempt; a crash does | Graceful shutdown is unaddressed. The worker knows a shutdown was blameless; it cannot know that of a crash |
| A15 | Gap | `X-Worker-Id` is required only on the worker surface — `claim`, `ack`, `nack`, `extend` — not on enqueue, the reads, requeue or `/healthz` | Despite the name the brief gives it, it is a caller identity that does ownership work only where a worker asserts on a task it holds. Producers and the UI are not workers, so demanding a worker id from them conflates the roles; a missing header on a worker endpoint is a `400`. With naming freedom it would be `X-Caller-Id`, but the brief fixes the name |
| A16 | Extension | `GET /tasks/:id` is added to the listed surface, and `ack` carries `{ result }` | Results must be "retrievable after ack", yet no listed endpoint returns one. Persisting a result nothing can read satisfies the letter and defeats the purpose (§8) |
| A17 | Extension | `nack` takes `{ reason, retryable?, forgiveAttempt?, kind? }`, defaulting to retryable when omitted | As listed, the server sees only prose and can only count attempts, making the per-type classification it explicitly asks for unobservable in behaviour (§8) |
| A18 | Gap | `stats.ready` includes tasks waiting on `delay` or backoff | The brief has three buckets and a scheduled task belongs to neither of the other two; it becomes claimable without intervention. Cost: `ready` can be non-zero while `claim` returns nothing |
| A19 | Gap | A worker aborts its held tasks between one and one-and-a-third `leaseMs` of local time (checked per heartbeat tick) without a successful renewal | A renewal that errors says nothing about ownership. Without this rule a worker partitioned from the API executes indefinitely alongside its replacement |
| A20 | Extension | `claim` returns a per-claim `claimId`; `ack`, `nack` and `extend` accept it as an optional fence | Matching `worker_id` alone lets a worker's stale execution act on a task it has since re-claimed. A fresh UUID per claim never repeats, so the fence holds through forgiveness, requeue and re-claim with no monotonicity argument; optional so the brief's `{ workerId }` shape still works |
| A21 | Gap | A cross-origin redirect drops `authorization`/`cookie` from the forwarded request; among DNS failures only `EAI_AGAIN` is retryable | The brief is silent on redirect semantics. A redirect is the target's choice, not the producer's, so replaying the producer's credential to a different origin is a leak (browser `fetch` strips the same); a transient-resolver error is the one DNS failure a later attempt could plausibly fix — a name that does not exist will not exist in 30 seconds |
| A22 | Extension | `GET /queues` lists queue names for the UI | The brief's UI shows a "queue list" but the listed endpoints are all name-scoped, so nothing enumerates queues; a read-only listing over the existing seeded/implicit queues closes the gap without touching the task surface |

### Declared readings

Three entries resolve places the brief was silent or disagreed with itself, called out so a reader need
not infer which. A fourth, the harness speaking HTTP (A9), was raised the same way and has since been
confirmed by the author.

- **`GET /tasks/:id` added** (A16) — results must be retrievable after ack, and no listed endpoint
  returns one; "retrievable" as merely persisted was rejected as satisfying the letter while defeating
  the purpose.
- **`nack` carries `retryable`** (A17) — as listed the server sees only prose and can only count
  attempts, so the classification the brief asks for is unobservable; encoding it inside `reason` was
  rejected as invisible to validation. `forgiveAttempt`, `ack`'s `{ result }` (A16) and the optional
  `claimId` fence (A20) ride alongside; a client using the listed shapes still works.
- **Queues created implicitly** (A7) — nothing in the brief creates one, and declare-on-use is how
  queues are normally managed.

## 12. Next steps, and what was cut

**Next:**

- `LISTEN/NOTIFY`-backed SSE, replacing the UI poll and waking idle workers on one mechanism.
- Retention for succeeded rows (nothing bounds them today), with `fillfactor` and autovacuum tuning on
  `tasks` — under sustained load, page-full heaps void the HOT-heartbeat argument and `SKIP LOCKED`
  scans start walking dead index entries.
- A per-attempt audit table for failure forensics.
- Observability on the seams the design already cut: a metrics surface — age-of-oldest-ready, DLQ
  arrival rate, reaper-tick staleness, pool wait (`stats` and `/healthz` compute the first two) — plus
  structured logs under §9's no-payload rule, `task.id` as correlation id.
- Backpressure: nothing bounds enqueue, so the de facto limit is the disk — a per-queue depth cap in the
  `queues` policy row, answered with `429` and `Retry-After` (and honouring `Retry-After` on the client).
- A no-transaction escape in the migration runner: it wraps each file in a transaction, which
  `CREATE INDEX CONCURRENTLY` and `ALTER TYPE ADD VALUE` refuse.
- Batch `extend` (the per-task endpoint costs N round trips per heartbeat), a child-process pool,
  OS-level sandboxing for §5's residual, and per-worker credentials turning `X-Worker-Id` from
  identification into authentication.

**Cut:** benchmarks (the brief warns off premature scaling, and the `SKIP LOCKED` argument rests on the
SQL and the concurrency test); capturing `js` stdout and persisting `http` response headers (nothing
reads either); per-type worker fleets (one step from the priority scheduling the brief rules out); a
polymorphic storage interface (§1); and priority, fairness, fan-out and multi-tenancy, per the
non-goals.
