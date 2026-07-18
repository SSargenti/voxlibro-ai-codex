type ScriptJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

type ScriptJobResponse = {
  job: {
    jobId: string;
    projectId: string;
    status: ScriptJobStatus;
    progress: number;
    totalBatches: number;
    completedBatchIds: string[];
    fallbackBatchIds: string[];
    currentBatchIndex?: number;
    lastError?: { message?: string; retryable?: boolean };
    summary?: {
      totalSourceUnits: number;
      totalSegments: number;
      totalUnresolved: number;
      coverage: number;
      usedDeterministicDraft: boolean;
      scriptComplete: boolean;
    };
  };
  result?: {
    project: any;
    segments: any[];
    report: any;
  };
  error?: { code?: string; message?: string };
};

type WindowState = typeof window & {
  __voxlibroScriptGenerationInstalled?: boolean;
};

const stateWindow = window as WindowState;
const nativeFetch = window.fetch.bind(window);
const activePolls = new Map<string, Promise<ScriptJobResponse>>();
let dock: HTMLElement | null = null;
let statusText: HTMLElement | null = null;
let progressBar: HTMLElement | null = null;
let detailText: HTMLElement | null = null;
let reviewRefreshRunning = false;

function sleep(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function readBody(init?: RequestInit) {
  if (typeof init?.body !== 'string') return {};
  try { return JSON.parse(init.body); }
  catch { return {}; }
}

function projectIdFromLegacyScriptUrl(url: string) {
  const pathname = new URL(url, window.location.origin).pathname;
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/script\/?$/);
  return match ? decodeURIComponent(match[1]) : '';
}

function segmentFromLegacyUpdateUrl(url: string) {
  const pathname = new URL(url, window.location.origin).pathname;
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/segments\/([^/]+)\/?$/);
  return match ? { projectId: decodeURIComponent(match[1]), segmentId: decodeURIComponent(match[2]) } : null;
}

function installStyles() {
  if (document.getElementById('voxlibro-script-job-styles')) return;
  const style = document.createElement('style');
  style.id = 'voxlibro-script-job-styles';
  style.textContent = `
    .script-job-dock { position: fixed; right: 22px; bottom: 22px; z-index: 97; width: min(410px, calc(100vw - 32px)); padding: 14px 15px; border: 1px solid rgba(20,42,36,.16); border-radius: 17px; background: rgba(251,253,249,.98); box-shadow: 0 18px 55px rgba(18,39,32,.22); color: #16372e; font-family: inherit; backdrop-filter: blur(14px); }
    .script-job-dock[hidden] { display: none !important; }
    .script-job-head { display: flex; align-items: center; gap: 10px; }
    .script-job-mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; background: #18382f; color: white; font-size: 13px; font-weight: 900; }
    .script-job-copy { min-width: 0; flex: 1; }
    .script-job-copy strong { display: block; font-size: 13px; }
    .script-job-copy small { display: block; margin-top: 2px; overflow: hidden; color: #68766f; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .script-job-percent { font-size: 18px; font-weight: 900; }
    .script-job-track { height: 7px; margin-top: 11px; overflow: hidden; border-radius: 99px; background: #dce4df; }
    .script-job-track i { display: block; height: 100%; border-radius: inherit; background: #2c735c; transition: width .3s ease; }
    .script-job-detail { margin: 8px 0 0; color: #67756e; font-size: 10px; line-height: 1.4; }
    .script-job-dock.error { border-color: rgba(145,46,46,.28); background: rgba(255,246,244,.98); color: #862d2d; }
    .script-job-dock.complete { border-color: rgba(44,115,92,.28); }
    .script-review-assistant { margin-top: 18px; }
    .script-review-summary { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 10px; margin: 14px 0; }
    .script-review-summary div { padding: 11px; border: 1px solid rgba(20,42,36,.1); border-radius: 12px; background: #f7faf7; }
    .script-review-summary strong { display: block; font-size: 17px; }
    .script-review-summary span { display: block; margin-top: 3px; color: #68766f; font-size: 10px; }
    .script-review-warning { margin: 10px 0; padding: 11px 12px; border-radius: 12px; background: #fff7e7; color: #72531a; font-size: 12px; }
    .script-unresolved-list { display: grid; gap: 9px; max-height: 520px; overflow: auto; padding-right: 3px; }
    .script-unresolved-row { display: grid; grid-template-columns: minmax(0,1fr) minmax(170px,240px); gap: 12px; align-items: center; padding: 11px 12px; border: 1px solid rgba(20,42,36,.11); border-radius: 13px; background: white; }
    .script-unresolved-row strong { display: block; font-size: 11px; }
    .script-unresolved-row p { margin: 4px 0 0; color: #68766f; font-size: 11px; line-height: 1.35; }
    .script-unresolved-row select, .script-speaker-select { width: 100%; padding: 7px 9px; border: 1px solid rgba(20,42,36,.16); border-radius: 9px; background: white; color: inherit; font: inherit; font-size: 11px; }
    .script-speaker-inline { display: inline-flex; align-items: center; min-width: 150px; }
    .script-speaker-pending { color: #9a4f22 !important; }
    @media (max-width: 820px) { .script-job-dock { right: 14px; bottom: 14px; } .script-review-summary { grid-template-columns: repeat(2,minmax(0,1fr)); } .script-unresolved-row { grid-template-columns: 1fr; } }
  `;
  document.head.appendChild(style);
}

