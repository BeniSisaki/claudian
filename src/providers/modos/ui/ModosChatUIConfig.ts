import type {
  ProviderChatUIConfig,
  ProviderPermissionModeToggleConfig,
  ProviderUIOption,
} from '../../../core/providers/types';
import { MODOS_PROVIDER_ICON } from '../../../shared/icons';
import {
  decodeModosModelId,
  findModosModel,
  isModosModelSelectionId,
  MODOS_SYNTHETIC_MODEL_ID,
  type ModosDiscoveredModel,
} from '../models';
import { getModosProviderSettings, updateModosProviderSettings } from '../settings';

const DEFAULT_CONTEXT_WINDOW = 200_000;
const FALLBACK_MODEL_OPTION: ProviderUIOption = {
  value: MODOS_SYNTHETIC_MODEL_ID,
  label: 'Modos',
  description: 'Runtime default model',
};

const MODOS_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'normal',
  inactiveLabel: 'Ask before tools',
  activeValue: 'yolo',
  activeLabel: 'Auto-approve',
};

export const modosChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings): ProviderUIOption[] {
    const modosSettings = getModosProviderSettings(settings);
    const options: ProviderUIOption[] = [];
    const seen = new Set<string>();

    for (const model of modosSettings.discoveredModels) {
      pushOption(options, seen, model.encodedId, buildModelOption(model));
    }

    const selected = modosSettings.selectedModel;
    if (selected && !seen.has(selected) && decodeModosModelId(selected)) {
      pushOption(options, seen, selected, {
        description: 'Selected model',
        label: formatFallbackLabel(selected),
        value: selected,
      });
    }

    return options.length > 0 ? options : [{ ...FALLBACK_MODEL_OPTION }];
  },

  getDefaultModel(settings): string | null {
    const selected = getModosProviderSettings(settings).selectedModel;
    return selected || null;
  },

  ownsModel(model: string): boolean {
    // Never claim the empty/unknown model: the global router falls back to
    // the default provider for those, and claiming them would hijack it.
    return model === MODOS_SYNTHETIC_MODEL_ID || isModosModelSelectionId(model);
  },

  isAdaptiveReasoningModel(): boolean {
    return false;
  },

  getReasoningOptions() {
    return [];
  },

  getDefaultReasoningValue(): string {
    return 'off';
  },

  getContextWindowSize(
    model: string,
    customLimits?: Record<string, number>,
    settings?: Record<string, unknown>,
  ): number {
    if (settings) {
      const modosSettings = getModosProviderSettings(settings);
      const discovered = findModosModel(modosSettings, model);
      if (discovered?.contextWindow) {
        return discovered.contextWindow;
      }
      if (modosSettings.contextWindowTokens > 0) {
        return modosSettings.contextWindowTokens;
      }
    }
    return customLimits?.[model] ?? DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return model === MODOS_SYNTHETIC_MODEL_ID || isModosModelSelectionId(model);
  },

  applyModelDefaults(model: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }
    const settingsBag = settings as Record<string, unknown>;
    updateModosProviderSettings(settingsBag, {
      selectedModel: isModosModelSelectionId(model) ? model : '',
    });
  },

  normalizeModelVariant(model: string): string {
    return model === MODOS_SYNTHETIC_MODEL_ID || isModosModelSelectionId(model) ? model : '';
  },

  getCustomModelIds(): Set<string> {
    return new Set<string>();
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return MODOS_PERMISSION_MODE_TOGGLE;
  },

  resolvePermissionMode(settings: Record<string, unknown>): string | null {
    return getModosProviderSettings(settings).approvalPolicy === 'auto' ? 'yolo' : 'normal';
  },

  applyPermissionMode(value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }
    const settingsBag = settings as Record<string, unknown>;
    settingsBag.permissionMode = value;
    updateModosProviderSettings(settingsBag, {
      approvalPolicy: value === 'yolo' ? 'auto' : 'on-request',
    });
  },

  getProviderIcon() {
    return MODOS_PROVIDER_ICON;
  },
};

function buildModelOption(model: ModosDiscoveredModel): ProviderUIOption {
  return {
    description: model.provider === 'modos' ? 'MODOS runtime' : `${model.provider} provider`,
    label: model.label,
    value: model.encodedId,
  };
}

function formatFallbackLabel(encodedId: string): string {
  const decoded = decodeModosModelId(encodedId);
  if (!decoded) {
    return 'Modos';
  }
  return decoded.providerId ? `${decoded.providerId}/${decoded.modelId}` : decoded.modelId;
}

function pushOption(
  target: ProviderUIOption[],
  seenValues: Set<string>,
  value: string,
  option: ProviderUIOption,
): void {
  if (seenValues.has(value)) {
    return;
  }
  seenValues.add(value);
  target.push(option);
}
