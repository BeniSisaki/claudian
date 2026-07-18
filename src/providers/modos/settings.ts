import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
import {
  getHostnameKey,
  getLegacyHostnameKey,
  migrateLegacyHostnameKeyedMap,
} from '../../utils/env';
import { type ModosDiscoveredModel,normalizeModosDiscoveredModels } from './models';

export type ModosApprovalPolicy =
  | 'always'
  | 'on-request'
  | 'untrusted'
  | 'never'
  | 'auto'
  | 'suggest';

export type ModosSandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access'
  | 'external-sandbox';

export interface PersistedModosProviderSettings {
  approvalPolicy: ModosApprovalPolicy;
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  /** 0 means the runtime/model default is used for usage display. */
  contextWindowTokens: number;
  dataDir: string;
  discoveredModels: ModosDiscoveredModel[];
  enabled: boolean;
  environmentVariables: string;
  sandboxMode: ModosSandboxMode;
  /** Encoded selection id (`modos/<modelId>`); '' follows the server default. */
  selectedModel: string;
}

export type ModosProviderSettings = PersistedModosProviderSettings;

export const DEFAULT_MODOS_PROVIDER_SETTINGS: Readonly<PersistedModosProviderSettings> = Object.freeze({
  approvalPolicy: 'on-request',
  cliPath: '',
  cliPathsByHost: {},
  contextWindowTokens: 0,
  dataDir: '',
  discoveredModels: [],
  enabled: false,
  environmentVariables: '',
  sandboxMode: 'workspace-write',
  selectedModel: '',
});

const APPROVAL_POLICIES = new Set<ModosApprovalPolicy>([
  'always',
  'on-request',
  'untrusted',
  'never',
  'auto',
  'suggest',
]);

const SANDBOX_MODES = new Set<ModosSandboxMode>([
  'read-only',
  'workspace-write',
  'danger-full-access',
  'external-sandbox',
]);

function normalizeHostnameCliPaths(value: unknown): HostnameCliPaths {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: HostnameCliPaths = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim()) {
      result[key] = entry.trim();
    }
  }
  return result;
}

function normalizeApprovalPolicy(value: unknown): ModosApprovalPolicy {
  return typeof value === 'string' && APPROVAL_POLICIES.has(value as ModosApprovalPolicy)
    ? (value as ModosApprovalPolicy)
    : DEFAULT_MODOS_PROVIDER_SETTINGS.approvalPolicy;
}

function normalizeSandboxMode(value: unknown): ModosSandboxMode {
  return typeof value === 'string' && SANDBOX_MODES.has(value as ModosSandboxMode)
    ? (value as ModosSandboxMode)
    : DEFAULT_MODOS_PROVIDER_SETTINGS.sandboxMode;
}

export function getModosProviderSettings(settings: Record<string, unknown>): ModosProviderSettings {
  const config = getProviderConfig(settings, 'modos');
  const normalizedCliPathsByHost = normalizeHostnameCliPaths(config.cliPathsByHost);
  const cliPathsByHost = Object.keys(normalizedCliPathsByHost).length > 0
    ? migrateLegacyHostnameKeyedMap(
      normalizedCliPathsByHost,
      getHostnameKey(),
      getLegacyHostnameKey(),
    )
    : normalizedCliPathsByHost;

  return {
    approvalPolicy: normalizeApprovalPolicy(config.approvalPolicy),
    cliPath: (config.cliPath as string | undefined) ?? DEFAULT_MODOS_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost,
    contextWindowTokens:
      typeof config.contextWindowTokens === 'number'
      && Number.isFinite(config.contextWindowTokens)
      && config.contextWindowTokens > 0
        ? Math.floor(config.contextWindowTokens)
        : DEFAULT_MODOS_PROVIDER_SETTINGS.contextWindowTokens,
    dataDir: typeof config.dataDir === 'string' ? config.dataDir.trim() : '',
    discoveredModels: normalizeModosDiscoveredModels(config.discoveredModels),
    enabled: (config.enabled as boolean | undefined) ?? DEFAULT_MODOS_PROVIDER_SETTINGS.enabled,
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'modos')
      ?? DEFAULT_MODOS_PROVIDER_SETTINGS.environmentVariables,
    sandboxMode: normalizeSandboxMode(config.sandboxMode),
    selectedModel: typeof config.selectedModel === 'string' ? config.selectedModel.trim() : '',
  };
}

export function updateModosProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<ModosProviderSettings>,
): ModosProviderSettings {
  const current = getModosProviderSettings(settings);
  const hostnameKey = getHostnameKey();

  const nextCliPathsByHost = 'cliPathsByHost' in updates
    ? normalizeHostnameCliPaths(updates.cliPathsByHost)
    : { ...current.cliPathsByHost };
  let nextCliPath = 'cliPathsByHost' in updates
    ? (
      typeof updates.cliPath === 'string'
        ? updates.cliPath.trim()
        : DEFAULT_MODOS_PROVIDER_SETTINGS.cliPath
    )
    : current.cliPath.trim();

  if ('cliPath' in updates && !('cliPathsByHost' in updates)) {
    const trimmedCliPath = typeof updates.cliPath === 'string' ? updates.cliPath.trim() : '';
    if (trimmedCliPath) {
      nextCliPathsByHost[hostnameKey] = trimmedCliPath;
    } else {
      delete nextCliPathsByHost[hostnameKey];
    }
    nextCliPath = DEFAULT_MODOS_PROVIDER_SETTINGS.cliPath;
  }

  const next: ModosProviderSettings = {
    ...current,
    ...updates,
    approvalPolicy: normalizeApprovalPolicy(updates.approvalPolicy ?? current.approvalPolicy),
    cliPath: nextCliPath,
    cliPathsByHost: nextCliPathsByHost,
    discoveredModels: normalizeModosDiscoveredModels(
      updates.discoveredModels ?? current.discoveredModels,
    ),
    sandboxMode: normalizeSandboxMode(updates.sandboxMode ?? current.sandboxMode),
  };

  setProviderConfig(settings, 'modos', {
    approvalPolicy: next.approvalPolicy,
    cliPath: next.cliPath,
    cliPathsByHost: next.cliPathsByHost,
    contextWindowTokens: next.contextWindowTokens,
    dataDir: next.dataDir,
    discoveredModels: next.discoveredModels,
    enabled: next.enabled,
    environmentVariables: next.environmentVariables,
    sandboxMode: next.sandboxMode,
    selectedModel: next.selectedModel,
  });

  return next;
}
