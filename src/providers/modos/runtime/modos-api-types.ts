/**
 * Wire shapes of the MODOS HTTP API (`modos serve`). Field names are
 * camelCase on the wire; only the fields the plugin consumes are declared.
 */

export interface ModosThread {
  id: string;
  title: string;
  workspace: string;
  model: string;
  providerId?: string;
  mode: 'agent' | 'plan';
  status: 'idle' | 'running' | 'archived' | 'deleted';
  createdAt: string;
  updatedAt: string;
  turns?: ModosTurn[];
  /** Present on GET /v1/threads/:id — SSE replay cursor baseline. */
  latestSeq?: number;
}

export interface ModosThreadSummary {
  id: string;
  title: string;
  workspace: string;
  status: ModosThread['status'];
  updatedAt: string;
  latestTurnStatus?: ModosTurnStatus;
  needsInput?: boolean;
}

export type ModosTurnStatus = 'queued' | 'running' | 'completed' | 'failed' | 'aborted';

export interface ModosTurn {
  id: string;
  threadId: string;
  status: ModosTurnStatus;
  prompt: string;
  createdAt: string;
  finishedAt?: string;
  items: ModosTurnItem[];
  error?: string;
}

export type ModosTurnItem =
  | ModosUserMessageItem
  | ModosAssistantTextItem
  | ModosAssistantReasoningItem
  | ModosToolCallItem
  | ModosToolResultItem
  | ModosApprovalItem
  | ModosUserInputItem
  | ModosCompactionItem
  | ModosErrorItem;

interface ModosTurnItemBase {
  id: string;
  turnId: string;
  threadId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
  createdAt: string;
  finishedAt?: string;
}

export interface ModosUserMessageItem extends ModosTurnItemBase {
  kind: 'user_message';
  text: string;
  displayText?: string;
}

export interface ModosAssistantTextItem extends ModosTurnItemBase {
  kind: 'assistant_text';
  text: string;
}

export interface ModosAssistantReasoningItem extends ModosTurnItemBase {
  kind: 'assistant_reasoning';
  text: string;
}

export interface ModosToolCallItem extends ModosTurnItemBase {
  kind: 'tool_call';
  toolName: string;
  callId: string;
  arguments: Record<string, unknown>;
  summary?: string;
}

export interface ModosToolResultItem extends ModosTurnItemBase {
  kind: 'tool_result';
  toolName: string;
  callId: string;
  output: unknown;
  isError: boolean;
}

export interface ModosApprovalItem extends ModosTurnItemBase {
  kind: 'approval';
  approvalId: string;
  toolName: string;
  summary: string;
}

export interface ModosUserInputOption {
  label: string;
  description: string;
}

export interface ModosUserInputQuestion {
  header: string;
  id: string;
  question: string;
  options: ModosUserInputOption[];
  selectionMode?: 'single' | 'multiple';
  minSelections?: number;
  maxSelections?: number;
}

export interface ModosUserInputItem extends ModosTurnItemBase {
  kind: 'user_input';
  inputId: string;
  prompt: string;
  questions: ModosUserInputQuestion[];
}

export interface ModosCompactionItem extends ModosTurnItemBase {
  kind: 'compaction';
  summary: string;
  replacedTokens: number;
  auto?: boolean;
}

export interface ModosErrorItem extends ModosTurnItemBase {
  kind: 'error';
  message: string;
}

export interface ModosUsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens?: number;
  cacheWriteTokens?: number;
  cacheHitRate: number | null;
  turns: number;
  costUsd?: number;
}

/** RuntimeEvent (loose): kind-discriminated payload carried over SSE. */
export interface ModosRuntimeEvent {
  kind: string;
  seq: number;
  timestamp: string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  item?: ModosTurnItem;
  // approval events
  approvalId?: string;
  toolName?: string;
  status?: string;
  summary?: string;
  reason?: string;
  // user input events
  inputId?: string;
  prompt?: string;
  questions?: ModosUserInputQuestion[];
  // turn lifecycle
  message?: string;
  severity?: 'info' | 'warning' | 'error';
  // retry
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  // compaction
  auto?: boolean;
  replacedTokens?: number;
  // usage
  model?: string;
  usage?: ModosUsageSnapshot;
}

export interface ModosRuntimeInfo {
  model?: string;
  endpointFormat?: string;
  approvalPolicy?: string;
  sandboxMode?: string;
  dataDir: string;
}

export interface ModosStartTurnResponse {
  threadId: string;
  turnId: string;
  userMessageItemId: string;
}

export interface ModosInterruptTurnResponse {
  threadId: string;
  turnId: string;
  status: ModosTurnStatus;
}

export interface ModosApprovalConsentResponse {
  approvalId: string;
  decision: 'allow' | 'deny';
  consentToken: string;
  expiresAt: number;
}

export interface ModosAttachmentMetadata {
  id: string;
  name: string;
  mimeType?: string;
}

export interface ModosCompactResponse {
  threadId: string;
  replacedTokens: number;
  summary: string;
}

export interface ModosRewindResponse {
  threadId: string;
  turnId: string;
  removedTurns: number;
  remainingTurns: number;
}
