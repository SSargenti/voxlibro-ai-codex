type CharacterJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

type CharacterJobResponse = {
  job: {
    jobId: string;
    projectId: string;
    status: CharacterJobStatus;
    progress: number;
    totalUnits: number;
    completedUnitIds: string[];
    currentChapterId?: string;
    lastError?: { message?: string; retryable?: boolean };
  };
  result?: {
    project: any;
    characters: any[];
    sightings: any[];
    mergeSuggestions: any[];
  };
  error?: { code?: string; message?: string };
};

type WindowState = typeof window & {
  __voxlibroCharacterAnalysisInstalled?: boolean;
};

const stateWindow = window as WindowState;
const activePolls = new Map<string, Promise<CharacterJobResponse>>();
const nativeFetch = window.fetch.bind(window);
let dock: HTMLElement | null = null;
let statusText: HTMLElement | null = null;
let progressBar: HTMLElement | null = null;
let detailText: HTMLElement | null = null;

function sleep(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function projectIdFromAnalyzeUrl(url: string) {
  const pathname = new URL(url, window.location.origin).pathname;
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/analyze-characters\/?$/);
  return match ? decodeURIComponent(match[1]) : '';
}

function readBody(init?: RequestInit) {
  if (typeof init?.body !== 'string') return {};
  try { return JSON.parse(init.body); }
  catch { return {}; }
}

function installStyles() {
  if (document.getElementById('voxlibro-character-job-styles')) return;
  const style = document.createElement('style');
  style.id = 'voxlibro-character-job-styles';
  style.textContent = `
    .character-job-dock { position: fixed; left: 22px; bottom: 22px; z-index: 96; width: min(390px, calc(100vw - 32px)); padding: 14px 15px; border: 1px solid rgba(20,42,36,.16); border-radius: 17px; background: rgba(251,253,249,.98); box-shadow: 0 18px 55px rgba(18,39,32,.22); color: #16372e; font-family: inherit; backdrop-filter: blur(14px); }
    .character-job-dock[hidden] { display: none !important; }
    .character-job-head { display: flex; align-items: center; gap: 10px; }
    .character-job-mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; background: #18382f; color: white; font-size: 13px; font-weight: 900; }
    .character-job-copy { min-width: 0; flex: 1; }
    .character-job-copy strong { display: block; font-size: 13px; }
    .character-job-copy small { display: block; margin-top: 2px; overflow: hidden; color: #68766f; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .character-job-percent { font-size: 18px; font-weight: 900; }
    .character-job-track { height: 7px; margin-top: 11px; overflow: hidden; border-radius: 99px; background: #dce4df; }
    .character-job-track i { display: block; height: 100%; border-radius: inherit; background: #2c735c; transition: width .3s ease; }
    .character-job-detail { margin: 8px 0 0; color: #67756e; font-size: 10px; line-height: 1.4; }
    .character-job-dock.error { border-color: rgba(145,46,46,.28); background: rgba(255,246,244,.98); color: #862d2d; }
    .character-job-dock.complete { border-color: rgba(44,115,92,.28); }
    @media (max-width: 820px) { .character-job-dock { left: 14px; bottom: 14px; } }
  `;
  document.head.appendChild(style);
}

function ensureDock() {
  if (dock) return;
  installStyles();
  dock = document.createElement('aside');
  dock.className = 'character-job-dock';
  dock.hidden = true;
  dock.setAttribute('aria-live', 'polite');
  const head = document.createElement('div');
  head.className = 'character-job-head';
  const mark = document.createElement('div');
  mark.className = 'character-job-mark';
  mark.textContent = 'B';
  const copy = document.createElement('div');
  copy.className = 'character-job-copy';
  const strong = document.createElement('strong');
  strong.textContent = 'Bíblia narrativa';
  statusText = document.createElement('small');
  statusText.textContent = 'Preparando análise persistente…';
  copy.append(strong, statusText);
  const percent = document.createElement('div');
  percent.className = 'character-job-percent';
  percent.textContent = '0%';
  percent.dataset.role = 'percent';
  head.append(mark, copy, percent);
  const track = document.createElement('div');
  track.className = 'character-job-track';
  progressBar = document.createElement('i');
  progressBar.style.width = '0%';
  track.appendChild(progressBar);
  detailText = document.createElement('p');
  detailText.className = 'character-job-detail';
  detailText.textContent = 'O progresso é salvo em disco e retomado depois de reinicializações.';
  dock.append(head, track, detailText);
  document.body.appendChild(dock);
}

function showJob(job: CharacterJobResponse['job'], message?: string) {
  ensureDock();
  if (!dock || !statusText || !progressBar || !detailText) return;
  dock.hidden = false;
  dock.classList.toggle('error', job.status === 'failed');
  dock.classList.toggle('complete', job.status === 'completed');
  const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
  progressBar.style.width = `${progress}%`;
  const percent = dock.querySelector<HTMLElement>('[data-role="percent"]');
  if (percent) percent.textContent = `${progress}%`;
  statusText.textContent = message || (
    job.status === 'queued' ? 'Análise enfileirada' :
    job.status === 'processing' ? 'Analisando personagens com GPT-5.6 Terra' :
    job.status === 'completed' ? 'Bíblia concluída' :
    job.status === 'cancelled' ? 'Processamento cancelado' :
    'Processamento interrompido'
  );
  const total = Number(job.totalUnits || 0);
  const completed = Array.isArray(job.completedUnitIds) ? job.completedUnitIds.length : 0;
  detailText.textContent = job.status === 'failed'
    ? `${job.lastError?.message || 'Falha temporária.'} O progresso concluído foi preservado; uma nova tentativa continuará do checkpoint.`
    : job.status === 'completed'
      ? `${completed || total} de ${total} bloco(s) consolidados. Personagens, aliases e vozes existentes foram preservados.`
      : `${completed} de ${total} bloco(s) concluídos${job.currentChapterId ? ` · capítulo ${job.currentChapterId}` : ''}. Reinícios do serviço não apagam os checkpoints.`;
}

