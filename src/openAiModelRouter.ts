type ModelTier = 'bulk' | 'editorial' | 'audit';

type ModelPolicy = Record<ModelTier, string>;

type ServerBindings = {
  app: { get: (path: string, handler: (req: any, res: any) => void) => void };
  TEXT_MODELS: ModelPolicy;
  getActiveOpenAiApiKey: () => string | null;
  setAiClient: (client: any) => void;
};

export const DEFAULT_OPENAI_MODEL_POLICY: ModelPolicy = {
  bulk: 'gpt-5.6-luna',
  editorial: 'gpt-5.6-terra',
  audit: 'gpt-5.6-sol',
};

const LEGACY_DEFAULT_MODELS = new Set(['gpt-5.6', 'gpt-5.6-sol']);
const OPENAI_ROUTER_INSTALLED = Symbol.for('voxlibro.openai-model-router-installed');
const PROVIDER_LOGGING_INSTALLED = Symbol.for('voxlibro.provider-aware-logging-installed');

const AUDIT_PATTERN = /auditoria|audit\b|cobertura|coverage|integridade|integrity|hom[oô]nim|homonym|ambigu|conflito|conflict|inconsist|merge[- ]suggestion|valida[cç][aã]o final|revis[aã]o final|final review|[uú]ltimo cap[ií]tulo|final chapter/i;
const EDITORIAL_PATTERN = /personagen|character|b[ií]blia|bible|continuidade|continuity|roteiro|script|speakerid|locutor|elenco|casting|alias|voz|voice|di[aá]logo|dialogue|dire[cç][aã]o emocional|speech style/i;

function contentToText(contents: any): string {
  const visit = (value: any): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(visit).filter(Boolean).join('\n');
    if (!value || typeof value !== 'object') return '';
    if (typeof value.text === 'string') return value.text;
    return visit(value.parts || value.content || '');
  };
  return visit(contents);
}

function readOpenAiOutput(data: any): string {
  if (typeof data?.output_text === 'string') return data.output_text;
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') return part.text;
    }
  }
  return '';
}

export function getOpenAiModelPolicy(): ModelPolicy {
  return {
    bulk: process.env.VOXLIBRO_BULK_MODEL || DEFAULT_OPENAI_MODEL_POLICY.bulk,
    editorial: process.env.VOXLIBRO_EDITORIAL_MODEL || DEFAULT_OPENAI_MODEL_POLICY.editorial,
    audit: process.env.VOXLIBRO_AUDIT_MODEL || DEFAULT_OPENAI_MODEL_POLICY.audit,
  };
}

export function classifyOpenAiTask(input: string): ModelTier {
  if (AUDIT_PATTERN.test(input)) return 'audit';
  if (EDITORIAL_PATTERN.test(input)) return 'editorial';
  return 'bulk';
}

export function resolveOpenAiModel(requestedModel: string | undefined, input: string, policy = getOpenAiModelPolicy()): string {
  const requested = requestedModel?.trim();
  if (requested && !LEGACY_DEFAULT_MODELS.has(requested)) return requested;
  return policy[classifyOpenAiTask(input)];
}

export function defaultReasoningEffort(model: string): 'low' | 'medium' | 'high' {
  if (model.includes('luna')) return 'low';
  if (model.includes('terra')) return 'medium';
  return 'high';
}

export class OpenAiProviderError extends Error {
  provider = 'openai' as const;
  code: string;
  status: number;
  retryable: boolean;
  upstreamStatus: number;

  constructor(params: { code: string; message: string; status: number; retryable: boolean; upstreamStatus: number }) {
    super(params.message);
    this.name = 'OpenAiProviderError';
    this.code = params.code;
    this.status = params.status;
    this.retryable = params.retryable;
    this.upstreamStatus = params.upstreamStatus;
  }
}

export function normalizeOpenAiHttpError(status: number, data: any): OpenAiProviderError {
  const upstreamCode = String(data?.error?.code || data?.error?.type || '').toLowerCase();
  const upstreamMessage = String(data?.error?.message || `OpenAI respondeu HTTP ${status}`);
  const lowerMessage = upstreamMessage.toLowerCase();

  const accountLimit =
    upstreamCode.includes('insufficient_quota') ||
    upstreamCode.includes('billing_hard_limit') ||
    upstreamCode.includes('billing_not_active') ||
    lowerMessage.includes('exceeded your current quota') ||
    lowerMessage.includes('check your plan and billing') ||
    lowerMessage.includes('insufficient quota') ||
    lowerMessage.includes('billing hard limit');

  if (accountLimit) {
    return new OpenAiProviderError({
      code: 'OPENAI_ACCOUNT_LIMIT',
      message: 'A conta da OpenAI não possui créditos disponíveis ou atingiu o limite financeiro. Regularize os créditos na OpenAI Platform e retome somente o item falho.',
      status: 402,
      retryable: false,
      upstreamStatus: status,
    });
  }

  if (status === 429) {
    return new OpenAiProviderError({
      code: 'OPENAI_RATE_LIMIT',
      message: 'A OpenAI está temporariamente limitada por volume de requisições. Uma nova tentativa automática pode ser realizada.',
      status: 503,
      retryable: true,
      upstreamStatus: status,
    });
  }

  if (status === 401 || status === 403) {
    return new OpenAiProviderError({
      code: 'OPENAI_AUTH_ERROR',
      message: 'A credencial da OpenAI é inválida, expirou ou não possui acesso ao modelo selecionado.',
      status,
      retryable: false,
      upstreamStatus: status,
    });
  }

  if (status >= 500) {
    return new OpenAiProviderError({
      code: 'OPENAI_TEMPORARY_FAILURE',
      message: 'A OpenAI apresentou uma falha temporária. O VoxLibro poderá tentar novamente sem trocar de provedor.',
      status: 503,
      retryable: true,
      upstreamStatus: status,
    });
  }

  return new OpenAiProviderError({
    code: 'OPENAI_REQUEST_FAILED',
    message: `Falha na solicitação à OpenAI: ${upstreamMessage.slice(0, 240)}`,
    status,
    retryable: false,
    upstreamStatus: status,
  });
}

