import { QueryBackedInlineEditService } from '../../../core/auxiliary/QueryBackedInlineEditService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ModosAuxQueryRunner } from '../runtime/ModosAuxQueryRunner';

export class ModosInlineEditService extends QueryBackedInlineEditService {
  constructor(plugin: ProviderHost) {
    super(new ModosAuxQueryRunner(plugin));
  }
}
