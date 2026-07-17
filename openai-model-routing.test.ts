import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OPENAI_MODEL_POLICY,
  classifyOpenAiTask,
  createRoutedOpenAiClient,
  normalizeOpenAiHttpError,
  resolveOpenAiModel,
} from './src/openAiModelRouter';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OpenAI model routing', () => {
  it('routes high-volume, editorial and critical tasks to Luna, Terra and Sol', () => {
    expect(classifyOpenAiTask('Traduza este lote de capítulos para pt-BR.')).toBe('bulk');
    expect(classifyOpenAiTask('Consolide a Bíblia de personagens, aliases e continuidade do roteiro.')).toBe('editorial');
    expect(classifyOpenAiTask('Faça auditoria final de cobertura e resolva homônimos ambíguos.')).toBe('audit');

    expect(resolveOpenAiModel('gpt-5.6', 'Traduza este lote.', DEFAULT_OPENAI_MODEL_POLICY)).toBe('gpt-5.6-luna');
    expect(resolveOpenAiModel('gpt-5.6', 'Crie a Bíblia de personagens.', DEFAULT_OPENAI_MODEL_POLICY)).toBe('gpt-5.6-terra');
    expect(resolveOpenAiModel('gpt-5.6', 'Auditoria final de integridade.', DEFAULT_OPENAI_MODEL_POLICY)).toBe('gpt-5.6-sol');
  });

  it('preserves an explicitly configured model', () => {
    expect(resolveOpenAiModel('gpt-5.5', 'Auditoria final.', DEFAULT_OPENAI_MODEL_POLICY)).toBe('gpt-5.5');
  });

  it('sends the selected model and reasoning effort to the Responses API', async () => {
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ output_text: 'resultado' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const client = createRoutedOpenAiClient({ getActiveOpenAiApiKey: () => 'sk-test' }, DEFAULT_OPENAI_MODEL_POLICY);

    await client.models.generateContent({ model: 'gpt-5.6', contents: 'Traduza este lote.', config: {} });
    await client.models.generateContent({ model: 'gpt-5.6', contents: 'Crie a Bíblia de personagens e continuidade.', config: {} });
    await client.models.generateContent({ model: 'gpt-5.6', contents: 'Auditoria final de cobertura e ambiguidades.', config: {} });

    expect(requests.map(request => request.model)).toEqual([
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
    ]);
    expect(requests.map(request => request.reasoning.effort)).toEqual(['low', 'medium', 'high']);
    expect(requests.every(request => request.store === false)).toBe(true);
  });
});

describe('OpenAI provider errors', () => {
  it('treats exhausted credits as a non-retryable OpenAI account error without poisoning Gemini state', () => {
    const error = normalizeOpenAiHttpError(429, {
      error: {
        code: 'insufficient_quota',
        message: 'You exceeded your current quota, please check your plan and billing details.',
      },
    });

    expect(error.provider).toBe('openai');
    expect(error.code).toBe('OPENAI_ACCOUNT_LIMIT');
    expect(error.status).toBe(402);
    expect(error.retryable).toBe(false);
    expect(error.message.toLowerCase()).not.toContain('quota');
    expect(error.message.toLowerCase()).not.toContain('billing');
  });

  it('converts a temporary 429 rate limit into a retryable service error', () => {
    const error = normalizeOpenAiHttpError(429, {
      error: {
        code: 'rate_limit_exceeded',
        message: 'Rate limit reached for requests per minute.',
      },
    });

    expect(error.code).toBe('OPENAI_RATE_LIMIT');
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });
});
