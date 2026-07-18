import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { maybeGetModosWorkspaceServices } from '../app/ModosWorkspaceServices';
import { encodeModosModelId, type ModosDiscoveredModel } from '../models';
import { getModosProviderSettings, updateModosProviderSettings } from '../settings';
import type { ModosRuntimeInfo } from './modos-api-types';
import { ModosHttpClient } from './ModosHttpClient';

export type ModosModelDiscoveryResult =
  | { kind: 'completed'; diagnostics?: string; models: ModosDiscoveredModel[] }
  | { kind: 'failed'; diagnostics: string; models: ModosDiscoveredModel[] };

/**
 * Discovers what the MODOS runtime can serve. v1 reports the runtime's
 * configured default model (from `/v1/runtime/info`); extension-provided
 * models are appended later once account binding is designed.
 */
export class ModosModelDiscoveryService {
  constructor(private readonly plugin: ProviderHost) {}

  async discoverModels(): Promise<ModosModelDiscoveryResult> {
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    if (!getModosProviderSettings(settings).enabled) {
      return { diagnostics: 'Modos provider is disabled.', kind: 'failed', models: [] };
    }

    const workspace = maybeGetModosWorkspaceServices();
    if (!workspace) {
      return { diagnostics: 'Modos workspace services are not initialized.', kind: 'failed', models: [] };
    }

    try {
      const connection = await workspace.serveManager.ensureReady();
      const client = new ModosHttpClient(connection);
      const info = await client.get<ModosRuntimeInfo>('/v1/runtime/info');
      const models: ModosDiscoveredModel[] = [];
      if (info.model?.trim()) {
        const id = info.model.trim();
        models.push({
          encodedId: encodeModosModelId(id),
          id,
          label: id,
          provider: 'modos',
        });
      }

      await this.plugin.mutateSettings((mutable) => {
        updateModosProviderSettings(mutable, {
          discoveredModels: models,
        });
      });
      return { kind: 'completed', models };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stderr = workspace.serveManager.getDiagnostics();
      return {
        diagnostics: stderr ? `${message}\n\n${stderr}` : message,
        kind: 'failed',
        models: [],
      };
    }
  }
}
