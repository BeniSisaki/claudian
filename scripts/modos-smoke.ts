/**
 * End-to-end smoke for the Modos provider transport against a real
 * `modos serve` child process. Bundled with esbuild and run with plain
 * Node (see scripts/modos-smoke.bundle.mjs).
 *
 * Covers: serve launch + health handshake, runtime info, thread create,
 * turn start, SSE streaming through the terminal turn event, and shutdown.
 * Without a valid DEEPSEEK_API_KEY the model call fails fast, which still
 * exercises the full turn lifecycle (turn_failed as the terminal event).
 */
import './modos-smoke-prelude';
import { ModosHttpClient } from '../src/providers/modos/runtime/ModosHttpClient';
import type { ModosRuntimeEvent, ModosThread } from '../src/providers/modos/runtime/modos-api-types';
import { ModosServeManager } from '../src/providers/modos/runtime/ModosServeProcess';

const cliPath = process.argv[2];
if (!cliPath) {
  console.error('usage: node modos-smoke.mjs <path-to-modos-cli> [dataDir]');
  process.exit(64);
}

const fakePlugin = {
  settings: {
    providerConfigs: {
      modos: {
        approvalPolicy: 'never',
        enabled: true,
        ...(process.argv[3] ? { dataDir: process.argv[3] } : {}),
        sandboxMode: 'read-only',
      },
    },
  },
  async getResolvedProviderCliPath() {
    return cliPath;
  },
} as never;

const manager = new ModosServeManager(fakePlugin, null);

async function main(): Promise<void> {
  console.log('[smoke] starting modos serve...');
  const connection = await manager.ensureReady();
  console.log(`[smoke] serve ready at ${connection.baseUrl}`);

  const client = new ModosHttpClient(connection);
  const info = await client.get<{ model?: string }>('/v1/runtime/info');
  console.log(`[smoke] runtime info: model=${info.model ?? 'unknown'}`);
  if (!info.model) {
    throw new Error('runtime reported no model');
  }

  const thread = await client.post<ModosThread>('/v1/threads', {
    mode: 'agent',
    model: info.model,
    title: 'claudian-modos smoke',
    workspace: process.cwd(),
  });
  console.log(`[smoke] thread created: ${thread.id} latestSeq=${thread.latestSeq ?? 0}`);

  const started = await client.post<{ turnId: string }>(
    `/v1/threads/${encodeURIComponent(thread.id)}/turns`,
    { mode: 'agent', prompt: 'Say hello in one word.' },
  );
  console.log(`[smoke] turn started: ${started.turnId}`);

  const abort = new AbortController();
  const terminal = await new Promise<{ kind: string; message?: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      abort.abort();
      reject(new Error('timed out waiting for the terminal turn event'));
    }, 120_000);
    void (async () => {
      let lastSeq = thread.latestSeq ?? 0;
      for await (const frame of client.streamEvents(thread.id, lastSeq, abort.signal)) {
        const event = frame.data as ModosRuntimeEvent;
        if (typeof event?.seq === 'number') {
          lastSeq = event.seq;
        }
        if (!event?.kind || event.kind === 'heartbeat') {
          continue;
        }
        console.log(`[smoke] event: ${event.kind}${event.turnId ? ` turn=${event.turnId}` : ''}`);
        if (
          event.turnId === started.turnId
          && (event.kind === 'turn_completed' || event.kind === 'turn_failed' || event.kind === 'turn_aborted')
        ) {
          clearTimeout(timer);
          resolve({ kind: event.kind, message: event.message });
          return;
        }
      }
    })().catch(reject);
  });

  // Without an API key the turn is expected to fail; what matters is that
  // a terminal event arrived over SSE.
  console.log(`[smoke] terminal event: ${terminal.kind}${terminal.message ? ` (${terminal.message})` : ''}`);

  const snapshot = await client.get<ModosThread>(`/v1/threads/${encodeURIComponent(thread.id)}`);
  console.log(`[smoke] thread snapshot: turns=${snapshot.turns?.length ?? 0} latestSeq=${snapshot.latestSeq ?? 0}`);

  await manager.shutdown();
  console.log('[smoke] serve stopped. PASS');
  process.exit(0);
}

main().catch(async (error) => {
  console.error(`[smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  const diagnostics = manager.getDiagnostics();
  if (diagnostics) {
    console.error(`[smoke] modos stderr:\n${diagnostics}`);
  }
  await manager.shutdown().catch(() => undefined);
  process.exit(70);
});
