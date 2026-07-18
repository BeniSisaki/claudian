import type { ProviderModule } from '../../core/providers/types';
import { modosWorkspaceRegistration } from './app/ModosWorkspaceServices';
import { ModosInlineEditService } from './auxiliary/ModosInlineEditService';
import { ModosInstructionRefineService } from './auxiliary/ModosInstructionRefineService';
import { ModosTaskResultInterpreter } from './auxiliary/ModosTaskResultInterpreter';
import { ModosTitleGenerationService } from './auxiliary/ModosTitleGenerationService';
import { MODOS_PROVIDER_CAPABILITIES } from './capabilities';
import { modosSettingsReconciler } from './env/ModosSettingsReconciler';
import { ModosConversationHistoryService } from './history/ModosConversationHistoryService';
import { ModosChatRuntime } from './runtime/ModosChatRuntime';
import { getModosProviderSettings, updateModosProviderSettings } from './settings';
import { modosChatUIConfig } from './ui/ModosChatUIConfig';

export const modosProviderRegistration: ProviderModule = {
  id: 'modos',
  blankTabOrder: 12,
  capabilities: MODOS_PROVIDER_CAPABILITIES,
  chatUIConfig: modosChatUIConfig,
  createInlineEditService: (plugin) => new ModosInlineEditService(plugin),
  createInstructionRefineService: (plugin) => new ModosInstructionRefineService(plugin),
  createRuntime: ({ plugin }) => new ModosChatRuntime(plugin),
  createTitleGenerationService: (plugin) => new ModosTitleGenerationService(plugin),
  displayName: 'Modos',
  environmentKeyPatterns: [/^MODOS_/i, /^DEEPSEEK_/i],
  historyService: new ModosConversationHistoryService(),
  isEnabled: (settings) => getModosProviderSettings(settings).enabled,
  setEnabled: (settings, enabled) => updateModosProviderSettings(settings, { enabled }),
  settingsReconciler: modosSettingsReconciler,
  settingsStorage: {
    hostScopedFields: ['cliPathsByHost'],
    normalizeStored(target, stored) {
      updateModosProviderSettings(target, getModosProviderSettings(stored));
      return false;
    },
  },
  taskResultInterpreter: new ModosTaskResultInterpreter(),
  workspace: modosWorkspaceRegistration,
};