function ensureDock() {
  if (dock) return;
  installStyles();
  dock = document.createElement('aside');
  dock.className = 'script-job-dock';
  dock.hidden = true;
  dock.setAttribute('aria-live', 'polite');
  const head = document.createElement('div');
  head.className = 'script-job-head';
  const mark = document.createElement('div');
  mark.className = 'script-job-mark';
  mark.textContent = 'R';
  const copy = document.createElement('div');
  copy.className = 'script-job-copy';
  const strong = document.createElement('strong');
  strong.textContent = 'Roteiro de locução';
  statusText = document.createElement('small');
  statusText.textContent = 'Preparando geração persistente…';
  copy.append(strong, statusText);
  const percent = document.createElement('div');
  percent.className = 'script-job-percent';
  percent.textContent = '0%';
  percent.dataset.role = 'percent';
  head.append(mark, copy, percent);
  const track = document.createElement('div');
  track.className = 'script-job-track';
  progressBar = document.createElement('i');
  progressBar.style.width = '0%';
  track.appendChild(progressBar);
  detailText = document.createElement('p');
  detailText.className = 'script-job-detail';
  detailText.textContent = 'Cada lote concluído é salvo e pode ser retomado após reinicializações.';
  dock.append(head, track, detailText);
  document.body.appendChild(dock);
}

function showJob(job: ScriptJobResponse['job'], message?: string) {
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
    job.status === 'queued' ? 'Roteiro enfileirado' :
    job.status === 'processing' ? 'Gerando roteiro com GPT-5.6 Terra' :
    job.status === 'completed' ? 'Roteiro processado' :
    job.status === 'cancelled' ? 'Processamento cancelado' :
    'Processamento interrompido'
  );
  const total = Number(job.totalBatches || 0);
  const completed = Array.isArray(job.completedBatchIds) ? job.completedBatchIds.length : 0;
  detailText.textContent = job.status === 'failed'
    ? `${job.lastError?.message || 'Falha temporária.'} Os lotes concluídos foram preservados; a próxima tentativa continuará do checkpoint.`
    : job.status === 'completed'
      ? job.summary?.scriptComplete
        ? `${job.summary.totalSegments} trechos · cobertura ${job.summary.coverage}% · roteiro pronto para áudio.`
        : `${job.summary?.totalSegments || 0} trechos · ${job.summary?.totalUnresolved || 0} locutor(es) pendente(s). Revise as pendências na etapa Roteiro.`
      : `${completed} de ${total} lote(s) concluídos${job.currentBatchIndex ? ` · lote atual ${job.currentBatchIndex}` : ''}. Reinícios do serviço não apagam os checkpoints.`;
}

function hideDockLater() {
  window.setTimeout(() => { if (dock?.classList.contains('complete')) dock.hidden = true; }, 6000);
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
  throw lastError || new Error('Não foi possível reconectar ao processamento do roteiro.');
}

async function pollProject(projectId: string): Promise<ScriptJobResponse> {
  const existing = activePolls.get(projectId);
  if (existing) return existing;
  const promise = (async () => {
    for (let iteration = 0; iteration < 43_200; iteration++) {
      const { response, data } = await fetchJsonWithRestartTolerance(
        `/api/projects/${encodeURIComponent(projectId)}/script-generation/status`,
      );
      if (response.status === 404) throw new Error(data?.error?.message || 'O job do roteiro não foi encontrado.');
      if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
      const payload = data as ScriptJobResponse;
      showJob(payload.job);
      if (payload.job.status === 'completed') {
        hideDockLater();
        return payload;
      }
      if (payload.job.status === 'failed' || payload.job.status === 'cancelled') return payload;
      await sleep(1200);
    }
    throw new Error('O roteiro excedeu o limite máximo de acompanhamento. O job continua preservado no servidor.');
  })().finally(() => activePolls.delete(projectId));
  activePolls.set(projectId, promise);
  return promise;
}

