import type { ModosServeConnection } from './ModosServeProcess';

const SSE_RECONNECT_DELAY_MS = 500;

export class ModosHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ModosHttpError';
  }
}

/**
 * The server closes an SSE page when its replay budget fills; the client
 * must rebuild a snapshot and reconnect from a fresh cursor.
 */
export class ModosSseOverflowError extends Error {
  constructor(message = 'SSE replay overflow') {
    super(message);
    this.name = 'ModosSseOverflowError';
  }
}

export interface ModosSseEvent {
  /** RuntimeEvent kind (the SSE `event:` field). */
  kind: string;
  /** Parsed `data:` payload (a full RuntimeEvent for normal frames). */
  data: unknown;
  /** Per-thread sequence cursor (`id:` field); null for protocol error frames. */
  seq: number | null;
}

export class ModosHttpClient {
  constructor(
    private readonly connection: ModosServeConnection,
    // The global fetch must be invoked with `window` as receiver in
    // Obsidian's renderer; calling an unbound reference throws
    // "Illegal invocation". Wrap it instead of storing it bare.
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  get baseUrl(): string {
    return this.connection.baseUrl;
  }

  get token(): string {
    return this.connection.token;
  }

  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>('GET', path, undefined, signal);
  }

  async post<T>(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.request<T>('POST', path, body, signal, headers);
  }

  async patch<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>('PATCH', path, body, signal);
  }

  async delete<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>('DELETE', path, undefined, signal);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.connection.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.connection.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(headers ?? {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new ModosHttpError(
        `modos serve unreachable: ${error instanceof Error ? error.message : String(error)}`,
        0,
      );
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const errorBody = isRecord(parsed) ? parsed : {};
      throw new ModosHttpError(
        typeof errorBody.message === 'string'
          ? errorBody.message
          : `modos serve responded with HTTP ${response.status}`,
        response.status,
        typeof errorBody.code === 'string' ? errorBody.code : undefined,
        'details' in errorBody ? errorBody.details : undefined,
      );
    }

    return parsed as T;
  }

  /**
   * Streams thread events, transparently reconnecting with the last cursor
   * when the server closes a replay page. Heartbeats are yielded like any
   * other event but never advance the cursor. Throws ModosSseOverflowError
   * when the server signals replay overflow, and ModosHttpError on
   * auth/not-found failures (both are terminal for the stream).
   *
   * Implemented as a single generator without `yield*` delegation on
   * purpose: the plugin ships with downleveled async generators (ES2018),
   * where delegation mishandles early consumer return().
   */
  async *streamEvents(
    threadId: string,
    sinceSeq: number,
    signal: AbortSignal,
  ): AsyncGenerator<ModosSseEvent> {
    let cursor = Math.max(0, Math.floor(sinceSeq));
    for (;;) {
      if (signal.aborted) {
        return;
      }

      let response: Response;
      try {
        response = await this.fetchImpl(
          `${this.connection.baseUrl}/v1/threads/${encodeURIComponent(threadId)}/events?since_seq=${cursor}`,
          {
            headers: { authorization: `Bearer ${this.connection.token}` },
            signal,
          },
        );
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        throw new ModosHttpError(
          `modos SSE connect failed: ${error instanceof Error ? error.message : String(error)}`,
          0,
        );
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new ModosHttpError(
          `modos SSE responded with HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
          response.status,
        );
      }
      if (!response.body) {
        throw new ModosHttpError('modos SSE response has no body', 0);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let outcome: 'eof' | 'aborted' | 'overflow' = 'eof';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const rawFrame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const frame = parseSseFrame(rawFrame);
            if (!frame) {
              continue;
            }
            if (frame.kind === 'error' && frame.seq === null) {
              outcome = 'overflow';
              break;
            }
            if (frame.kind !== 'heartbeat' && frame.seq !== null) {
              cursor = Math.max(cursor, frame.seq);
            }
            yield frame;
          }
          if (outcome === 'overflow') {
            break;
          }
          if (signal.aborted) {
            outcome = 'aborted';
            break;
          }
        }
      } catch (error) {
        if (isAbortError(error) || signal.aborted) {
          outcome = 'aborted';
        } else {
          throw error;
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // Best effort: the stream is already closing.
        }
        reader.releaseLock();
      }

      if (outcome === 'aborted') {
        return;
      }
      if (outcome === 'overflow') {
        throw new ModosSseOverflowError();
      }

      // Normal EOF (server closed a full replay page or the connection
      // dropped): wait briefly, then reconnect from the last cursor.
      try {
        await delay(SSE_RECONNECT_DELAY_MS, signal);
      } catch {
        return;
      }
    }
  }
}

function parseSseFrame(rawFrame: string): ModosSseEvent | null {
  let kind = 'message';
  let seq: number | null = null;
  const dataLines: string[] = [];

  for (const line of rawFrame.split('\n')) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'id') {
      const parsed = Number.parseInt(value, 10);
      seq = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    } else if (field === 'event') {
      kind = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const rawData = dataLines.join('\n');
  let data: unknown = rawData;
  try {
    data = JSON.parse(rawData);
  } catch {
    // Keep the raw payload; the server only sends JSON, so this is defensive.
  }

  return { data, kind, seq };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
