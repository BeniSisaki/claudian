import type { StreamChunk, UsageInfo } from '../../../core/types';
import type {
  ModosRuntimeEvent,
  ModosUsageSnapshot,
} from '../runtime/modos-api-types';

/**
 * Maps MODOS RuntimeEvents to provider-neutral StreamChunks. Approval and
 * user-input events are handled separately by the runtime (they need
 * callbacks, not UI chunks) and never reach this normalizer.
 */
export function normalizeModosRuntimeEvent(
  event: ModosRuntimeEvent,
  emittedToolIds: Set<string>,
): StreamChunk[] {
  switch (event.kind) {
    case 'assistant_text_delta':
      if (event.item?.kind === 'assistant_text') {
        return [{ type: 'text', content: event.item.text }];
      }
      return [];
    case 'assistant_reasoning_delta':
      if (event.item?.kind === 'assistant_reasoning') {
        return [{ type: 'thinking', content: event.item.text }];
      }
      return [];
    case 'tool_call_started':
      if (event.item?.kind === 'tool_call') {
        if (emittedToolIds.has(event.item.callId)) {
          return [];
        }
        emittedToolIds.add(event.item.callId);
        return [{
          type: 'tool_use',
          id: event.item.callId,
          input: event.item.arguments,
          name: event.item.toolName,
        }];
      }
      return [];
    case 'tool_call_finished':
      if (event.item?.kind === 'tool_result') {
        return [{
          type: 'tool_result',
          content: toolOutputText(event.item.output),
          id: event.item.callId,
          isError: event.item.isError,
        }];
      }
      return [];
    case 'model_request_retry':
      return [{
        type: 'notice',
        content: `Modos is retrying the model request (attempt ${event.attempt ?? '?'} of ${event.maxAttempts ?? '?'}).`,
        level: 'warning',
      }];
    case 'compaction_completed':
      return [{ type: 'context_compacted' }];
    case 'error':
      if (event.severity === 'error' || event.severity === 'warning') {
        return [{
          type: 'notice',
          content: event.message ?? 'Modos runtime error.',
          level: event.severity === 'error' ? 'warning' : 'info',
        }];
      }
      return [];
    default:
      return [];
  }
}

export function isTerminalTurnEvent(event: ModosRuntimeEvent, turnId: string): boolean {
  return (
    event.turnId === turnId
    && (event.kind === 'turn_completed'
      || event.kind === 'turn_failed'
      || event.kind === 'turn_aborted')
  );
}

export function terminalTurnError(event: ModosRuntimeEvent): string | null {
  if (event.kind !== 'turn_failed') {
    return null;
  }
  return event.message ?? 'Modos turn failed.';
}

export function buildModosUsageInfo(
  usage: ModosUsageSnapshot,
  model: string | null,
  contextWindow: number,
): UsageInfo {
  const contextTokens = usage.promptTokens;
  const percentage = contextWindow > 0
    ? Math.min(100, Math.max(0, Math.round((contextTokens / contextWindow) * 100)))
    : 0;
  return {
    cacheCreationInputTokens: usage.cacheWriteTokens ?? 0,
    cacheReadInputTokens: usage.cacheHitTokens ?? 0,
    contextTokens,
    contextWindow,
    contextWindowIsAuthoritative: contextWindow > 0,
    inputTokens: contextTokens,
    ...(model ? { model } : {}),
    percentage,
  };
}

function toolOutputText(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}
