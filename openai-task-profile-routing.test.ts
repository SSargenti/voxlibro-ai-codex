import { beforeEach, describe, expect, it } from 'vitest';
import {
  OPENAI_TASK_MODELS,
  OPENAI_TASK_REASONING,
  OPENAI_TEXT_TIERS,
  classifyTextTask,
  configureOpenAiModelRouting,
  resetOpenAiRoutingAttempts,
  resolveTextModelForRequest,
  selectEscalatedModelForTask,
} from './src/openAiModelRouting';

const prompts = {
  health_check: 'Responda somente: OK',
  language_detection: `Analise amostras do início, meio e fim e detecte o idioma predominante. Retorne languageCode.`,
  ocr: `You are a high-precision OCR engine. Extract text using OCR from the exact pages of this PDF.`,
  metadata: `Análise editorial. Extraia o título real, autor e modo de áudio recomendado. Retorne recommendedMode.`,
  structure: `Analise os cabeçalhos candidatos e decida se cada um é início real de capítulo. Retorne isRealChapter e refinedTitle.`,
  translation: `Traduza estritamente para Português do Brasil. TEXTO PRINCIPAL PARA TRADUZIR: The light faded. Modo de Tradução: Literário.`,
  character_analysis: `Identifique os narradores e todos os personagens que atuam. Retorne candidates com candidateName e aliases.`,
  script_generation: `Você é um fatiador e rotulador. Processe sourceUnits, preserve sourceUnitId e atribua speakerId e spokenText.`,
  audit: `Faça uma auditoria editorial final e produza um audit report com problemas acionáveis.`,
  generic: `Resuma o estado atual desta operação.`,
} as const;

