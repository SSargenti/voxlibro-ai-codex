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

export type OpenAiTaskKind =
  | 'health_check'
  | 'language_detection'
  | 'ocr'
  | 'metadata'
  | 'structure'
  | 'translation'
  | 'character_analysis'
  | 'script_generation'
  | 'audit'
  | 'generic';

export type OpenAiReasoningEffort = 'low' | 'medium' | 'high';

/**
 * Translation has its own explicit override. The legacy VOXLIBRO_TEXT_MODEL is
 * intentionally ignored for translation so an old deployment setting cannot
 * silently force every book chunk onto the most expensive tier.
 */
export const OPENAI_TRANSLATION_MODEL =
  process.env.VOXLIBRO_TRANSLATION_MODEL || OPENAI_TEXT_TIERS.editorial;

/**
 * Model policy by workload. Each stage can be overridden independently without
 * allowing a generic legacy variable to move every operation to the same tier.
 */
export const OPENAI_TASK_MODELS: Record<OpenAiTaskKind, string> = {
  health_check: process.env.VOXLIBRO_HEALTH_MODEL || OPENAI_TEXT_TIERS.bulk,
  language_detection: process.env.VOXLIBRO_LANGUAGE_MODEL || OPENAI_TEXT_TIERS.bulk,
  ocr: process.env.VOXLIBRO_OCR_MODEL || OPENAI_TEXT_TIERS.bulk,
  metadata: process.env.VOXLIBRO_METADATA_MODEL || OPENAI_TEXT_TIERS.bulk,
  structure: process.env.VOXLIBRO_STRUCTURE_MODEL || OPENAI_TEXT_TIERS.editorial,
  translation: OPENAI_TRANSLATION_MODEL,
  character_analysis: process.env.VOXLIBRO_CHARACTER_MODEL || OPENAI_TEXT_TIERS.editorial,
  script_generation: process.env.VOXLIBRO_SCRIPT_MODEL || OPENAI_TEXT_TIERS.editorial,
  audit: OPENAI_TEXT_TIERS.audit,
  generic: OPENAI_TEXT_TIERS.bulk,
};

export const OPENAI_TASK_REASONING: Record<OpenAiTaskKind, OpenAiReasoningEffort> = {
  health_check: 'low',
  language_detection: 'low',
  ocr: 'low',
  metadata: 'low',
  structure: 'medium',
  translation: 'low',
  character_analysis: 'medium',
  script_generation: 'medium',
  audit: 'high',
  generic: 'low',
};

/**
 * Compatibility chain retained for callers and tests that select only by model.
 * Production routing uses selectEscalatedModelForTask so low-risk workloads do
 * not reach Sol merely because a mechanical task was repeated.
 */
