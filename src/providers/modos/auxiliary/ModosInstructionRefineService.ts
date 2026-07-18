import { QueryBackedInstructionRefineService } from '../../../core/auxiliary/QueryBackedInstructionRefineService';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ModosAuxQueryRunner } from '../runtime/ModosAuxQueryRunner';

export class ModosInstructionRefineService extends QueryBackedInstructionRefineService {
  constructor(plugin: ProviderHost) {
    super(new ModosAuxQueryRunner(plugin));
  }
}
