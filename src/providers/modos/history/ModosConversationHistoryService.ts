import type {
  ProviderConversationHistoryService,
  ProviderConversationSessionAvailability,
  ProviderHistoryPathContext,
} from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { buildPersistedModosState, getModosState } from '../types';

/**
 * MODOS threads are the native history store. Hydration and deletion go
 * through the runtime HTTP API; this service only maps conversation state
 * and reports availability. Network hydration lands in a later iteration.
 */
export class ModosConversationHistoryService implements ProviderConversationHistoryService {
  async getConversationSessionAvailability(
    conversation: Conversation,
    _vaultPath: string | null,
    _pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderConversationSessionAvailability> {
    return getModosState(conversation.providerState).threadId ? 'unknown' : 'missing';
  }

  async hydrateConversationHistory(
    _conversation: Conversation,
    _vaultPath: string | null,
    _pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    // History hydration via GET /v1/threads/:id is implemented in Phase 4.
  }

  async deleteConversationSession(
    _conversation: Conversation,
    _vaultPath: string | null,
    _pathContext?: ProviderHistoryPathContext,
  ): Promise<void> {
    // Thread deletion via DELETE /v1/threads/:id is implemented in Phase 4.
  }

  resolveSessionIdForConversation(conversation: Conversation | null): string | null {
    if (!conversation) {
      return null;
    }
    return getModosState(conversation.providerState).threadId ?? null;
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
}
