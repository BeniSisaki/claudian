import {
  buildModosUsageInfo,
  isTerminalTurnEvent,
  normalizeModosRuntimeEvent,
  terminalTurnError,
} from '@/providers/modos/normalization/modosEventNormalization';
import type { ModosRuntimeEvent } from '@/providers/modos/runtime/modos-api-types';

function baseEvent(partial: Partial<ModosRuntimeEvent>): ModosRuntimeEvent {
  return {
    kind: 'unknown',
    seq: 1,
    threadId: 'thread_1',
    timestamp: new Date().toISOString(),
    ...partial,
  } as ModosRuntimeEvent;
}

describe('normalizeModosRuntimeEvent', () => {
  it('maps text and thinking deltas', () => {
    expect(normalizeModosRuntimeEvent(baseEvent({
      item: { kind: 'assistant_text', text: 'Hello' },
      kind: 'assistant_text_delta',
    } as never), new Set())).toEqual([{ type: 'text', content: 'Hello' }]);

    expect(normalizeModosRuntimeEvent(baseEvent({
      item: { kind: 'assistant_reasoning', text: 'hmm' },
      kind: 'assistant_reasoning_delta',
    } as never), new Set())).toEqual([{ type: 'thinking', content: 'hmm' }]);
  });

  it('maps tool calls once and tool results', () => {
    const emitted = new Set<string>();
    const started = baseEvent({
      item: {
        arguments: { command: 'ls' },
        callId: 'call_1',
        kind: 'tool_call',
        toolName: 'bash',
      },
      kind: 'tool_call_started',
    } as never);
    expect(normalizeModosRuntimeEvent(started, emitted)).toEqual([{
      type: 'tool_use',
      id: 'call_1',
      input: { command: 'ls' },
      name: 'bash',
    }]);
    expect(normalizeModosRuntimeEvent(started, emitted)).toEqual([]);

    expect(normalizeModosRuntimeEvent(baseEvent({
      item: {
        callId: 'call_1',
        isError: false,
        kind: 'tool_result',
        output: 'ok',
        toolName: 'bash',
      },
      kind: 'tool_call_finished',
    } as never), emitted)).toEqual([{
      content: 'ok',
      id: 'call_1',
      isError: false,
      type: 'tool_result',
    }]);
  });

  it('maps retries, compaction, and runtime errors to notices', () => {
    expect(normalizeModosRuntimeEvent(baseEvent({
      attempt: 1,
      kind: 'model_request_retry',
      maxAttempts: 3,
    }), new Set())[0]).toMatchObject({ level: 'warning', type: 'notice' });

    expect(normalizeModosRuntimeEvent(baseEvent({ kind: 'compaction_completed' }), new Set()))
      .toEqual([{ type: 'context_compacted' }]);

    expect(normalizeModosRuntimeEvent(baseEvent({
      kind: 'error',
      message: 'boom',
      severity: 'error',
    }), new Set())).toEqual([{ content: 'boom', level: 'warning', type: 'notice' }]);

    expect(normalizeModosRuntimeEvent(baseEvent({
      kind: 'error',
      message: 'fyi',
      severity: 'info',
    }), new Set())).toEqual([]);
  });
});

describe('terminal turn events', () => {
  it('detects terminal events for the active turn only', () => {
    expect(isTerminalTurnEvent(baseEvent({ kind: 'turn_completed', turnId: 't1' }), 't1')).toBe(true);
    expect(isTerminalTurnEvent(baseEvent({ kind: 'turn_failed', turnId: 't1' }), 't2')).toBe(false);
    expect(isTerminalTurnEvent(baseEvent({ kind: 'turn_started', turnId: 't1' }), 't1')).toBe(false);
  });

  it('extracts failure messages', () => {
    expect(terminalTurnError(baseEvent({ kind: 'turn_failed', message: 'provider exploded' })))
      .toBe('provider exploded');
    expect(terminalTurnError(baseEvent({ kind: 'turn_failed' }))).toBe('Modos turn failed.');
    expect(terminalTurnError(baseEvent({ kind: 'turn_completed' }))).toBeNull();
  });
});

describe('buildModosUsageInfo', () => {
  it('maps the usage snapshot onto UsageInfo', () => {
    expect(buildModosUsageInfo({
      cacheHitTokens: 400,
      cacheWriteTokens: 50,
      cacheHitRate: null,
      completionTokens: 100,
      promptTokens: 1000,
      totalTokens: 1100,
      turns: 1,
    }, 'deepseek-v4-pro', 200_000)).toEqual({
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 400,
      contextTokens: 1000,
      contextWindow: 200_000,
      contextWindowIsAuthoritative: true,
      inputTokens: 1000,
      model: 'deepseek-v4-pro',
      percentage: 1,
    });
  });
});
