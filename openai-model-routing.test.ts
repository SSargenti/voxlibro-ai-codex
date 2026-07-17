import { describe, expect, it, vi } from 'vitest';
import {
  OPENAI_TEXT_TIERS,
  classifyOpenAiError,
  configureOpenAiModelRouting,
  selectEscalatedModel,
} from './src/openAiModelRouting';

describe('OpenAI model routing', () => {
  it('usa Luna, Terra e Sol nos perfis padrão', () => {
    expect(OPENAI_TEXT_TIERS.bulk).toBe(process.env.VOXLIBRO_BULK_MODEL || 'gpt-5.6-luna');
    expect(OPENAI_TEXT_TIERS.editorial).toBe(process.env.VOXLIBRO_EDITORIAL_MODEL || 'gpt-5.6-terra');
    expect(OPENAI_TEXT_TIERS.audit).toBe(process.env.VOXLIBRO_AUDIT_MODEL || 'gpt-5.6-sol');
  });

  it('escala seletivamente a mesma tarefa', () => {
    expect(selectEscalatedModel('gpt-5.6-luna', 1)).toBe('gpt-5.6-luna');
    expect(selectEscalatedModel('gpt-5.6-luna', 2)).toBe('gpt-5.6-terra');
    expect(selectEscalatedModel('gpt-5.6-luna', 3)).toBe('gpt-5.6-sol');
    expect(selectEscalatedModel('gpt-5.6-terra', 2)).toBe('gpt-5.6-sol');
    expect(selectEscalatedModel('gpt-5.6-sol', 5)).toBe('gpt-5.6-sol');
  });

  it('mapeia falta de créditos sem classificá-la como Gemini', () => {
    const error: any = classifyOpenAiError({
      status: 429,
      message: 'You exceeded your current quota, please check your plan and billing details.',
    });
    expect(error.code).toBe('OPENAI_CREDITS_REQUIRED');
    expect(error.status).toBe(402);
    expect(error.retryable).toBe(false);
    expect(error.provider).toBe('openai');
    expect(error.message).toContain('Créditos da API OpenAI');
    expect(error.message.toLowerCase()).not.toContain('gemini');
  });

  it('transforma rate limit temporário em erro retryable', () => {
    const error: any = classifyOpenAiError({ status: 429, message: 'Rate limit reached for requests' });
    expect(error.code).toBe('OPENAI_RATE_LIMIT');
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });

  it('aplica o modelo econômico ao cliente de texto', async () => {
    const generateContent = vi.fn().mockResolvedValue({ text: 'ok' });
    let configuredClient: any;
    const server: any = {
      TEXT_MODELS: { bulk: 'gpt-5.6', editorial: 'gpt-5.6', audit: 'gpt-5.6' },
      ai: { models: { generateContent } },
      setAiClient: (client: any) => { configuredClient = client; },
    };

    configureOpenAiModelRouting(server);
    await configuredClient.models.generateContent({ model: server.TEXT_MODELS.bulk, contents: 'conteúdo único do teste' });

    expect(server.TEXT_MODELS).toEqual({
      bulk: OPENAI_TEXT_TIERS.bulk,
      editorial: OPENAI_TEXT_TIERS.editorial,
      audit: OPENAI_TEXT_TIERS.audit,
    });
    expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({ model: OPENAI_TEXT_TIERS.bulk }));
  });
});
