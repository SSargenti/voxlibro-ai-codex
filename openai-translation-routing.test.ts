import { beforeEach, describe, expect, it } from 'vitest';
import {
  OPENAI_TEXT_TIERS,
  OPENAI_TRANSLATION_MODEL,
  classifyTextTask,
  configureOpenAiModelRouting,
  resetOpenAiRoutingAttempts,
  resolveTextModelForRequest,
  selectEscalatedModel,
} from './src/openAiModelRouting';

const translationArgs = {
  model: 'gpt-5.6',
  contents: [
    {
      text: `Traduza estritamente o seguinte texto para o Português do Brasil.
TEXTO PRINCIPAL PARA TRADUZIR:\nThe station lights went out.\n[FIM DO TEXTO PRINCIPAL PARA TRADUZIR]
Modo de Tradução: Literário / Novela`,
    },
  ],
};

describe('roteamento OpenAI da tradução', () => {
  beforeEach(() => {
    resetOpenAiRoutingAttempts();
  });

  it('classifica o prompt como tradução', () => {
    expect(classifyTextTask(translationArgs.contents)).toBe('translation');
  });

  it('normaliza o alias legado gpt-5.6 para Terra', () => {
    expect(resolveTextModelForRequest(translationArgs)).toBe(OPENAI_TRANSLATION_MODEL);
    expect(OPENAI_TRANSLATION_MODEL).toBe(OPENAI_TEXT_TIERS.editorial);
  });

  it('impede que uma seleção genérica de Sol force a tradução', () => {
    expect(
      resolveTextModelForRequest({
        ...translationArgs,
        model: 'gpt-5.6-sol',
      }),
    ).toBe(OPENAI_TRANSLATION_MODEL);
  });

  it('mantém duas tentativas no Terra antes de escalar para Sol', () => {
    expect(selectEscalatedModel('gpt-5.6-terra', 1)).toBe('gpt-5.6-terra');
    expect(selectEscalatedModel('gpt-5.6-terra', 2)).toBe('gpt-5.6-terra');
    expect(selectEscalatedModel('gpt-5.6-terra', 3)).toBe('gpt-5.6-sol');
    expect(selectEscalatedModel('gpt-5.6-terra', 8)).toBe('gpt-5.6-sol');
  });

  it('envia a primeira e a segunda chamadas ao Terra e somente a terceira ao Sol', async () => {
    const calledModels: string[] = [];
    let configuredClient: any;
    const server: any = {
      TEXT_MODELS: {
        bulk: 'gpt-5.6',
        editorial: 'gpt-5.6',
        audit: 'gpt-5.6',
      },
      ai: {
        models: {
          generateContent: async (args: any) => {
            calledModels.push(args.model);
            return { text: 'Tradução válida' };
          },
        },
      },
      setAiClient: (client: any) => {
        configuredClient = client;
      },
    };

    configureOpenAiModelRouting(server);

    await configuredClient.models.generateContent(translationArgs);
    await configuredClient.models.generateContent(translationArgs);
    await configuredClient.models.generateContent(translationArgs);

    expect(calledModels).toEqual([
      'gpt-5.6-terra',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
    ]);
  });

  it('preserva Sol para auditoria explícita', () => {
    expect(
      resolveTextModelForRequest({
        model: 'gpt-5.6',
        contents: [{ text: 'Execute a auditoria editorial final e produza o audit report.' }],
      }),
    ).toBe(OPENAI_TEXT_TIERS.audit);
  });
});