export function createRoutedOpenAiClient(bindings: Pick<ServerBindings, 'getActiveOpenAiApiKey'>, policy = getOpenAiModelPolicy()) {
  return {
    models: {
      generateContent: async ({ model, contents, config }: any) => {
        const apiKey = bindings.getActiveOpenAiApiKey();
        if (!apiKey) {
          throw new OpenAiProviderError({
            code: 'OPENAI_NOT_CONFIGURED',
            message: 'Configure uma chave da OpenAI antes de executar tradução, Bíblia ou roteiro.',
            status: 401,
            retryable: false,
            upstreamStatus: 401,
          });
        }

        const input = contentToText(contents);
        const selectedModel = resolveOpenAiModel(model, input, policy);
        const reasoningEffort = config?.reasoningEffort || defaultReasoningEffort(selectedModel);
        const tier = (Object.entries(policy).find(([, value]) => value === selectedModel)?.[0] || classifyOpenAiTask(input)) as ModelTier;

        console.info(`[OpenAI] tier=${tier} model=${selectedModel} reasoning=${reasoningEffort}`);

        const response = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: selectedModel,
            input,
            reasoning: { effort: reasoningEffort },
            max_output_tokens: 25000,
            store: false,
          }),
        });

        const data: any = await response.json().catch(() => ({}));
        if (!response.ok) throw normalizeOpenAiHttpError(response.status, data);

        if (data?.status === 'incomplete') {
          const reason = data?.incomplete_details?.reason || 'limite de saída';
          throw new OpenAiProviderError({
            code: 'OPENAI_INCOMPLETE_RESPONSE',
            message: `Resposta incompleta da OpenAI: ${reason === 'max_output_tokens' ? 'max_tokens' : reason}`,
            status: 422,
            retryable: false,
            upstreamStatus: 200,
          });
        }

        const text = readOpenAiOutput(data);
        if (!text) {
          throw new OpenAiProviderError({
            code: 'OPENAI_EMPTY_RESPONSE',
            message: 'A OpenAI retornou uma resposta sem texto.',
            status: 502,
            retryable: true,
            upstreamStatus: 200,
          });
        }

        return { text, candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] };
      },
    },
  };
}

function rewriteLegacyProviderMessage(value: any): any {
  if (typeof value !== 'string') return value;
  let message = value;
  message = message.replace(/Calling Gemini API using model (gpt-[^\s]+)/g, 'Calling OpenAI API using model $1');
  message = message.replace(/Gemini API transient error on model (gpt-[^\s]+)/g, 'OpenAI API transient error on model $1');
  message = message.replace(/Model (gpt-[^\s]+) failed with error:([\s\S]*?)Trying next fallback model\.\.\./g, 'OpenAI model $1 failed:$2No automatic provider fallback will be used.');
  return message;
}

export function installProviderAwareLogging() {
  const consoleRecord = console as any;
  if (consoleRecord[PROVIDER_LOGGING_INSTALLED]) return;
  consoleRecord[PROVIDER_LOGGING_INSTALLED] = true;

  const currentLog = console.log.bind(console);
  const currentWarn = console.warn.bind(console);
  console.log = (...args: any[]) => currentLog(...args.map(rewriteLegacyProviderMessage));
  console.warn = (...args: any[]) => currentWarn(...args.map(rewriteLegacyProviderMessage));
}

export function installOpenAiModelRouter(server: ServerBindings) {
  const appRecord = server.app as any;
  if (appRecord[OPENAI_ROUTER_INSTALLED]) return getOpenAiModelPolicy();
  appRecord[OPENAI_ROUTER_INSTALLED] = true;

  const policy = getOpenAiModelPolicy();
  Object.assign(server.TEXT_MODELS as any, policy);
  server.setAiClient(createRoutedOpenAiClient(server, policy));
  installProviderAwareLogging();

  server.app.get('/api/text-model-policy', (_req, res) => {
    res.json({
      provider: 'openai',
      policy,
      automaticProviderFallback: false,
      accountLimitStopsImmediately: true,
      routing: {
        bulk: 'tarefas repetitivas e de alto volume',
        editorial: 'Bíblia, continuidade, personagens e roteiro',
        audit: 'auditoria, ambiguidades e validações críticas',
      },
    });
  });

  console.info(`[OpenAI] model policy installed: bulk=${policy.bulk}, editorial=${policy.editorial}, audit=${policy.audit}`);
  return policy;
}
