import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  ApprovalDecision,
  AskUserQuestionCallback,
  AutoTurnCallback,
  ChatRewindMode,
  ChatRewindResult,
  ChatRuntimeConversationState,
  ChatRuntimeEnsureReadyOptions,
  ChatRuntimeQueryOptions,
  ChatTurnMetadata,
  ChatTurnRequest,
  ExitPlanModeCallback,
  PreparedChatTurn,
  SessionUpdateResult,
} from '../../../core/runtime/types';
import type { ProviderCapabilities, ProviderId } from '../../../core/providers/types';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type {
  ChatMessage,
  Conversation,
  ImageAttachment,
  SlashCommand,
  StreamChunk,
} from '../../../core/types';
import { getVaultPath } from '../../../utils/path';
import { maybeGetModosWorkspaceServices } from '../app/ModosWorkspaceServices';
import { MODOS_PROVIDER_CAPABILITIES } from '../capabilities';
import { decodeModosModelId } from '../models';
import {
  buildModosUsageInfo,
  isTerminalTurnEvent,
  normalizeModosRuntimeEvent,
  terminalTurnError,
} from '../normalization/modosEventNormalization';
import { getModosProviderSettings, updateModosProviderSettings } from '../settings';
import type { ModosProviderState } from '../types';
import { buildPersistedModosState, getModosState } from '../types';
import type { ModosCliResolver } from './ModosCliResolver';
import {
  ModosHttpClient,
  ModosHttpError,
  ModosSseOverflowError,
} from './ModosHttpClient';
import type {
  ModosCompactResponse,
  ModosApprovalConsentResponse,
  ModosInterruptTurnResponse,
  ModosRewindResponse,
  ModosRuntimeEvent,
  ModosRuntimeInfo,
  ModosStartTurnResponse,
  ModosThread,
  ModosUsageSnapshot,
  ModosAttachmentMetadata,
} from './modos-api-types';
import type { ModosServeConnection, ModosServeManager } from './ModosServeProcess';
import { ModosServeManager as ModosServeManagerClass } from './ModosServeProcess';

type ActiveTurn = {
  abort: AbortController;
  cancelled: boolean;
  turnId: string;
};

/**
 * Chat runtime backed by a shared `modos serve` child process. Turns run
 * through the MODOS HTTP API (`POST /v1/threads/:id/turns`) and stream back
 * over SSE; approvals and structured user input round-trip through the
 * matching HTTP endpoints, so nothing in this runtime is one-way.
 */
export class ModosChatRuntime implements ChatRuntime {
  readonly providerId: ProviderId = 'modos';

  private activeTurn: ActiveTurn | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  private autoTurnCallback: AutoTurnCallback | null = null;
  private client: ModosHttpClient | null = null;
  private connection: ModosServeConnection | null = null;
  private conversationGeneration = 0;
  private currentTurnMetadata: ChatTurnMetadata = {};
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private forkSource: { resumeAt: string; sessionId: string } | null = null;
  private lastUsage: ModosUsageSnapshot | null = null;
  private lastUsageModel: string | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private readyListeners = new Set<(ready: boolean) => void>();
  private selectedModel: string | null = null;
  private serveManager: ModosServeManager;
  private sessionInvalidated = false;
  private threadId: string | null = null;

  constructor(private readonly plugin: ProviderHost) {
    const workspace = maybeGetModosWorkspaceServices();
    this.serveManager = workspace?.serveManager
      ?? new ModosServeManagerClass(plugin, workspace?.cliResolver as ModosCliResolver | null);
  }

