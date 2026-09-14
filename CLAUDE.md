# CLAUDE.md

A PostgreSQL-backed task queue: HTTP API, worker harness, three handlers (`llm`, `js`, `http`), and a
React dashboard.

`README.md` and `DESIGN.md` are the graded deliverables. `SPEC.md` is the full specification and the
place every design decision and assumption is recorded. The brief itself is not in the repository.

## Commands

```bash
docker compose up -d --wait        # Postgres; tests and the app both need it
npm test                           # backend suite, Vitest; each DB test clones a migrated template
npx vitest run test/concurrent-claim.test.ts
npm run typecheck
npm run ui:test                    # UI component tests
npm run dev                        # Postgres + migrations + API (3000) + one worker on `jobs`
npm run ui                         # Vite dev server with hot reload, proxying the API
```

Node 22.14+. `.env.example` also lists every environment variable with its default.
CI (`.github/workflows/ci.yml`) runs both test suites, both typechecks and the UI build on every push.

## Layout

```
harness/     @aguru/harness, a workspace package: the worker library. Imports nothing from src/.
src/
  domain/    pure types and classification, no I/O
  store/     all SQL; the only directory that imports pg at runtime
  api/       Fastify routes, validation, problem+json, Host guard, reaper scheduler
  handlers/  llm, js (forked child), http (SSRF guard), shared network-error allowlist
  bin/       api.ts and worker.ts, wiring only
migrations/  schema; SPEC.md points here rather than inlining DDL
test/        component and integration tests against real Postgres; helpers/ for the template DB
ui/          the React page, its own package
```

## Constraints

- TypeScript on Node, Postgres via `pg`. Decided; do not revisit.
- No queue library of any kind. Building the primitives is the exercise.
- Non-goals are a hard stop: priority, fairness, fan-out, multi-tenancy, auth beyond `X-Worker-Id`,
  scaling proofs, exactly-once, benchmarks. If work drifts into one of these, stop.
- The UI is functional, not polished, and time-boxed.

## Standards

- Strict TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. No `any`, no
  `as` casts papering over a modelling gap. Narrow properly.
- `store/` owns every line of SQL, parameterised only. Its surface is a structural type, not an
  interface; there is one implementation and the correctness guarantees would not port.
- Names carry meaning; comments only for a non-obvious invariant or a deliberate trade-off.
- Prefer a database `CHECK` to an application promise.
- YAGNI. Anything speculative is a defect.

## Review gate

Every change to `src/`, `harness/`, `migrations/`, `test/` or a deliverable document is reviewed
before it is committed, by three independent passes. Each pass is a fresh subagent given only the
diff, the relevant `SPEC.md` sections and its checklist, never the author's reasoning. Each returns
findings with a severity. Blocking findings are fixed and the pass re-run. Should-fix findings are
fixed, or recorded in `SPEC.md` with the reason they were not. Nits are the author's call.

1. **Principal engineer.** Naming, cohesion, single responsibility, YAGNI, idiomatic strict
   TypeScript, honest error handling. Does every test fail without the change it covers? Do the
   documents still describe the code?
2. **Distributed systems expert.** Delivery semantics and failure models: for each participant,
   what happens when it dies, stalls or is partitioned, and does recovery need a human? Is
   idempotency a system property or a checkbox? Then the storage layer's concurrency control: what
   lock does each statement take, for how long, and what else wants it? Does the isolation level
   re-check what the correctness argument assumes? Is every invariant held by a named test?
3. **Security expert.** The payload is hostile: now what? Sandbox escape, SSRF, bounds on
   everything a caller controls, payloads or secrets in logs or error responses. Where a control is
   incomplete, is the residual named rather than overclaimed?

Each lens has caught defects the other two missed, which is why all three run every time.

## Security

Payloads are hostile input the system executes. `js` never runs in the worker process. The `http`
handler must not become an SSRF vector: validate the resolved IP, pin it, re-validate on redirect, cap
size and time. Bound everything a caller controls at the API edge. Never log payloads or results
wholesale. Secrets come from the environment and never land in a task row or an error response. Where a
control is incomplete, name the residual risk in `SPEC.md` rather than overclaiming.

## Process

- Test first. Name the test, watch it fail for the right reason, then write the code. Unit tests for
  anything decidable without I/O; anything asserting a concurrency property runs against real
  Postgres, never a stand-in.
- Before saying a change is done, run `npm test` and `npm run typecheck` and quote the summary
  lines. A filtered or piped run that hides the exit code does not count.
- A change to SQL, a default, or the HTTP surface updates the matching `SPEC.md` section in the same
  commit.
- Every assumption goes in the `SPEC.md` §11 register, numbered, with its reasoning, at the moment it
  is made. The brief grades stated assumptions in the candidate's favour and smuggled ones against.
- Keep `docs/time-log.md` current. It is local-only and feeds the submission email.
- `DESIGN.md` is standalone: no pointers to other documents, and it stays within four A4 pages.
  It is hand-edited by Joshua; propose changes rather than rewriting wholesale.
- Work on a feature branch, never directly on `main`; merge when the branch is green. Commit in
  logical units and push when asked.
