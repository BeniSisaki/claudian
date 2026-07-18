import type { ProviderCapabilities } from '../../core/providers/types';

export const MODOS_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'modos',
  supportsPersistentRuntime: true,
  supportsNativeHistory: true,
  supportsPlanMode: false,
  supportsRewind: true,
  supportsFork: true,
  supportsProviderCommands: false,
  supportsImageAttachments: true,
  supportsInstructionMode: true,
  supportsMcpTools: false,
  supportsTurnSteer: true,
  reasoningControl: 'none',
});