  getCapabilities(): Readonly<ProviderCapabilities> {
    return MODOS_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    const text = request.text;
    const isCompact = /^\/compact\b/i.test(text.trim());
    return {
      isCompact,
      mcpMentions: new Set<string>(),
      persistedContent: text,
      prompt: text,
      request,
    };
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  setResumeCheckpoint(_checkpointId: string | undefined): void {
    // MODOS threads are server-persisted; no client checkpoint needed.
  }

  syncConversationState(conversation: ChatRuntimeConversationState | null): void {
    this.conversationGeneration += 1;
    const state = getModosState(conversation?.providerState);
    this.threadId = state.threadId ?? null;
    this.forkSource = state.forkSource ?? null;
    this.selectedModel = conversation?.selectedModel ?? null;
    this.client = null;
    this.connection = null;
    this.notifyReadyState();
  }

  async reloadMcpServers(): Promise<void> {
    // MCP server selection is not wired for MODOS in this iteration.
  }

  async ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    try {
      if (!this.connection) {
        this.connection = await this.serveManager.ensureReady();
        this.client = new ModosHttpClient(this.connection);
      }
      if (this.forkSource) {
        await this.materializePendingFork();
      }
      if (!this.threadId && options?.allowSessionCreation !== false) {
        await this.createThread();
      }
      this.notifyReadyState();
      return this.client !== null && this.threadId !== null;
    } catch {
      this.notifyReadyState();
      return false;
    }
  }

  async *query(
    turn: PreparedChatTurn,
    _conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    const generation = this.conversationGeneration;
    try {
      const ready = await this.ensureReady({ allowSessionCreation: true });
      if (!ready || !this.client || !this.threadId) {
        yield {
          type: 'error',
          content: this.formatServeDiagnostics()
            ?? 'Failed to start modos serve. Check the CLI path and environment.',
        };
        yield { type: 'done' };
        return;
      }
      if (generation !== this.conversationGeneration) {
        yield { type: 'error', content: 'Modos conversation changed before the turn started.' };
        yield { type: 'done' };
        return;
      }

      if (turn.isCompact) {
        yield* this.runCompactTurn(turn);
        return;
      }

      const client = this.client;
      const threadId = this.threadId;

      const thread = await client.get<ModosThread>(`/v1/threads/${encodeURIComponent(threadId)}`);
      const sinceSeq = thread.latestSeq ?? 0;

      const attachmentIds = await this.uploadAttachments(threadId, turn.request.images ?? []);
      const modelSelection = this.resolveModelSelection(queryOptions);
      const decoded = modelSelection ? decodeModosModelId(modelSelection) : null;

      yield { type: 'user_message_start', content: turn.request.text };

      let started: ModosStartTurnResponse;
      try {
        started = await client.post<ModosStartTurnResponse>(
          `/v1/threads/${encodeURIComponent(threadId)}/turns`,
          {
            attachmentIds,
            mode: 'agent',
            prompt: turn.prompt,
            ...(decoded?.modelId ? { model: decoded.modelId } : {}),
            ...(decoded?.providerId ? { providerId: decoded.providerId } : {}),
          },
        );
      } catch (error) {
        yield {
          type: 'error',
          content: error instanceof ModosHttpError && error.status === 409
            ? 'A Modos turn is already running for this conversation.'
            : this.formatError(error, 'Failed to start the Modos turn.'),
        };
        yield { type: 'done' };
        return;
      }

      this.currentTurnMetadata = {
        assistantMessageId: started.turnId,
        userMessageId: started.userMessageItemId,
        wasSent: true,
      };

      const activeTurn: ActiveTurn = {
        abort: new AbortController(),
        cancelled: false,
        turnId: started.turnId,
      };
      this.activeTurn = activeTurn;
      try {
        yield* this.streamTurn(threadId, started.turnId, sinceSeq, activeTurn);
      } finally {
        this.activeTurn = null;
      }

      if (generation !== this.conversationGeneration) {
        yield { type: 'done' };
        return;
      }

      const usage = this.consumeUsageChunk();
      if (usage) {
        yield usage;
      }
      yield { type: 'done' };
    } catch (error) {
      yield { type: 'error', content: this.formatError(error, 'Modos runtime error.') };
      yield { type: 'done' };
    }
  }

  async steer(turn: PreparedChatTurn): Promise<boolean> {
    const active = this.activeTurn;
    if (!active || !this.client || !this.threadId) {
      return false;
    }
    try {
      await this.client.post(
        `/v1/threads/${encodeURIComponent(this.threadId)}/turns/${encodeURIComponent(active.turnId)}/steer`,
        { text: turn.request.text },
      );
      return true;
    } catch {
      return false;
    }
  }

