import type {
  ProviderConversationHistoryService,
  ProviderConversationSessionAvailability,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type { ChatMessage, ContentBlock, Conversation, ToolCallInfo } from '../../../core/types';
import { maybeGetModosWorkspaceServices } from '../app/ModosWorkspaceServices';
import type { ModosThread, ModosTurn, ModosTurnItem } from '../runtime/modos-api-types';
import { ModosHttpClient, ModosHttpError } from '../runtime/ModosHttpClient';
import { buildPersistedModosState, getModosState } from '../types';

/**
 * MODOS threads are the native history store. Hydration and deletion go
 * through the runtime HTTP API — files inside the MODOS data dir are never
 * touched directly.
 */
export class ModosConversationHistoryService implements ProviderConversationHistoryService {
  async getConversationSessionAvailability(
    conversation: Conversation,
    _vaultPath: string | null,
    _pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderConversationSessionAvailability> {
    const threadId = resolveThreadId(conversation);
    if (!threadId) {
      return 'missing';
    }
    const client = await this.resolveClient();
    if (!client) {
      return 'unknown';
    }
    try {
      await client.get<ModosThread>(`/v1/threads/${encodeURIComponent(threadId)}`);
      return 'available';
    } catch (error) {
      if (error instanceof ModosHttpError && error.status === 404) {
        return 'missing';
      }
      return 'unknown';
    }
  }

  async hydrateConversationHistory(
    conversation: Conversation,
    _vaultPath: string | null,
    _pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const threadId = resolveThreadId(conversation);
    if (!threadId) {
      return;
    }
    const client = await this.resolveClient();
    if (!client) {
      return;
    }
    try {
      const thread = await client.get<ModosThread>(
        `/v1/threads/${encodeURIComponent(threadId)}`,
      );
      const messages = buildMessagesFromThread(thread);
      if (messages.length > 0) {
        conversation.messages = messages;
      }
      conversation.sessionId = thread.id;
    } catch {
      // Keep whatever messages the conversation already has; a missing or
      // unreachable runtime must not blank the local copy.
    }
  }

  async deleteConversationSession(
    conversation: Conversation,
    _vaultPath: string | null,
    _pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    const threadId = resolveThreadId(conversation);
    if (threadId) {
      const client = await this.resolveClient();
      await client
        ?.delete(`/v1/threads/${encodeURIComponent(threadId)}`)
        .catch(() => undefined);
    }
    conversation.sessionId = null;
    conversation.providerState = undefined;
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    if (!conversation) {
      return null;
    }
    return resolveThreadId(conversation);
  }

  isPendingForkConversation(conversation: Conversation): boolean {
    return getModosState(conversation.providerState).forkSource !== undefined;
  }

  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    _sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      forkSource: {
        resumeAt,
        sessionId: sourceSessionId,
      },
    };
  }

  buildPersistedProviderState(conversation: Conversation): Record<string, unknown> | undefined {
    return buildPersistedModosState(getModosState(conversation.providerState)) as
      | Record<string, unknown>
      | undefined;
  }

  private async resolveClient(): Promise<ModosHttpClient | null> {
    const workspace = maybeGetModosWorkspaceServices();
    if (!workspace) {
      return null;
    }
    try {
      const connection = await workspace.serveManager.ensureReady();
      return new ModosHttpClient(connection);
    } catch {
      return null;
    }
  }
}

function resolveThreadId(conversation: Conversation): string | null {
  return getModosState(conversation.providerState).threadId
    ?? conversation.sessionId
    ?? null;
}

function buildMessagesFromThread(thread: ModosThread): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const turns = [...(thread.turns ?? [])].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  );

  for (const turn of turns) {
    const items = [...turn.items].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const userItem = items.find((item) => item.kind === 'user_message');
    if (userItem && userItem.kind === 'user_message') {
      messages.push({
        assistantMessageId: turn.id,
        content: userItem.displayText ?? userItem.text,
        id: userItem.id,
        role: 'user',
        timestamp: parseTimestamp(userItem.createdAt),
        userMessageId: userItem.id,
      });
    }

    const assistant = buildAssistantMessage(turn, items);
    if (assistant) {
      messages.push(assistant);
    }
  }

  return messages;
}

function buildAssistantMessage(turn: ModosTurn, items: ModosTurnItem[]): ChatMessage | null {
  const contentBlocks: ContentBlock[] = [];
  const textParts: string[] = [];
  const toolCalls: ToolCallInfo[] = [];
  const toolOutputs = new Map<string, { content: string; isError: boolean }>();
  let lastTimestamp = parseTimestamp(turn.finishedAt ?? turn.createdAt);

  for (const item of items) {
    lastTimestamp = parseTimestamp(item.createdAt);
    switch (item.kind) {
      case 'assistant_text':
        textParts.push(item.text);
        contentBlocks.push({ content: item.text, type: 'text' });
        break;
      case 'assistant_reasoning':
        contentBlocks.push({ content: item.text, type: 'thinking' });
        break;
      case 'tool_call':
        contentBlocks.push({ toolId: item.callId, type: 'tool_use' });
        toolCalls.push({
          id: item.callId,
          input: item.arguments,
          name: item.toolName,
          status: 'running',
        });
        break;
      case 'tool_result':
        toolOutputs.set(item.callId, {
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
          isError: item.isError,
        });
        break;
      case 'compaction':
        contentBlocks.push({ type: 'context_compacted' });
        break;
      default:
        break;
    }
  }

  if (contentBlocks.length === 0 && toolCalls.length === 0) {
    return null;
  }

  for (const toolCall of toolCalls) {
    const output = toolOutputs.get(toolCall.id);
    if (output) {
      toolCall.result = output.content;
      toolCall.status = output.isError ? 'error' : 'completed';
    } else if (turn.status === 'failed' || turn.status === 'aborted') {
      toolCall.status = 'error';
    } else if (turn.status === 'completed') {
      toolCall.status = 'completed';
    }
  }

  return {
    assistantMessageId: turn.id,
    content: textParts.join('\n'),
    contentBlocks,
    id: `assistant_${turn.id}`,
    role: 'assistant',
    timestamp: lastTimestamp,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
