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

/**
 * Translation has its own explicit override. The legacy VOXLIBRO_TEXT_MODEL is
 * intentionally ignored for translation so an old deployment setting cannot
 * silently force every book chunk onto the most expensive tier.
 */
export const OPENAI_TRANSLATION_MODEL =
  process.env.VOXLIBRO_TRANSLATION_MODEL || OPENAI_TEXT_TIERS.editorial;

const ESCALATION_CHAIN: Record<string, string[]> = {
  'gpt-5.6-luna': ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
  // Keep the first retry on Terra. Sol is reserved for a persistent failure.
  'gpt-5.6-terra': ['gpt-5.6-terra', 'gpt-5.6-terra', 'gpt-5.6-sol'],
  'gpt-5.6-sol': ['gpt-5.6-sol'],
  'gpt-5.6': ['gpt-5.6-terra', 'gpt-5.6-terra', 'gpt-5.6-sol'],
};

const attempts = new Map<string, { count: number; touchedAt: number }>();
const ATTEMPT_TTL_MS = 30 * 60 * 1000;

function cleanupAttempts(now: number) {
  for (const [key, value] of attempts.entries()) {
    if (now - value.touchedAt > ATTEMPT_TTL_MS) attempts.delete(key);
  }
}

function contentsToText(contents: any): string {
  const visit = (value: any): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(visit).filter(Boolean).join('\n');
    if (!value || typeof value !== 'object') return '';
    if (typeof value.text === 'string') return value.text;
    return visit(value.parts || value.content || value.contents || '');
  };
  return visit(contents);
}

export type OpenAiTaskKind = 'translation' | 'audit' | 'editorial' | 'bulk';

export function classifyTextTask(contents: any): OpenAiTaskKind {
  const prompt = contentsToText(contents).toLocaleLowerCase('pt-BR');

  if (
    /traduza estritamente|texto principal para traduzir|modo de tradução|translation mode|translate strictly/.test(prompt)
  ) {
    return 'translation';
  }

  if (/auditoria|audite|audit report|editorial audit|final-editorial-audit/.test(prompt)) {
    return 'audit';
  }

  if (
    /personagen|personagem|bíblia|bible|continuidade|roteiro|speakerid|fatiador|análise estrutural|analise estrutural/.test(prompt)
  ) {
    return 'editorial';
  }

  return 'bulk';
}

/**
 * Normalizes legacy model selections at request time. This is deliberately
 * evaluated for every call because server.ts still exposes a historical
 * TEXT_MODEL constant captured before bootstrap routing is configured.
 */
export function resolveTextModelForRequest(args: any): string {
  const requestedModel = String(args?.model || OPENAI_TEXT_TIERS.bulk);
  const task = classifyTextTask(args?.contents);

  if (task === 'translation') return OPENAI_TRANSLATION_MODEL;
  if (task === 'audit') return OPENAI_TEXT_TIERS.audit;

  const legacyConfiguredModel = process.env.VOXLIBRO_TEXT_MODEL;
  const isLegacySelection =
    requestedModel === 'gpt-5.6' ||
    (!!legacyConfiguredModel && requestedModel === legacyConfiguredModel);

  if (isLegacySelection) {
    return task === 'editorial' ? OPENAI_TEXT_TIERS.editorial : OPENAI_TEXT_TIERS.bulk;
  }

  return requestedModel;
}

function requestKey(args: any, normalizedModel: string) {
  const payload = JSON.stringify({ normalizedModel, contents: args?.contents, config: args?.config });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function selectEscalatedModel(requestedModel: string, attemptNumber: number) {
  const chain = ESCALATION_CHAIN[requestedModel] || [requestedModel];
  return chain[Math.min(Math.max(attemptNumber - 1, 0), chain.length - 1)];
}

export function resetOpenAiRoutingAttempts() {
  attempts.clear();
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
        const originalRequestedModel = String(args?.model || OPENAI_TEXT_TIERS.bulk);
        const normalizedModel = resolveTextModelForRequest(args);
        const task = classifyTextTask(args?.contents);
        const now = Date.now();
        cleanupAttempts(now);
        const key = requestKey(args, normalizedModel);
        const previous = attempts.get(key);
        const attemptNumber = (previous?.count || 0) + 1;
        attempts.set(key, { count: attemptNumber, touchedAt: now });
        const selectedModel = selectEscalatedModel(normalizedModel, attemptNumber);

        if (originalRequestedModel !== normalizedModel) {
          console.info(
            `[OpenAI routing] ${task}: normalizando ${originalRequestedModel} para ${normalizedModel}.`,
          );
        }

        if (selectedModel !== normalizedModel) {
          console.warn(
            `[OpenAI routing] ${task}: escalando ${normalizedModel} para ${selectedModel} na tentativa ${attemptNumber}.`,
          );
        } else {
          console.info(
            `[OpenAI routing] ${task}: usando ${selectedModel} na tentativa ${attemptNumber}.`,
          );
        }

        try {
          return await baseClient.models.generateContent({ ...args, model: selectedModel });
        } catch (error: any) {
          throw classifyOpenAiError(error);
        }
      },
    },
  });

  console.info(
    `[OpenAI routing] bulk=${OPENAI_TEXT_TIERS.bulk} translation=${OPENAI_TRANSLATION_MODEL} editorial=${OPENAI_TEXT_TIERS.editorial} audit=${OPENAI_TEXT_TIERS.audit}`,
  );
}