  cancel(): void {
    const active = this.activeTurn;
    if (!active) {
      return;
    }
    active.cancelled = true;
    active.abort.abort();
    this.approvalDismisser?.();
    if (this.client && this.threadId) {
      void this.client
        .post<ModosInterruptTurnResponse>(
          `/v1/threads/${encodeURIComponent(this.threadId)}/turns/${encodeURIComponent(active.turnId)}/interrupt`,
          {},
        )
        .catch(() => undefined);
    }
  }

  resetSession(): void {
    this.threadId = null;
    this.forkSource = null;
    this.sessionInvalidated = true;
    this.notifyReadyState();
  }

  getSessionId(): string | null {
    return this.threadId;
  }

  consumeSessionInvalidation(): boolean {
    const invalidated = this.sessionInvalidated;
    this.sessionInvalidated = false;
    return invalidated;
  }

  isReady(): boolean {
    return this.client !== null && this.threadId !== null;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  getAuxiliaryModel(): string | null {
    return null;
  }

  cleanup(): void {
    this.cancel();
    this.readyListeners.clear();
  }

  async rewind(
    userMessageId: string,
    assistantMessageId: string | undefined,
    _mode?: ChatRewindMode,
  ): Promise<ChatRewindResult> {
    if (!this.client || !this.threadId) {
      return { canRewind: false, error: 'Modos runtime is not ready.' };
    }
    const turnId = assistantMessageId ?? userMessageId;
    if (!turnId) {
      return { canRewind: false, error: 'Missing turn reference for rewind.' };
    }
    try {
      await this.client.post<ModosRewindResponse>(
        `/v1/threads/${encodeURIComponent(this.threadId)}/rewind`,
        { turnId },
      );
      return { canRewind: true };
    } catch (error) {
      return { canRewind: false, error: this.formatError(error, 'Modos rewind failed.') };
    }
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(dismisser: (() => void) | null): void {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserQuestionCallback = callback;
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  setAutoTurnCallback(callback: AutoTurnCallback | null): void {
    this.autoTurnCallback = callback;
  }

  consumeTurnMetadata(): ChatTurnMetadata {
    const metadata = this.currentTurnMetadata;
    this.currentTurnMetadata = {};
    return metadata;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    const state: ModosProviderState = {
      ...(this.forkSource ? { forkSource: this.forkSource } : {}),
      ...(this.threadId ? { threadId: this.threadId } : {}),
    };
    const providerState = buildPersistedModosState(state) as Record<string, unknown> | undefined;
    return {
      updates: {
        providerState,
        sessionId: params.sessionInvalidated ? null : this.threadId,
      },
    };
  }

  resolveSessionIdForFork(conversation: Conversation | null): string | null {
    if (conversation) {
      return getModosState(conversation.providerState).threadId ?? this.threadId;
    }
    return this.threadId;
  }

  /* ---------------------------------------------------------------- */
  /* Turn streaming                                                    */
  /* ---------------------------------------------------------------- */

  private async *streamTurn(
    threadId: string,
    turnId: string,
    sinceSeq: number,
    activeTurn: ActiveTurn,
  ): AsyncGenerator<StreamChunk> {
    const client = this.client;
    if (!client) {
      return;
    }

    let cursor = sinceSeq;
    let lastSeqSeen = sinceSeq;
    const emittedToolIds = new Set<string>();
    let sawTerminal = false;

    while (!sawTerminal) {
      try {
        for await (const frame of client.streamEvents(threadId, cursor, activeTurn.abort.signal)) {
          const event = frame.data as ModosRuntimeEvent;
          if (typeof event?.seq === 'number') {
            if (event.seq <= lastSeqSeen) {
              continue;
            }
            lastSeqSeen = event.seq;
            cursor = event.seq;
          }
          if (event.turnId && event.turnId !== turnId) {
            continue;
          }

          if (event.kind === 'approval_requested' && event.status === 'pending' && event.approvalId) {
            await this.resolveApproval(event.approvalId, event.toolName ?? 'tool', event.summary ?? '');
            continue;
          }
          if (event.kind === 'user_input_requested' && event.status === 'pending' && event.inputId) {
            await this.resolveUserInput(event.inputId, event.prompt ?? '', event.questions ?? []);
            continue;
          }
          if (event.kind === 'usage' && event.usage) {
            this.lastUsage = event.usage;
            this.lastUsageModel = event.model ?? null;
            continue;
          }

          for (const chunk of normalizeModosRuntimeEvent(event, emittedToolIds)) {
            yield chunk;
          }

          if (isTerminalTurnEvent(event, turnId)) {
            const failure = terminalTurnError(event);
            if (failure) {
              yield { type: 'error', content: failure };
            }
            sawTerminal = true;
            break;
          }
        }
        // The generator only returns on abort; reaching here without a
        // terminal event means the stream ended unexpectedly.
        if (!sawTerminal) {
          return;
        }
      } catch (error) {
        if (activeTurn.abort.signal.aborted) {
          return;
        }
        if (error instanceof ModosSseOverflowError) {
          // Rebuild the cursor from the thread snapshot and resume.
          const snapshot = await client.get<ModosThread>(
            `/v1/threads/${encodeURIComponent(threadId)}`,
          );
          cursor = snapshot.latestSeq ?? cursor;
          continue;
        }
        throw error;
      }
    }
  }

  private async resolveApproval(
    approvalId: string,
    toolName: string,
    summary: string,
  ): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }

    let decision: 'allow' | 'deny' = 'deny';
    if (this.approvalCallback) {
      try {
        const answer: ApprovalDecision = await this.approvalCallback(
          toolName,
          {},
          summary || `Allow ${toolName}?`,
        );
        decision = answer === 'deny' ? 'deny' : 'allow';
      } catch {
        decision = 'deny';
      }
    }

    try {
      const consent = await client.post<ModosApprovalConsentResponse>(
        `/v1/approvals/${encodeURIComponent(approvalId)}/consent`,
        { decision },
      );
      await client.post(
        `/v1/approvals/${encodeURIComponent(approvalId)}`,
        { decision },
        undefined,
        { 'x-modos-approval-consent': consent.consentToken },
      );
    } catch {
      // The approval may already be resolved (e.g. turn aborted mid-ask).
    }
  }

  private async resolveUserInput(
    inputId: string,
    prompt: string,
    questions: Array<{
      id: string;
      options: Array<{ label: string }>;
      selectionMode?: 'single' | 'multiple';
    }>,
  ): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }

