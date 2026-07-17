import crypto from 'crypto';

export type OpenAiRoutingServer = {
  ai: any;
  setAiClient: (client: any) => void;
  TEXT_MODELS: {
    bulk: string;
    editorial: string;
    audit: string;
  };
};

export const OPENAI_TEXT_TIERS = {
  bulk: process.env.VOXLIBRO_BULK_MODEL || 'gpt-5.6-luna',
  editorial: process.env.VOXLIBRO_EDITORIAL_MODEL || 'gpt-5.6-terra',
  audit: process.env.VOXLIBRO_AUDIT_MODEL || 'gpt-5.6-sol',
} as const;

const ESCALATION_CHAIN: Record<string, string[]> = {
  'gpt-5.6-luna': ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
  'gpt-5.6-terra': ['gpt-5.6-terra', 'gpt-5.6-sol'],
  'gpt-5.6-sol': ['gpt-5.6-sol'],
  'gpt-5.6': ['gpt-5.6-sol'],
};

const attempts = new Map<string, { count: number; touchedAt: number }>();
const ATTEMPT_TTL_MS = 30 * 60 * 1000;

function cleanupAttempts(now: number) {
  for (const [key, value] of attempts.entries()) {
    if (now - value.touchedAt > ATTEMPT_TTL_MS) attempts.delete(key);
  }
}

function requestKey(args: any, requestedModel: string) {
  const payload = JSON.stringify({ requestedModel, contents: args?.contents, config: args?.config });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function selectEscalatedModel(requestedModel: string, attemptNumber: number) {
  const chain = ESCALATION_CHAIN[requestedModel] || [requestedModel];
  return chain[Math.min(Math.max(attemptNumber - 1, 0), chain.length - 1)];
}

export function classifyOpenAiError(error: any) {
  const message = String(error?.message || error || '');
  const normalized = message.toLowerCase();
  const status = Number(error?.status || error?.code || 0);

  const creditsUnavailable =
    normalized.includes('exceeded your current quota') ||
    normalized.includes('insufficient_quota') ||
    normalized.includes('check your plan and billing') ||
    normalized.includes('billing details') ||
    normalized.includes('credit balance') ||
    normalized.includes('payment method');

  if (creditsUnavailable) {
    const mapped: any = new Error('Créditos da API OpenAI indisponíveis. Adicione saldo ou revise o limite financeiro da conta antes de retomar o processamento.');
    mapped.code = 'OPENAI_CREDITS_REQUIRED';
    mapped.status = 402;
    mapped.retryable = false;
    mapped.provider = 'openai';
    return mapped;
  }

  const temporaryRateLimit = status === 429 || normalized.includes('rate limit');
  if (temporaryRateLimit) {
    const mapped: any = new Error('Limite temporário de requisições da OpenAI. O VoxLibro poderá tentar novamente sem trocar de provedor.');
    mapped.code = 'OPENAI_RATE_LIMIT';
    mapped.status = 503;
    mapped.retryable = true;
    mapped.provider = 'openai';
    return mapped;
  }

  error.provider = error.provider || 'openai';
  return error;
}

export function configureOpenAiModelRouting(server: OpenAiRoutingServer) {
  (server.TEXT_MODELS as any).bulk = OPENAI_TEXT_TIERS.bulk;
  (server.TEXT_MODELS as any).editorial = OPENAI_TEXT_TIERS.editorial;
  (server.TEXT_MODELS as any).audit = OPENAI_TEXT_TIERS.audit;

  const baseClient = server.ai;
  if (!baseClient?.models?.generateContent) {
    throw new Error('Cliente de texto OpenAI não está disponível para configurar o roteamento.');
  }

  server.setAiClient({
    ...baseClient,
    models: {
      ...baseClient.models,
      generateContent: async (args: any) => {
        const requestedModel = args?.model || OPENAI_TEXT_TIERS.bulk;
        const now = Date.now();
        cleanupAttempts(now);
        const key = requestKey(args, requestedModel);
        const previous = attempts.get(key);
        const attemptNumber = (previous?.count || 0) + 1;
        attempts.set(key, { count: attemptNumber, touchedAt: now });
        const selectedModel = selectEscalatedModel(requestedModel, attemptNumber);

        if (selectedModel !== requestedModel) {
          console.warn(`[OpenAI routing] Escalando ${requestedModel} para ${selectedModel} na tentativa ${attemptNumber}.`);
        } else {
          console.info(`[OpenAI routing] Usando ${selectedModel} na tentativa ${attemptNumber}.`);
        }

        try {
          return await baseClient.models.generateContent({ ...args, model: selectedModel });
        } catch (error: any) {
          throw classifyOpenAiError(error);
        }
      },
    },
  });

  console.info(`[OpenAI routing] bulk=${OPENAI_TEXT_TIERS.bulk} editorial=${OPENAI_TEXT_TIERS.editorial} audit=${OPENAI_TEXT_TIERS.audit}`);
}
