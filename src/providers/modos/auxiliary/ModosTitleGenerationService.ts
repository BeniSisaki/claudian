import { QueryBackedTitleGenerationService } from '../../../core/auxiliary/QueryBackedTitleGenerationService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ModosAuxQueryRunner } from '../runtime/ModosAuxQueryRunner';
import { modosChatUIConfig } from '../ui/ModosChatUIConfig';

export class ModosTitleGenerationService extends QueryBackedTitleGenerationService {
  constructor(plugin: ProviderHost) {
    super({
      createRunner: () => new ModosAuxQueryRunner(plugin),
      resolveModel: () => {
        const settings = plugin.settings as unknown as Record<string, unknown>;
        const titleModel = typeof settings.titleGenerationModel === 'string'
          ? settings.titleGenerationModel
          : '';
        return modosChatUIConfig.ownsModel(titleModel, settings) && titleModel
          ? titleModel
          : undefined;
      },
    });
  }
}