    if (!this.askUserQuestionCallback) {
      await client
        .post(`/v1/user-inputs/${encodeURIComponent(inputId)}`, { cancelled: true })
        .catch(() => undefined);
      return;
    }

    try {
      const answers = await this.askUserQuestionCallback({ prompt, questions });
      if (!answers) {
        await client.post(`/v1/user-inputs/${encodeURIComponent(inputId)}`, { cancelled: true });
        return;
      }
      const mapped = questions.map((question) => {
        const raw = answers[question.id];
        if (Array.isArray(raw)) {
          return {
            id: question.id,
            label: raw[0] ?? '',
            labels: raw,
            value: raw[0] ?? '',
            values: raw,
          };
        }
        const value = typeof raw === 'string' ? raw : '';
        return { id: question.id, label: value, value };
      });
      await client.post(`/v1/user-inputs/${encodeURIComponent(inputId)}`, { answers: mapped });
    } catch {
      await client
        .post(`/v1/user-inputs/${encodeURIComponent(inputId)}`, { cancelled: true })
        .catch(() => undefined);
    }
  }

  private async *runCompactTurn(turn: PreparedChatTurn): AsyncGenerator<StreamChunk> {
    const client = this.client;
    const threadId = this.threadId;
    yield { type: 'user_message_start', content: turn.request.text };
    if (!client || !threadId) {
      yield { type: 'error', content: 'Modos runtime is not ready.' };
      yield { type: 'done' };
      return;
    }
    try {
      const customInstructions = turn.prompt.replace(/^\/compact\s*/i, '').trim();
      await client.post<ModosCompactResponse>(
        `/v1/threads/${encodeURIComponent(threadId)}/compact`,
        customInstructions ? { reason: customInstructions } : {},
      );
      this.currentTurnMetadata = { wasSent: true };
      yield { type: 'context_compacted' };
    } catch (error) {
      yield { type: 'error', content: this.formatError(error, 'Modos compaction failed.') };
    }
    yield { type: 'done' };
  }

  /* ---------------------------------------------------------------- */
  /* Thread lifecycle                                                  */
  /* ---------------------------------------------------------------- */

  private async createThread(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    const info = await client.get<ModosRuntimeInfo>('/v1/runtime/info').catch(() => null);
    await this.syncDiscoveredModels(info);
    const workspace = getVaultPath(this.plugin.app) ?? process.cwd();
    const decoded = this.selectedModel ? decodeModosModelId(this.selectedModel) : null;
    const thread = await client.post<ModosThread>('/v1/threads', {
      mode: 'agent',
      model: decoded?.modelId ?? info?.model ?? 'default',
      title: 'Claudian conversation',
      workspace,
      ...(decoded?.providerId ? { providerId: decoded.providerId } : {}),
    });
    this.threadId = thread.id;
  }

  private async materializePendingFork(): Promise<void> {
    const client = this.client;
    const forkSource = this.forkSource;
    if (!client || !forkSource) {
      return;
    }
    const forked = await client.post<ModosThread>(
      `/v1/threads/${encodeURIComponent(forkSource.sessionId)}/fork`,
      { turnId: forkSource.resumeAt },
    );
    this.threadId = forked.id;
    this.forkSource = null;
  }

  private async syncDiscoveredModels(info: ModosRuntimeInfo | null): Promise<void> {
    const model = info?.model?.trim();
    if (!model) {
      return;
    }
    await this.plugin.mutateSettingsConditionally((settings) => {
      const bag = settings as unknown as Record<string, unknown>;
      const current = getModosProviderSettings(bag);
      if (current.discoveredModels.some((entry) => entry.id === model && entry.provider === 'modos')) {
        return false;
      }
      updateModosProviderSettings(bag, {
        discoveredModels: [
          ...current.discoveredModels,
          { encodedId: `modos/${model}`, id: model, label: model, provider: 'modos' },
        ],
      });
      return true;
    });
  }

  private async uploadAttachments(
    threadId: string,
    images: ImageAttachment[],
  ): Promise<string[]> {
    const client = this.client;
    if (!client || images.length === 0) {
      return [];
    }
    const attachmentIds: string[] = [];
    for (const image of images) {
      const saved = await client.post<{ attachment: ModosAttachmentMetadata }>(
        '/v1/attachments',
        {
          dataBase64: image.data,
          mimeType: image.mediaType,
          name: image.name,
          threadId,
        },
      );
      attachmentIds.push(saved.attachment.id);
    }
    return attachmentIds;
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  private resolveModelSelection(queryOptions?: ChatRuntimeQueryOptions): string | null {
    const candidate = queryOptions?.model ?? this.selectedModel;
    return candidate && decodeModosModelId(candidate) ? candidate : null;
  }

  private consumeUsageChunk(): StreamChunk | null {
    if (!this.lastUsage) {
      return null;
    }
    const contextWindow = this.resolveContextWindow();
    const usage = buildModosUsageInfo(this.lastUsage, this.lastUsageModel, contextWindow);
    this.lastUsage = null;
    return { sessionId: this.threadId, type: 'usage', usage };
  }

  private resolveContextWindow(): number {
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const modosSettings = getModosProviderSettings(settings);
    if (this.selectedModel) {
      const discovered = modosSettings.discoveredModels.find(
        (model) => model.encodedId === this.selectedModel,
      );
      if (discovered?.contextWindow) {
        return discovered.contextWindow;
      }
    }
    return modosSettings.contextWindowTokens > 0
      ? modosSettings.contextWindowTokens
      : 200_000;
  }

  private notifyReadyState(): void {
    const ready = this.isReady();
    for (const listener of this.readyListeners) {
      try {
        listener(ready);
      } catch {
        // Listener errors must not break runtime state transitions.
      }
    }
  }

  private formatServeDiagnostics(): string | null {
    const diagnostics = this.serveManager.getDiagnostics();
    return diagnostics ? `modos serve failed:\n${diagnostics}` : null;
  }

  private formatError(error: unknown, fallback: string): string {
    if (error instanceof ModosHttpError) {
      return error.status === 401
        ? 'Modos runtime token rejected (401). Restart the plugin to relaunch modos serve.'
        : error.message;
    }
    return error instanceof Error ? error.message : fallback;
  }
}
