export interface ModosForkSource {
  resumeAt: string;
  sessionId: string;
}

export interface ModosProviderState {
  forkSource?: ModosForkSource;
  /** MODOS thread backing this conversation. */
  threadId?: string;
}

export function getModosState(value: unknown): ModosProviderState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const forkSource = getModosForkSource(record.forkSource);
  return {
    ...(forkSource ? { forkSource } : {}),
    ...(typeof record.threadId === 'string' && record.threadId.trim()
      ? { threadId: record.threadId.trim() }
      : {}),
  };
}

export function buildPersistedModosState(state: ModosProviderState): ModosProviderState | undefined {
  const persisted: ModosProviderState = {
    ...(state.forkSource ? { forkSource: state.forkSource } : {}),
    ...(state.threadId ? { threadId: state.threadId } : {}),
  };

  return Object.keys(persisted).length > 0 ? persisted : undefined;
}

function getModosForkSource(value: unknown): ModosForkSource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
  const resumeAt = typeof record.resumeAt === 'string' ? record.resumeAt.trim() : '';
  return sessionId && resumeAt ? { resumeAt, sessionId } : undefined;
}
