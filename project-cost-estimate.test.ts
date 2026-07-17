import { describe, expect, it } from 'vitest';
import { estimateProjectCost } from './src/projectCostEstimate';

function makeText(words: number) {
  return Array.from({ length: words }, (_, index) => `palavra${index % 20}`).join(' ');
}

describe('project cost estimate', () => {
  it('separa custo de texto das opções de voz', () => {
    const text = makeText(20_000);
    const result = estimateProjectCost({
      wordCount: 20_000,
      sourceLanguage: 'en',
      translationEnabled: true,
      productionMode: 'audiodrama',
    }, text);

    expect(result.basis.translationLikely).toBe(true);
    expect(result.textProcessing.stages.map(stage => stage.model)).toEqual([
      process.env.VOXLIBRO_BULK_MODEL || 'gpt-5.6-luna',
      process.env.VOXLIBRO_EDITORIAL_MODEL || 'gpt-5.6-terra',
      process.env.VOXLIBRO_AUDIT_MODEL || 'gpt-5.6-sol',
    ]);
    expect(result.textProcessing.total.minUsd).toBeGreaterThan(0);
    expect(result.textProcessing.total.maxUsd).toBeGreaterThan(result.textProcessing.total.minUsd);
    expect(result.voiceOptions).toHaveLength(4);
    expect(result.voiceOptions.every(option => option.totalWithText.minUsd >= result.textProcessing.total.minUsd)).toBe(true);
  });

  it('mantém WaveNet mais econômico que Neural2 no preço de tabela', () => {
    const result = estimateProjectCost({
      wordCount: 50_000,
      sourceLanguage: 'pt-BR',
      translationEnabled: false,
    }, makeText(50_000));

    const waveNet = result.voiceOptions.find(option => option.id === 'gcp-wavenet')!;
    const neural2 = result.voiceOptions.find(option => option.id === 'gcp-neural2')!;
    expect(waveNet.cost.minUsd).toBeGreaterThan(0);
    expect(neural2.cost.minUsd).toBeCloseTo(waveNet.cost.minUsd * 4, 5);
  });

  it('estima Gemini Pro TTS em aproximadamente duas vezes o Flash', () => {
    const result = estimateProjectCost({
      wordCount: 12_000,
      sourceLanguage: 'pt-BR',
      translationEnabled: false,
    }, makeText(12_000));

    const flash = result.voiceOptions.find(option => option.id === 'gemini-flash-tts')!;
    const pro = result.voiceOptions.find(option => option.id === 'gemini-pro-tts')!;
    expect(pro.cost.minUsd).toBeCloseTo(flash.cost.minUsd * 2, 5);
    expect(pro.cost.maxUsd).toBeCloseTo(flash.cost.maxUsd * 2, 5);
  });

  it('não inclui tradução quando a obra já está em português', () => {
    const text = makeText(15_000);
    const portuguese = estimateProjectCost({
      wordCount: 15_000,
      sourceLanguage: 'pt-BR',
      translationEnabled: true,
    }, text);
    const foreign = estimateProjectCost({
      wordCount: 15_000,
      sourceLanguage: 'en',
      translationEnabled: true,
    }, text);

    expect(portuguese.basis.translationLikely).toBe(false);
    expect(foreign.basis.translationLikely).toBe(true);
    expect(foreign.textProcessing.total.minUsd).toBeGreaterThan(portuguese.textProcessing.total.minUsd);
  });

  it('recusa estimativa antes da extração do texto', () => {
    expect(() => estimateProjectCost({ wordCount: 0 }, '')).toThrow(/texto precisa ser extraído/i);
  });
});
