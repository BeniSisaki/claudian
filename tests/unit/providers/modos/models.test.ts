import {
  decodeModosModelId,
  encodeModosModelId,
  isModosModelSelectionId,
  normalizeModosDiscoveredModels,
} from '@/providers/modos/models';

describe('modos model ids', () => {
  it('encodes the default provider without a provider segment', () => {
    expect(encodeModosModelId('deepseek-v4-pro')).toBe('modos/deepseek-v4-pro');
    expect(encodeModosModelId('deepseek-v4-pro', 'modos')).toBe('modos/deepseek-v4-pro');
  });

  it('encodes extension providers with a provider segment', () => {
    expect(encodeModosModelId('claude-sonnet', 'anthropic')).toBe('modos/anthropic/claude-sonnet');
  });

  it('decodes both shapes', () => {
    expect(decodeModosModelId('modos/deepseek-v4-pro')).toEqual({ modelId: 'deepseek-v4-pro' });
    expect(decodeModosModelId('modos/anthropic/claude-sonnet')).toEqual({
      modelId: 'claude-sonnet',
      providerId: 'anthropic',
    });
  });

  it('rejects foreign ids', () => {
    expect(decodeModosModelId('pi:openai/gpt-5')).toBeNull();
    expect(decodeModosModelId('modos/')).toBeNull();
    expect(isModosModelSelectionId('plain-model')).toBe(false);
    expect(isModosModelSelectionId('modos/x')).toBe(true);
  });
});

describe('normalizeModosDiscoveredModels', () => {
  it('normalizes, dedupes, and defaults provider/label', () => {
    const models = normalizeModosDiscoveredModels([
      { id: ' a ', label: '', contextWindow: 1_000_000 },
      { id: 'a' },
      { id: 'b', provider: 'ext', label: 'B Model' },
      'garbage',
      { label: 'no-id' },
    ]);
    expect(models).toEqual([
      {
        contextWindow: 1_000_000,
        encodedId: 'modos/a',
        id: 'a',
        label: 'a',
        provider: 'modos',
      },
      { encodedId: 'modos/ext/b', id: 'b', label: 'B Model', provider: 'ext' },
    ]);
  });

  it('returns [] for non-arrays', () => {
    expect(normalizeModosDiscoveredModels(undefined)).toEqual([]);
    expect(normalizeModosDiscoveredModels({})).toEqual([]);
  });
});
