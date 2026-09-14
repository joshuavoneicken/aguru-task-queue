import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadWorkerConfig } from '../config.js';
import { classifyHttpError, createHttpHandler } from '../handlers/http.js';
import { classifyJsError, createJsHandler } from '../handlers/js.js';
import { classifyLlmError, createLlmHandler } from '../handlers/llm.js';
import { StubLlmProvider } from '../handlers/provider.js';
import { Harness, HandlerRegistry, installLifecycle, systemClock } from '@aguru/harness';
import { HttpQueueClient } from '../http-queue-client.js';

const JS_DEFAULT_TIMEOUT_MS = 30_000;

const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadWorkerConfig();

const registry = new HandlerRegistry()
  .register('llm', createLlmHandler(new StubLlmProvider()), classifyLlmError)
  .register(
    'http',
    createHttpHandler({
      allowLoopback: config.allowLoopbackHttp,
      bodyMaxBytes: config.resultMaxBytes,
      redirectMax: config.httpRedirectMax,
    }),
    classifyHttpError,
  )
  .register('js', createJsHandler({ defaultTimeoutMs: JS_DEFAULT_TIMEOUT_MS }), classifyJsError);

const client = new HttpQueueClient(config.apiUrl, config.workerId);
const harness = new Harness({
  client,
  registry,
  queueName: config.queueName,
  concurrency: config.concurrency,
  leaseMs: config.leaseMs,
  maxTaskExecutionMs: config.maxTaskExecutionMs,
  clock: systemClock,
  log: (message) => console.log(message),
});

installLifecycle({
  harness,
  client,
  shutdownGraceMs: config.shutdownGraceMs,
  onExit: (code) => process.exit(code),
});

harness.start();
console.log(`worker ${config.workerId} claiming from queue "${config.queueName}" at ${config.apiUrl}`);