async function interceptLegacyScript(projectId: string, init?: RequestInit) {
  const body = readBody(init);
  const { response, data } = await fetchJsonWithRestartTolerance(
    `/api/projects/${encodeURIComponent(projectId)}/script-generation/start`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceFresh: body.forceFresh === true }),
    },
  );
  if (!response.ok) return jsonResponse(data, response.status);
  const started = data as ScriptJobResponse;
  showJob(started.job);
  const finished = await pollProject(projectId);
  if (finished.job.status === 'completed' && finished.result) {
    window.setTimeout(() => void refreshScriptReview(), 0);
    return jsonResponse(finished.result, 200);
  }
  return jsonResponse({
    error: {
      code: finished.job.status === 'cancelled' ? 'SCRIPT_GENERATION_CANCELLED' : 'SCRIPT_GENERATION_INTERRUPTED',
      message: finished.job.lastError?.message || `O roteiro terminou com status ${finished.job.status}.`,
      retryable: finished.job.status === 'failed',
    },
  }, finished.job.status === 'cancelled' ? 409 : 503);
}

async function interceptLegacySegmentUpdate(target: { projectId: string; segmentId: string }, init?: RequestInit) {
  const { response, data } = await fetchJsonWithRestartTolerance(
    `/api/projects/${encodeURIComponent(target.projectId)}/script-generation/segments/${encodeURIComponent(target.segmentId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(readBody(init)),
    },
    10,
  );
  if (response.ok) window.setTimeout(() => void refreshScriptReview(), 0);
  return jsonResponse(data, response.status);
}

function currentProjectId() {
  return localStorage.getItem('voxlibro.project') || '';
}

function scriptStageVisible() {
  return document.querySelector('.stage-top h1')?.textContent?.trim() === 'Roteiro';
}

function refreshButton() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.stage-top button'))
    .find(button => button.textContent?.includes('Atualizar'));
}

function characterOption(character: any, selected = false) {
  const option = document.createElement('option');
  option.value = character.characterId;
  option.textContent = character.canonicalName || character.characterId;
  option.selected = selected;
  return option;
}

async function updateSpeaker(projectId: string, segment: any, speakerId: string) {
  const response = await nativeFetch(
    `/api/projects/${encodeURIComponent(projectId)}/script-segments/${encodeURIComponent(segment.segmentId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spokenText: segment.spokenText, speakerId, direction: segment.direction }),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
  await refreshScriptReview();
}

function buildSpeakerSelect(projectId: string, segment: any, characters: any[]) {
  const select = document.createElement('select');
  select.className = 'script-speaker-select';
  const unresolved = document.createElement('option');
  unresolved.value = 'unresolved';
  unresolved.textContent = 'Locutor pendente';
  select.appendChild(unresolved);
  for (const character of characters) select.appendChild(characterOption(character));
  if (!characters.some(character => character.characterId === 'char_narrator')) {
    select.appendChild(characterOption({ characterId: 'char_narrator', canonicalName: 'Narrador' }));
  }
  select.value = segment.speakerId || 'unresolved';
  select.addEventListener('change', async () => {
    select.disabled = true;
    try { await updateSpeaker(projectId, segment, select.value); }
    catch (error: any) { window.alert(error?.message || 'Não foi possível alterar o locutor.'); }
    finally { select.disabled = false; }
  });
  return select;
}

function renderReviewPanel(projectId: string, payload: ScriptJobResponse, detail: any) {
  const oldPanel = Array.from(document.querySelectorAll<HTMLElement>('.stage .panel'))
    .find(panel => panel.querySelector('h2')?.textContent?.trim() === 'Roteiro de locução');
  if (!oldPanel) return;
  let panel = document.getElementById('script-review-assistant');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'script-review-assistant';
    panel.className = 'panel script-review-assistant';
    oldPanel.insertAdjacentElement('afterend', panel);
  }
  panel.innerHTML = '';
  const report = payload.result?.report || {};
  const segments = Array.isArray(detail?.segments) ? detail.segments : payload.result?.segments || [];
  const characters = Array.isArray(detail?.characters) ? detail.characters : [];
  const unresolved = segments.filter((segment: any) => segment.speakerId === 'unresolved');

  const title = document.createElement('div');
  title.className = 'panel-title';
  title.innerHTML = `<div><h2>Auditoria do roteiro</h2><p>Cobertura, checkpoints e locutores pendentes são atualizados sem refazer os lotes concluídos.</p></div>`;
  panel.appendChild(title);

  const summary = document.createElement('div');
  summary.className = 'script-review-summary';
  const cards = [
    [String(report.coverage ?? payload.job.summary?.coverage ?? 0) + '%', 'Cobertura'],
    [String(segments.length), 'Trechos'],
    [String(unresolved.length), 'Locutores pendentes'],
    [String(payload.job.fallbackBatchIds?.length || 0), 'Lotes em revisão'],
  ];
  for (const [value, label] of cards) {
    const card = document.createElement('div');
    card.innerHTML = `<strong>${value}</strong><span>${label}</span>`;
    summary.appendChild(card);
  }
  panel.appendChild(summary);

  if (payload.job.fallbackBatchIds?.length) {
    const warning = document.createElement('div');
    warning.className = 'script-review-warning';
    warning.textContent = `${payload.job.fallbackBatchIds.length} lote(s) usaram o rascunho determinístico após uma resposta inválida ou indisponibilidade da IA. A cobertura foi preservada; revise locutores e texto antes do áudio.`;
    panel.appendChild(warning);
  }

  if (unresolved.length) {
    const heading = document.createElement('h3');
    heading.textContent = `Definir locutores pendentes (${unresolved.length})`;
    panel.appendChild(heading);
    const list = document.createElement('div');
    list.className = 'script-unresolved-list';
    for (const segment of unresolved.slice(0, 200)) {
      const row = document.createElement('div');
      row.className = 'script-unresolved-row';
      const copy = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = `${segment.chapterId || 'Capítulo'} · trecho ${segment.order || ''}`;
      const excerpt = document.createElement('p');
      excerpt.textContent = String(segment.originalText || segment.spokenText || '').slice(0, 260);
      copy.append(strong, excerpt);
      row.append(copy, buildSpeakerSelect(projectId, segment, characters));
      list.appendChild(row);
    }
    panel.appendChild(list);
    if (unresolved.length > 200) {
      const warning = document.createElement('div');
      warning.className = 'script-review-warning';
      warning.textContent = `Mostrando 200 de ${unresolved.length} pendências. Resolva este grupo e a lista será atualizada.`;
      panel.appendChild(warning);
    }
  } else {
    const ready = document.createElement('div');
    ready.className = 'script-review-warning';
    ready.textContent = report.scriptComplete
      ? 'Roteiro com cobertura integral e todos os locutores definidos. A geração de áudio está liberada.'
      : 'Nenhum locutor pendente. Atualize a página para recalcular o estado final do roteiro.';
    panel.appendChild(ready);
  }
}