function hideDockLater() {
  window.setTimeout(() => { if (dock?.classList.contains('complete')) dock.hidden = true; }, 4500);
}

async function fetchJsonWithRestartTolerance(url: string, init?: RequestInit, retries = 180) {
  let lastError: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await nativeFetch(url, { ...init, cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (response.ok || response.status < 500) return { response, data };
      lastError = new Error(data?.error?.message || `HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    ensureDock();
    if (statusText) statusText.textContent = 'Serviço reiniciando; retomada automática em andamento…';
    await sleep(Math.min(5000, 1000 + attempt * 100));
  }
  throw lastError || new Error('Não foi possível reconectar ao processamento da Bíblia.');
}

async function pollProject(projectId: string): Promise<CharacterJobResponse> {
  const existing = activePolls.get(projectId);
  if (existing) return existing;
  const promise = (async () => {
    for (let iteration = 0; iteration < 43_200; iteration++) {
      const { response, data } = await fetchJsonWithRestartTolerance(
        `/api/projects/${encodeURIComponent(projectId)}/character-analysis/status`,
        undefined,
      );
      if (response.status === 404) throw new Error(data?.error?.message || 'O job da Bíblia não foi encontrado.');
      if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
      const payload = data as CharacterJobResponse;
      showJob(payload.job);
      if (payload.job.status === 'completed') {
        hideDockLater();
        return payload;
      }
      if (payload.job.status === 'failed' || payload.job.status === 'cancelled') return payload;
      await sleep(1200);
    }
    throw new Error('A Bíblia excedeu o limite máximo de acompanhamento. O job continua preservado no servidor.');
  })().finally(() => activePolls.delete(projectId));
  activePolls.set(projectId, promise);
  return promise;
}

async function interceptAnalyze(projectId: string, init?: RequestInit) {
  const body = readBody(init);
  const { response, data } = await fetchJsonWithRestartTolerance(
    `/api/projects/${encodeURIComponent(projectId)}/character-analysis/start`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        forceFresh: body.forceFresh === true,
        allowTechnicalAuthors: body.allowTechnicalAuthors,
      }),
    },
  );
  if (!response.ok) return jsonResponse(data, response.status);
  const started = data as CharacterJobResponse;
  showJob(started.job);
  const finished = await pollProject(projectId);
  if (finished.job.status === 'completed' && finished.result) return jsonResponse(finished.result, 200);
  return jsonResponse({
    error: {
      code: finished.job.status === 'cancelled' ? 'CHARACTER_ANALYSIS_CANCELLED' : 'CHARACTER_ANALYSIS_INTERRUPTED',
      message: finished.job.lastError?.message || `A Bíblia terminou com status ${finished.job.status}.`,
      retryable: finished.job.status === 'failed',
    },
  }, finished.job.status === 'cancelled' ? 409 : 503);
}

function currentProjectId() {
  return localStorage.getItem('voxlibro.project') || '';
}

function bibleStageVisible() {
  return document.querySelector('.stage-top h1')?.textContent?.trim() === 'Bíblia';
}

async function discoverActiveJob() {
  const projectId = currentProjectId();
  if (!projectId || !bibleStageVisible() || activePolls.has(projectId)) return;
  try {
    const response = await nativeFetch(`/api/projects/${encodeURIComponent(projectId)}/character-analysis/status`, { cache: 'no-store' });
    if (response.status === 404) return;
    const data = await response.json().catch(() => ({})) as CharacterJobResponse;
    if (!response.ok || !data.job) return;
    showJob(data.job);
    if (['queued', 'processing'].includes(data.job.status)) {
      const finished = await pollProject(projectId);
      if (finished.job.status === 'completed') {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.stage-top button'));
        buttons.find(button => button.textContent?.includes('Atualizar'))?.click();
      }
    } else if (data.job.status === 'completed') {
      hideDockLater();
    }
  } catch {
    // A descoberta é silenciosa; o botão principal continuará disponível.
  }
}

function install() {
  if (stateWindow.__voxlibroCharacterAnalysisInstalled) return;
  stateWindow.__voxlibroCharacterAnalysisInstalled = true;
  ensureDock();

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const inputUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const projectId = method === 'POST' ? projectIdFromAnalyzeUrl(inputUrl) : '';
    if (projectId) return interceptAnalyze(projectId, init);
    return nativeFetch(input, init);
  }) as typeof window.fetch;

  const observer = new MutationObserver(() => void discoverActiveJob());
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener('focus', () => void discoverActiveJob());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void discoverActiveJob(); });
  void discoverActiveJob();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
else install();
