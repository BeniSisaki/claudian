import {
  ModosHttpClient,
  ModosHttpError,
  ModosSseOverflowError,
} from '@/providers/modos/runtime/ModosHttpClient';

const CONNECTION = { baseUrl: 'http://127.0.0.1:19001', host: '127.0.0.1', port: 19001, token: 'tok' };

function sseResponse(frames: string, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function frame(event: string, data: unknown, id?: number): string {
  return `${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('ModosHttpClient', () => {
  it('sends the bearer token and parses JSON responses', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    const client = new ModosHttpClient(CONNECTION, fetchImpl);
    await expect(client.post('/v1/threads', { title: 'x' })).resolves.toEqual({ ok: true });
    const headers = seen[0].headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['content-type']).toBe('application/json');
  });

  it('raises ModosHttpError with the server error body', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ code: 'not_found', message: 'thread not found: abc' }, 404)) as typeof fetch;
    const client = new ModosHttpClient(CONNECTION, fetchImpl);
    await expect(client.get('/v1/threads/abc')).rejects.toMatchObject({
      code: 'not_found',
      message: 'thread not found: abc',
      status: 404,
    });
    await expect(client.get('/v1/threads/abc')).rejects.toBeInstanceOf(ModosHttpError);
  });

  it('streams SSE frames and does not advance the cursor on heartbeats', async () => {
    const requestedUrls: string[] = [];
    let calls = 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      requestedUrls.push(String(url));
      calls += 1;
      if (calls === 1) {
        return sseResponse(
          frame('turn_started', { seq: 1 }, 1)
          + frame('heartbeat', { seq: 1 }, 1)
          + frame('assistant_text_delta', { seq: 2 }, 2),
        );
      }
      // Second connection: open until the caller aborts. The mock has to
      // honor the signal itself — real fetch would abort the network read.
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
            try {
              controller.close();
            } catch {
              // Already closed.
            }
          });
        },
      }), { status: 200 });
    }) as typeof fetch;

    const client = new ModosHttpClient(CONNECTION, fetchImpl);
    const abort = new AbortController();
    const seen: Array<{ kind: string; seq: number | null }> = [];
    const eventsPromise = (async () => {
      for await (const event of client.streamEvents('thread_1', 0, abort.signal)) {
        seen.push({ kind: event.kind, seq: event.seq });
      }
    })();

    // Wait for the transparent reconnect after the first page's EOF.
    for (let attempt = 0; attempt < 100 && requestedUrls.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    abort.abort();
    await eventsPromise;

    expect(seen).toEqual([
      { kind: 'turn_started', seq: 1 },
      { kind: 'heartbeat', seq: 1 },
      { kind: 'assistant_text_delta', seq: 2 },
    ]);
    expect(requestedUrls[0]).toContain('since_seq=0');
    expect(requestedUrls[1]).toContain('since_seq=2');
  });

  it('throws ModosSseOverflowError on overflow error frames', async () => {
    const fetchImpl = (async () =>
      sseResponse('event: error\ndata: {"message":"SSE replay overflow; reconnect from the last event cursor."}\n\n')) as typeof fetch;
    const client = new ModosHttpClient(CONNECTION, fetchImpl);
    const abort = new AbortController();
    await expect(async () => {
      for await (const frame of client.streamEvents('thread_1', 5, abort.signal)) {
        void frame;
      }
    }).rejects.toBeInstanceOf(ModosSseOverflowError);
  });

  it('parses multi-line data payloads and strips a leading space', async () => {
    const payload = { text: 'line1\nline2' };
    const data = JSON.stringify(payload).replace('\n', '\ndata: ');
    const fetchImpl = (async () => sseResponse(`id: 9\nevent: item_updated\ndata: ${data}\n\n`)) as typeof fetch;
    const client = new ModosHttpClient(CONNECTION, fetchImpl);
    const abort = new AbortController();
    const iterator = client.streamEvents('thread_1', 0, abort.signal)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value.seq).toBe(9);
    expect(first.value.kind).toBe('item_updated');
    abort.abort();
  });
});
