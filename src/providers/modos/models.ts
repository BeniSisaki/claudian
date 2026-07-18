/**
 * Model selection helpers for the Modos provider.
 *
 * MODOS serves a single configured default model per runtime; the selector
 * exposes it plus any models reported by extension model providers. Selection
 * ids are encoded as `modos/<modelId>` for the default model and
 * `modos/<providerId>/<modelId>` for extension-routed models.
 */
export interface ModosDiscoveredModel {
  contextWindow?: number;
  encodedId: string;
  id: string;
  label: string;
  provider: string;
}

export interface DecodedModosModelId {
  modelId: string;
  /** Undefined for the runtime default provider. */
  providerId?: string;
}

export const MODOS_MODEL_PREFIX = 'modos/';
export const MODOS_DEFAULT_PROVIDER_ID = 'modos';
/** Synthetic selection shown when the runtime model list has not been discovered yet. */
export const MODOS_SYNTHETIC_MODEL_ID = 'modos';

export function encodeModosModelId(modelId: string, providerId?: string): string {
  const normalizedModel = modelId.trim();
  const normalizedProvider = providerId?.trim() ?? '';
  if (!normalizedModel) {
    return '';
  }
  return normalizedProvider && normalizedProvider !== MODOS_DEFAULT_PROVIDER_ID
    ? `${MODOS_MODEL_PREFIX}${normalizedProvider}/${normalizedModel}`
    : `${MODOS_MODEL_PREFIX}${normalizedModel}`;
}

export function decodeModosModelId(value: string): DecodedModosModelId | null {
  if (!value.startsWith(MODOS_MODEL_PREFIX)) {
    return null;
  }
  const raw = value.slice(MODOS_MODEL_PREFIX.length).trim();
  if (!raw) {
    return null;
  }
  const slashIndex = raw.indexOf('/');
  if (slashIndex > 0 && slashIndex < raw.length - 1) {
    const providerId = raw.slice(0, slashIndex).trim();
    const modelId = raw.slice(slashIndex + 1).trim();
    if (providerId && modelId) {
      return { modelId, providerId };
    }
  }
  return { modelId: raw };
}

export function isModosModelSelectionId(value: string): boolean {
  return decodeModosModelId(value) !== null;
}

export function normalizeModosDiscoveredModels(value: unknown): ModosDiscoveredModel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: ModosDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const provider = typeof record.provider === 'string' && record.provider.trim()
      ? record.provider.trim()
      : MODOS_DEFAULT_PROVIDER_ID;
    if (!id) {
      continue;
    }
    const encodedId = encodeModosModelId(id, provider);
    if (seen.has(encodedId)) {
      continue;
    }
    seen.add(encodedId);
    const label = typeof record.label === 'string' && record.label.trim()
      ? record.label.trim()
      : provider === MODOS_DEFAULT_PROVIDER_ID
        ? id
        : `${provider}/${id}`;
    const contextWindow = typeof record.contextWindow === 'number'
      && Number.isFinite(record.contextWindow)
      && record.contextWindow > 0
      ? Math.floor(record.contextWindow)
      : undefined;
    normalized.push({
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      encodedId,
      id,
      label,
      provider,
    });
  }
  return normalized;
}

export function findModosModel(
  settings: { discoveredModels: ModosDiscoveredModel[] },
  encodedId: string,
): ModosDiscoveredModel | null {
  return settings.discoveredModels.find((model) => model.encodedId === encodedId) ?? null;
}
