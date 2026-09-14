CREATE TYPE task_status AS ENUM ('ready', 'in_flight', 'succeeded', 'dlq');

CREATE TYPE failure_kind AS ENUM (
  'handler_error', 'handler_terminal', 'unclassified', 'timeout',
  'lease_expired', 'result_too_large', 'no_handler', 'worker_shutdown'
);

CREATE TABLE queues (
  name             text PRIMARY KEY,
  max_attempts     int         NOT NULL,
  backoff_base_ms  int         NOT NULL,
  backoff_cap_ms   int         NOT NULL,
  dedupe_window_ms int         NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sane_policy CHECK (max_attempts >= 1 AND backoff_base_ms > 0
                                AND backoff_cap_ms >= backoff_base_ms)
);

CREATE TABLE tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name        text        NOT NULL REFERENCES queues(name),
  type              text        NOT NULL,
  payload           jsonb       NOT NULL,
  status            task_status NOT NULL DEFAULT 'ready',
  attempts          int         NOT NULL DEFAULT 0,
  attempts_forgiven int         NOT NULL DEFAULT 0,
  run_after         timestamptz NOT NULL DEFAULT now(),
  lease_expires_at  timestamptz,
  worker_id         text,
  claim_id          uuid,
  claimed_at        timestamptz,
  result            jsonb,
  failure_kind      failure_kind,
  last_error        text,
  dedupe_key        text,
  dedupe_expires_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  succeeded_at      timestamptz,
  failed_at         timestamptz,

  -- policy copied from the queue at enqueue: the reaper computes backoff in SQL
  -- without application config, and a policy change never re-times work in flight
  max_attempts      int NOT NULL,
  backoff_base_ms   int NOT NULL,
  backoff_cap_ms    int NOT NULL,

  CONSTRAINT ready_has_attempts_left
    CHECK (status <> 'ready' OR attempts < max_attempts),
  CONSTRAINT attempts_sane
    CHECK (attempts >= 0 AND attempts_forgiven >= 0 AND attempts_forgiven <= max_attempts),
  CONSTRAINT in_flight_has_claim
    CHECK (status <> 'in_flight' OR (lease_expires_at IS NOT NULL AND worker_id IS NOT NULL
                                     AND claim_id IS NOT NULL AND claimed_at IS NOT NULL)),
  CONSTRAINT dlq_has_failed_at
    CHECK (status <> 'dlq' OR failed_at IS NOT NULL)
);

-- No index may cover lease_expires_at, worker_id, claim_id or claimed_at: the heartbeat
-- writes only those columns, so leaving them unindexed keeps renewal a heap-only-tuple update.
CREATE INDEX tasks_ready_idx      ON tasks (queue_name, run_after) WHERE status = 'ready';
CREATE INDEX tasks_inflight_idx   ON tasks (queue_name, id)        WHERE status = 'in_flight';
CREATE INDEX tasks_dlq_idx        ON tasks (queue_name, failed_at DESC, id DESC) WHERE status = 'dlq';
CREATE INDEX tasks_dedupe_exp_idx ON tasks (dedupe_expires_at)     WHERE dedupe_key IS NOT NULL;

CREATE UNIQUE INDEX tasks_dedupe_idx ON tasks (queue_name, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- Exponential, factor 4, full jitter (SPEC §6). least(attempts, 15) guards the double
-- against overflow; the retry ladder never legitimately reaches 15.
CREATE FUNCTION backoff_run_after(attempts int, base_ms int, cap_ms int)
RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
  SELECT now() + make_interval(
    secs => random() * least(cap_ms, base_ms * power(4, least(attempts, 15))) / 1000.0);
$$;

CREATE VIEW task_state AS
  SELECT id, queue_name, type, payload, attempts, max_attempts, run_after,
         result, failure_kind, last_error, created_at, succeeded_at, failed_at,
         (CASE
           WHEN status = 'succeeded'                               THEN 'succeeded'
           WHEN status = 'dlq'                                     THEN 'dlq'
           WHEN status = 'in_flight' AND lease_expires_at > now()  THEN 'in_flight'
           WHEN attempts >= max_attempts                           THEN 'dlq'
           ELSE                                                         'ready'
         END)::task_status AS state
  FROM tasks;
