import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getModosState } from '../types';

function invalidateModosConversationSessions(conversations: Conversation[]): Conversation[] {
  const invalidated: Conversation[] = [];
  for (const conversation of conversations) {
    if (conversation.providerId !== 'modos') {
      continue;
    }

    const state = getModosState(conversation.providerState);
    if (!conversation.sessionId && !state.threadId) {
      continue;
    }

    conversation.sessionId = null;
    conversation.providerState = undefined;
    invalidated.push(conversation);
  }
  return invalidated;
}

/**
 * MODOS threads live inside the runtime's data dir; environment changes that
 * affect the data dir or CLI location invalidate resume state, everything
 * else is modelled as model-variant normalization only.
 */
export const modosSettingsReconciler: ProviderSettingsReconciler = {
  invalidateConversationSessions: invalidateModosConversationSessions,

  reconcileModelWithEnvironment(
    _settings: Record<string, unknown>,
    _conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    // The MODOS runtime owns model routing; there is no client-side model
    // catalog to invalidate when the environment changes.
    return { changed: false, invalidatedConversations: [] };
  },

  normalizeModelVariantSettings(_settings: Record<string, unknown>): boolean {
    return false;
  },
};
