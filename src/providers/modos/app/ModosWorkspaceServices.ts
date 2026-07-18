import { ProviderWorkspaceRegistry } from '../../../core/providers/ProviderWorkspaceRegistry';
import type {
  ProviderTabWarmupPolicy,
  ProviderWorkspaceRegistration,
  ProviderWorkspaceServices,
} from '../../../core/providers/types';
import { ModosCliResolver } from '../runtime/ModosCliResolver';
import { ModosServeManager } from '../runtime/ModosServeProcess';
import { modosSettingsTabRenderer } from '../ui/ModosSettingsTab';

export interface ModosWorkspaceServices extends ProviderWorkspaceServices {
  serveManager: ModosServeManager;
}

const modosTabWarmupPolicy: ProviderTabWarmupPolicy = {
  resolveMode() {
    // HTTP runtime: no session warmup needed for blank tabs.
    return 'none';
  },
};

export const modosWorkspaceRegistration: ProviderWorkspaceRegistration<ModosWorkspaceServices> = {
  initialize: async (context) => {
    const serveManager = new ModosServeManager(context.plugin, new ModosCliResolver());
    return {
      cliResolver: new ModosCliResolver(),
      dispose: async () => {
        await serveManager.shutdown();
      },
      serveManager,
      settingsTabRenderer: modosSettingsTabRenderer,
      tabWarmupPolicy: modosTabWarmupPolicy,
    };
  },
};

export function maybeGetModosWorkspaceServices(): ModosWorkspaceServices | null {
  return ProviderWorkspaceRegistry.getServices('modos') as ModosWorkspaceServices | null;
}