const ESCALATION_CHAIN: Record<string, string[]> = {
  'gpt-5.6-luna': ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
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

export function classifyTextTask(contents: any): OpenAiTaskKind {
  const prompt = contentsToText(contents).toLocaleLowerCase('pt-BR');

  if (/auditoria|audite|audit report|editorial audit|final-editorial-audit/.test(prompt)) {
    return 'audit';
  }

  if (/\bocr\b|extract text using ocr|high-precision ocr engine|páginas exatas deste pdf|exact pages of this pdf/.test(prompt)) {
    return 'ocr';
  }

  if (/traduza estritamente|texto principal para traduzir|modo de tradução|translation mode|translate strictly/.test(prompt)) {
    return 'translation';
  }

  if (/^\s*responda somente\s*:\s*ok\s*$/i.test(prompt)) {
    return 'health_check';
  }

  if (/fatiador e rotulador|sourceunits|sourceunitid|speakerid|spokentext|schema de resposta json esperado[\s\S]*segments/.test(prompt)) {
    return 'script_generation';
  }

  if (/candidatename|narradores e todos os personagens|todos os personagens que atuam|bíblia narrativa|narrative bible|sightings|merge-suggestions/.test(prompt)) {
    return 'character_analysis';
  }

  if (/isrealchapter|cabeçalhos? candidat|início real de capítulo|inicio real de capitulo|refinedtitle|decida para cada cabeçalho/.test(prompt)) {
    return 'structure';
  }

  if (/extraia o título real|extraia o titulo real|recommendedmode|modo de áudio recomendado|modo de audio recomendado|modo recomendado \(audiodrama/.test(prompt)) {
    return 'metadata';
  }

  if (/detecte o idioma predominante|languagecode|language detection|amostra início|amostra inicio/.test(prompt)) {
    return 'language_detection';
  }

  return 'generic';
}

/**
 * Resolves the stage policy before considering the model requested by legacy
 * server code. Recognized workloads always win over a stale TEXT_MODEL value.
 */
export function resolveTextModelForRequest(args: any): string {
  const requestedModel = String(args?.model || OPENAI_TEXT_TIERS.bulk);
  const task = classifyTextTask(args?.contents);

  if (task !== 'generic') {
    return OPENAI_TASK_MODELS[task];
  }

  const legacyConfiguredModel = process.env.VOXLIBRO_TEXT_MODEL;
  const isLegacySelection =
    requestedModel === 'gpt-5.6' ||
    (!!legacyConfiguredModel && requestedModel === legacyConfiguredModel);

  return isLegacySelection ? OPENAI_TASK_MODELS.generic : requestedModel;
}

function requestKey(args: any, task: OpenAiTaskKind, normalizedModel: string) {
  const payload = JSON.stringify({ task, normalizedModel, contents: args?.contents, config: args?.config });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function selectEscalatedModel(requestedModel: string, attemptNumber: number) {
  const chain = ESCALATION_CHAIN[requestedModel] || [requestedModel];
  return chain[Math.min(Math.max(attemptNumber - 1, 0), chain.length - 1)];
}

function isStandardGpt56Tier(model: string): boolean {
  return model === OPENAI_TEXT_TIERS.bulk || model === OPENAI_TEXT_TIERS.editorial || model === OPENAI_TEXT_TIERS.audit;
}

/**
 * Escalation is workload-aware:
 * - mechanical/high-volume tasks may move from Luna to Terra, never to Sol;
 * - editorial tasks may move from Terra to Sol after two identical executions;
 * - health checks and explicit audits never change tier;
 * - custom model overrides remain fixed instead of silently changing provider tier.
 */
export function selectEscalatedModelForTask(
  task: OpenAiTaskKind,
  requestedModel: string,
  attemptNumber: number,
): string {
  if (task === 'health_check' || task === 'audit') return requestedModel;
  if (!isStandardGpt56Tier(requestedModel)) return requestedModel;

  const editorialTasks: OpenAiTaskKind[] = [
    'structure',
    'translation',
    'character_analysis',
    'script_generation',
  ];

  const fallback = editorialTasks.includes(task)
    ? OPENAI_TEXT_TIERS.audit
    : OPENAI_TEXT_TIERS.editorial;

  if (requestedModel === fallback || requestedModel === OPENAI_TEXT_TIERS.audit) {
    return requestedModel;
  }

  const chain = [requestedModel, requestedModel, fallback];
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
        const task = classifyTextTask(args?.contents);
        const normalizedModel = resolveTextModelForRequest(args);
        const now = Date.now();
        cleanupAttempts(now);
        const key = requestKey(args, task, normalizedModel);
        const previous = attempts.get(key);
        const attemptNumber = (previous?.count || 0) + 1;
        attempts.set(key, { count: attemptNumber, touchedAt: now });
        const selectedModel = selectEscalatedModelForTask(task, normalizedModel, attemptNumber);
        const reasoningEffort = args?.config?.reasoningEffort || OPENAI_TASK_REASONING[task];

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
            `[OpenAI routing] ${task}: usando ${selectedModel} com reasoning=${reasoningEffort} na tentativa ${attemptNumber}.`,
          );
        }

        try {
          return await baseClient.models.generateContent({
            ...args,
            model: selectedModel,
            config: {
              ...(args?.config || {}),
              reasoningEffort,
            },
          });
        } catch (error: any) {
          throw classifyOpenAiError(error);
        }
      },
    },
  });

  console.info(
    `[OpenAI routing] language=${OPENAI_TASK_MODELS.language_detection} ocr=${OPENAI_TASK_MODELS.ocr} metadata=${OPENAI_TASK_MODELS.metadata} structure=${OPENAI_TASK_MODELS.structure} translation=${OPENAI_TASK_MODELS.translation} characters=${OPENAI_TASK_MODELS.character_analysis} script=${OPENAI_TASK_MODELS.script_generation} audit=${OPENAI_TASK_MODELS.audit}`,
  );
}