async function refreshScriptReview() {
  if (reviewRefreshRunning || !scriptStageVisible()) return;
  const projectId = currentProjectId();
  if (!projectId) return;
  reviewRefreshRunning = true;
  try {
    const [statusResponse, detailResponse] = await Promise.all([
      nativeFetch(`/api/projects/${encodeURIComponent(projectId)}/script-generation/status`, { cache: 'no-store' }),
      nativeFetch(`/api/projects/${encodeURIComponent(projectId)}/script-review-state?limit=120`, { cache: 'no-store' }),
    ]);
    if (statusResponse.status === 404 || !statusResponse.ok || !detailResponse.ok) return;
    const payload = await statusResponse.json() as ScriptJobResponse;
    const detail = await detailResponse.json();
    showJob(payload.job);
    if (payload.job.status === 'completed') renderReviewPanel(projectId, payload, detail);
  } catch {
    // A tela principal permanece utilizável; o painel será refeito na próxima mutação.
  } finally {
    reviewRefreshRunning = false;
  }
}

async function discoverActiveJob() {
  const projectId = currentProjectId();
  if (!projectId || !scriptStageVisible() || activePolls.has(projectId)) return;
  try {
    const response = await nativeFetch(`/api/projects/${encodeURIComponent(projectId)}/script-generation/status`, { cache: 'no-store' });
    if (response.status === 404) return;
    const data = await response.json().catch(() => ({})) as ScriptJobResponse;
    if (!response.ok || !data.job) return;
    showJob(data.job);
    if (['queued', 'processing'].includes(data.job.status)) {
      const finished = await pollProject(projectId);
      if (finished.job.status === 'completed') refreshButton()?.click();
    }
    await refreshScriptReview();
  } catch {
    // Descoberta silenciosa; o botão principal continua disponível.
  }
}

function install() {
  if (stateWindow.__voxlibroScriptGenerationInstalled) return;
  stateWindow.__voxlibroScriptGenerationInstalled = true;
  ensureDock();

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const inputUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'POST') {
      const projectId = projectIdFromLegacyScriptUrl(inputUrl);
      if (projectId) return interceptLegacyScript(projectId, init);
      const segment = segmentFromLegacyUpdateUrl(inputUrl);
      if (segment) return interceptLegacySegmentUpdate(segment, init);
    }
    return nativeFetch(input, init);
  }) as typeof window.fetch;

  let timer = 0;
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void discoverActiveJob(), 120);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener('focus', () => void discoverActiveJob());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void discoverActiveJob(); });
  window.setInterval(() => { if (scriptStageVisible()) void refreshScriptReview(); }, 5000);
  void discoverActiveJob();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
else install();
