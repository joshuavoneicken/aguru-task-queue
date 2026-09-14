import { z } from 'zod';

export const taskIdSchema = z.string().uuid().brand<'TaskId'>();
export type TaskId = z.infer<typeof taskIdSchema>;

export const claimIdSchema = z.string().uuid().brand<'ClaimId'>();
export type ClaimId = z.infer<typeof claimIdSchema>;

export const TASK_TYPES = ['llm', 'js', 'http'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

const timeoutMsSchema = z.number().int().min(1).max(300_000);

export const llmPayloadSchema = z.object({
  model: z.string().min(1).max(256),
  prompt: z.string().min(1),
}).strict();
export type LlmPayload = z.infer<typeof llmPayloadSchema>;

export const jsPayloadSchema = z.object({
  source: z.string().min(1),
  input: z.unknown().optional(),
  timeoutMs: timeoutMsSchema.optional(),
}).strict();
export type JsPayload = z.infer<typeof jsPayloadSchema>;

// zod's own `.url()` check marks the string result "dirty", not "aborted", so this refinement
// still runs against a value that failed `.url()` — `new URL` can throw here and must be guarded.
const httpUrl = z.string().max(4096).url().refine(
  (value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  },
  { message: 'url must be http or https' },
);

export const httpPayloadSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
  url: httpUrl,
  headers: z.record(z.string(), z.string().max(4096)).optional(),
  body: z.string().optional(),
  timeoutMs: timeoutMsSchema.optional(),
}).strict();
export type HttpPayload = z.infer<typeof httpPayloadSchema>;
