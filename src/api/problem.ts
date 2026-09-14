import type { FastifyReply } from 'fastify';

// RFC 9457 problem+json; `type` disambiguates where a status code cannot — 409 covers both a
// lost lease and a requeue of a task not in the DLQ (SPEC §8).
export type ProblemType =
  | 'validation' | 'unparseable' | 'not-found' | 'lost-lease'
  | 'not-in-dlq' | 'payload-too-large' | 'missing-worker-id' | 'bad-host'
  | 'internal';

const STATUS: Record<ProblemType, number> = {
  validation: 422, unparseable: 400, 'not-found': 404, 'lost-lease': 409,
  'not-in-dlq': 409, 'payload-too-large': 413, 'missing-worker-id': 400,
  'bad-host': 400, internal: 500,
};

export function problem(reply: FastifyReply, type: ProblemType, detail: string): FastifyReply {
  const status = STATUS[type];
  return reply.status(status).type('application/problem+json').send({
    type: `/problems/${type}`, title: type.replaceAll('-', ' '), status, detail,
  });
}
