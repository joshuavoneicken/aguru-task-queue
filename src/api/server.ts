import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type pg from 'pg';
import type { ApiConfig } from '../config.js';
import { store } from '../store/contract.js';
import { registerRoutes } from './routes.js';
import { workerIdHeader } from './validation.js';
import { hostAllowed } from './host.js';
import { problem } from './problem.js';
import { startReaperScheduler } from './reaper-scheduler.js';

export async function buildServer(pool: pg.Pool, config: ApiConfig): Promise<FastifyInstance> {
  // The body limit sits above the payload cap so Fastify's own 413 fires only for bodies no
  // route could accept; the envelope margin covers the non-payload fields.
  // maxParamLength sits above the 128-char queue-name bound so an overlong name is rejected by
  // the validation schema as a uniform 422 problem, not the router's opaque 414; params beyond
  // 256 still hit Fastify's own hard stop.
  const app = Fastify({
    bodyLimit: config.payloadMaxBytes + 16_384,
    routerOptions: { maxParamLength: 256 },
    logger: false,
  });

  // Host allowlist against DNS rebinding (SPEC §9): a page rebound to this address is
  // same-origin, so CORS never fires — the Host header is the check that survives. Registered
  // before the CORS plugin so it guards every request, preflight/static/healthz included.
  app.addHook('onRequest', async (req, reply) => {
    if (!hostAllowed(req.headers.host, config.allowedHosts)) {
      return problem(reply, 'bad-host', 'Host header is missing or not an allowed hostname');
    }
  });

  // Allowlisted to the one UI origin — never '*': the API trusts X-Worker-Id, so a
  // reflected-origin policy would extend that trust to any page the browser visits.
  await app.register(cors, {
    origin: config.uiOrigin,
    methods: ['GET', 'POST'],
    allowedHeaders: ['content-type', 'x-worker-id'],
  });

  // X-Worker-Id is a worker identity, so it is required only on the worker surface: claim, and
  // the ownership assertions ack/nack/extend, where worker_id is matched against the row. Producers
  // (enqueue), the UI (reads, requeue) and /healthz are not workers and rely on the private network
  // (§9). The set is the MATCHED route pattern, never the raw url — Fastify routes on the
  // percent-decoded path, so /%74asks/:id/ack reaches the ack handler, and a raw-url check would
  // wave it through unauthenticated.
  const WORKER_ROUTES = new Set([
    '/queues/:name/claim',
    '/tasks/:id/ack',
    '/tasks/:id/nack',
    '/tasks/:id/extend',
  ]);
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return; // CORS preflight carries no worker header
    const route = req.routeOptions.url;
    if (route === undefined || !WORKER_ROUTES.has(route)) return;
    const header = req.headers['x-worker-id'];
    if (typeof header !== 'string' || !workerIdHeader.safeParse(header).success) {
      return problem(reply, 'missing-worker-id', 'X-Worker-Id header is required on worker endpoints');
    }
  });

  // Bodyless POSTs (requeue, and ack's "no result" case) arrive with a JSON content-type and an
  // empty body; the default parser 400s on those. Empty means "no body" here — everything else
  // still goes through Fastify's own parser, keeping its prototype-poisoning protection.
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text === '') { done(null, undefined); return; }
    parseJson(req, text, done);
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const statusCode = err instanceof Error && 'statusCode' in err ? err.statusCode : undefined;
    if (statusCode === 400) return problem(reply, 'unparseable', 'body is not valid JSON');
    if (statusCode === 413) return problem(reply, 'payload-too-large', 'payload exceeds the configured cap');
    // Everything else keeps the problem+json shape with a static detail — the underlying
    // message (a pg error, a Fastify internal) never reaches the caller (§5).
    console.error(`request failed: ${req.method} ${req.routeOptions.url ?? '(unrouted)'} ${err instanceof Error ? err.name : 'non-error'}`);
    return problem(reply, 'internal', 'internal error');
  });

  app.setNotFoundHandler((_req, reply) => problem(reply, 'not-found', 'no such route'));

  await store.seedQueues(pool, config.queues);

  // leaseMs/2 so an expired lease is caught within half its own window; 100 per tick bounds one
  // drain's lock hold rather than draining an unbounded backlog in one transaction.
  const reaper = startReaperScheduler({
    drain: () => store.drainExpired(pool, 100),
    cadenceMs: Math.floor(config.leaseMs / 2),
    log: (message) => console.error(message),
  });
  app.addHook('onClose', async () => { reaper.stop(); });

  app.get('/healthz', async () => ({ status: 'ok', lastReaperTickAt: reaper.lastTickAt() }));

  registerRoutes(app, pool, config);

  // After registerRoutes so explicit API routes win; skipped when the UI is not built,
  // so dev and test runs without ui/dist still boot.
  const uiDist = fileURLToPath(new URL('../../ui/dist', import.meta.url));
  if (existsSync(uiDist)) {
    await app.register(fastifyStatic, { root: uiDist, index: ['index.html'] });
  }

  return app;
}