describe('perfis de modelo por etapa do VoxLibro', () => {
  beforeEach(() => {
    resetOpenAiRoutingAttempts();
  });

  it('classifica cada carga de trabalho sem confundir tarefas editoriais', () => {
    for (const [task, prompt] of Object.entries(prompts)) {
      expect(classifyTextTask([{ text: prompt }])).toBe(task);
    }
  });

  it('usa Luna nas tarefas mecânicas e de alto volume', () => {
    expect(OPENAI_TASK_MODELS.health_check).toBe(OPENAI_TEXT_TIERS.bulk);
    expect(OPENAI_TASK_MODELS.language_detection).toBe(OPENAI_TEXT_TIERS.bulk);
    expect(OPENAI_TASK_MODELS.ocr).toBe(OPENAI_TEXT_TIERS.bulk);
    expect(OPENAI_TASK_MODELS.metadata).toBe(OPENAI_TEXT_TIERS.bulk);
    expect(OPENAI_TASK_MODELS.generic).toBe(OPENAI_TEXT_TIERS.bulk);
  });

  it('usa Terra em tradução, estrutura, personagens e roteiro', () => {
    expect(OPENAI_TASK_MODELS.structure).toBe(OPENAI_TEXT_TIERS.editorial);
    expect(OPENAI_TASK_MODELS.translation).toBe(OPENAI_TEXT_TIERS.editorial);
    expect(OPENAI_TASK_MODELS.character_analysis).toBe(OPENAI_TEXT_TIERS.editorial);
    expect(OPENAI_TASK_MODELS.script_generation).toBe(OPENAI_TEXT_TIERS.editorial);
  });

  it('reserva Sol para auditoria explícita', () => {
    expect(OPENAI_TASK_MODELS.audit).toBe(OPENAI_TEXT_TIERS.audit);
    expect(OPENAI_TASK_REASONING.audit).toBe('high');
  });

  it('corrige personagens enviados incorretamente como bulk para Terra', () => {
    expect(
      resolveTextModelForRequest({
        model: OPENAI_TEXT_TIERS.bulk,
        contents: [{ text: prompts.character_analysis }],
      }),
    ).toBe(OPENAI_TEXT_TIERS.editorial);
  });

  it('reduz metadados enviados como editorial para Luna', () => {
    expect(
      resolveTextModelForRequest({
        model: OPENAI_TEXT_TIERS.editorial,
        contents: [{ text: prompts.metadata }],
      }),
    ).toBe(OPENAI_TEXT_TIERS.bulk);
  });

  it('não leva OCR e metadados ao Sol', () => {
    expect(selectEscalatedModelForTask('ocr', OPENAI_TEXT_TIERS.bulk, 1)).toBe(OPENAI_TEXT_TIERS.bulk);
    expect(selectEscalatedModelForTask('ocr', OPENAI_TEXT_TIERS.bulk, 2)).toBe(OPENAI_TEXT_TIERS.bulk);
    expect(selectEscalatedModelForTask('ocr', OPENAI_TEXT_TIERS.bulk, 3)).toBe(OPENAI_TEXT_TIERS.editorial);
    expect(selectEscalatedModelForTask('ocr', OPENAI_TEXT_TIERS.bulk, 8)).toBe(OPENAI_TEXT_TIERS.editorial);
    expect(selectEscalatedModelForTask('metadata', OPENAI_TEXT_TIERS.bulk, 8)).toBe(OPENAI_TEXT_TIERS.editorial);
  });

  it('escala tarefas editoriais ao Sol somente após persistência', () => {
    for (const task of ['structure', 'translation', 'character_analysis', 'script_generation'] as const) {
      expect(selectEscalatedModelForTask(task, OPENAI_TEXT_TIERS.editorial, 1)).toBe(OPENAI_TEXT_TIERS.editorial);
      expect(selectEscalatedModelForTask(task, OPENAI_TEXT_TIERS.editorial, 2)).toBe(OPENAI_TEXT_TIERS.editorial);
      expect(selectEscalatedModelForTask(task, OPENAI_TEXT_TIERS.editorial, 3)).toBe(OPENAI_TEXT_TIERS.audit);
    }
  });

  it('injeta modelo e esforço de raciocínio adequados em cada chamada', async () => {
    const calls: any[] = [];
    let configuredClient: any;
    const server: any = {
      TEXT_MODELS: { bulk: 'gpt-5.6', editorial: 'gpt-5.6', audit: 'gpt-5.6' },
      ai: {
        models: {
          generateContent: async (args: any) => {
            calls.push(args);
            return { text: 'ok' };
          },
        },
      },
      setAiClient: (client: any) => {
        configuredClient = client;
      },
    };

    configureOpenAiModelRouting(server);

    await configuredClient.models.generateContent({ model: 'gpt-5.6', contents: [{ text: prompts.metadata }] });
    await configuredClient.models.generateContent({ model: OPENAI_TEXT_TIERS.bulk, contents: [{ text: prompts.character_analysis }] });
    await configuredClient.models.generateContent({ model: 'gpt-5.6', contents: [{ text: prompts.audit }] });

    expect(calls.map(call => ({ model: call.model, effort: call.config.reasoningEffort }))).toEqual([
      { model: OPENAI_TEXT_TIERS.bulk, effort: 'low' },
      { model: OPENAI_TEXT_TIERS.editorial, effort: 'medium' },
      { model: OPENAI_TEXT_TIERS.audit, effort: 'high' },
    ]);
  });

  it('mantém health check no Luna mesmo quando repetido', async () => {
    const models: string[] = [];
    let configuredClient: any;
    const server: any = {
      TEXT_MODELS: { bulk: 'gpt-5.6', editorial: 'gpt-5.6', audit: 'gpt-5.6' },
      ai: { models: { generateContent: async (args: any) => { models.push(args.model); return { text: 'OK' }; } } },
      setAiClient: (client: any) => { configuredClient = client; },
    };

    configureOpenAiModelRouting(server);
    for (let i = 0; i < 4; i++) {
      await configuredClient.models.generateContent({ model: 'gpt-5.6', contents: [{ text: prompts.health_check }] });
    }

    expect(models).toEqual(Array(4).fill(OPENAI_TEXT_TIERS.bulk));
  });
});
