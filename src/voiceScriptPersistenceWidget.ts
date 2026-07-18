type ProjectDetail = {
  project?: { projectId?: string; productionMode?: string };
  characters?: any[];
  segments?: any[];
};

type WindowState = typeof window & {
  __voxlibroVoiceScriptPersistenceInstalled?: boolean;
};

const stateWindow = window as WindowState;
const delegatedFetch = window.fetch.bind(window);
let detail: ProjectDetail | null = null;
let syncing = false;
let timer = 0;
const affectedSegments = new Set<string>();

function activeProjectId() { return localStorage.getItem('voxlibro.project') || ''; }
function parseBody(init?: RequestInit) {
  if (typeof init?.body !== 'string') return {};
  try { return JSON.parse(init.body); } catch { return {}; }
}
function jsonResponse(body: unknown, source: Response) {
  const headers = new Headers(source.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status: source.status, statusText: source.statusText, headers });
}
function legacyVoiceTarget(url: string, method: string) {
  if (method !== 'POST') return '';
  const match = new URL(url, window.location.origin).pathname.match(/^\/api\/projects\/([^/]+)\/voices\/?$/);
  return match ? decodeURIComponent(match[1]) : '';
}
function legacySegmentTarget(url: string, method: string) {
  if (method !== 'POST') return null;
  const match = new URL(url, window.location.origin).pathname.match(/^\/api\/projects\/([^/]+)\/segments\/([^/]+)\/?$/);
  return match ? { projectId: decodeURIComponent(match[1]), segmentId: decodeURIComponent(match[2]) } : null;
}
async function requestJson(url: string, init?: RequestInit) {
  const response = await delegatedFetch(url, { ...init, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.error || `HTTP ${response.status}`);
  return data;
}
function installFetchPersistence() {
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const voiceProjectId = legacyVoiceTarget(url, method);
    if (voiceProjectId) {
      const response = await delegatedFetch(`/api/projects/${encodeURIComponent(voiceProjectId)}/voice-assignments`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parseBody(init)),
        cache: 'no-store',
      });
      const data = await response.clone().json().catch(() => ({}));
      for (const segmentId of data?.affectedSegmentIds || []) affectedSegments.add(segmentId);
      scheduleSync(30);
      return jsonResponse(data, response);
    }
    const segment = legacySegmentTarget(url, method);
    if (segment) {
      const response = await delegatedFetch(`/api/projects/${encodeURIComponent(segment.projectId)}/script-segments/${encodeURIComponent(segment.segmentId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parseBody(init)),
        cache: 'no-store',
      });
      scheduleSync(30);
      return response;
    }
    return delegatedFetch(input, init);
  }) as typeof window.fetch;
}
function ensureStyles() {
  if (document.getElementById('voxlibro-voice-script-persistence-styles')) return;
  const style = document.createElement('style');
  style.id = 'voxlibro-voice-script-persistence-styles';
  style.textContent = `
    .voice-save-state { display:inline-flex; align-items:center; min-width:58px; margin-left:8px; color:#60766e; font-size:10px; font-weight:700; }
    .voice-save-state.saving { color:#8b651c; }
    .voice-save-state.saved { color:#287057; }
    .voice-save-state.error { color:#9a3636; }
    .voice-regenerate-button { display:inline-flex; align-items:center; gap:6px; margin-top:8px; padding:7px 10px; border:1px solid rgba(20,42,36,.16); border-radius:9px; background:#fff; color:#20483c; font:inherit; font-size:11px; font-weight:750; cursor:pointer; }
    .voice-regenerate-button:disabled { cursor:wait; opacity:.6; }
    .voice-batch-regenerate { margin-left:auto; }
  `;
  document.head.appendChild(style);
}
function stageTitle() { return document.querySelector('.stage-top h1')?.textContent?.trim() || ''; }
function refreshMainView() {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.stage-top button')).find(item => /Atualizar/i.test(item.textContent || ''));
  button?.click();
}
function rowStatus(row: Element) {
  let status = row.querySelector<HTMLElement>('.voice-save-state');
  if (!status) {
    status = document.createElement('span');
    status.className = 'voice-save-state';
    const select = row.querySelector('select');
    select?.insertAdjacentElement('afterend', status);
  }
  return status;
}
function characterForRow(row: Element, index: number) {
  const name = row.querySelector('.cast-name strong')?.textContent?.trim();
  return detail?.characters?.find(character => character.canonicalName === name) || detail?.characters?.[index];
}
async function saveOneVoice(row: Element, index: number, select: HTMLSelectElement) {
  const projectId = activeProjectId();
  const character = characterForRow(row, index);
  if (!projectId || !character?.characterId) return;
  const status = rowStatus(row);
  status.className = 'voice-save-state saving';
  status.textContent = 'Salvando…';
  select.disabled = true;
  try {
    const result = await requestJson(`/api/projects/${encodeURIComponent(projectId)}/voice-assignments`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments: [{ characterId: character.characterId, voiceAssignmentId: select.value }] }),
    });
    for (const segmentId of result?.affectedSegmentIds || []) affectedSegments.add(segmentId);
    status.className = 'voice-save-state saved';
    status.textContent = 'Salvo';
    detail = { ...(detail || {}), project: result.project || detail?.project, characters: result.characters || detail?.characters, segments: result.segments || detail?.segments };
    renderBatchRegeneration();
  } catch (error: any) {
    status.className = 'voice-save-state error';
    status.textContent = 'Erro ao salvar';
    window.alert(error?.message || 'Não foi possível salvar a voz.');
  } finally {
    select.disabled = false;
  }
}
function bindVoiceAutosave() {
  const panel = Array.from(document.querySelectorAll<HTMLElement>('section.panel')).find(item => /Elenco de vozes inteligente|Voz única do narrador/.test(item.querySelector('h2')?.textContent || ''));
  if (!panel) return;
  panel.querySelectorAll<HTMLElement>('.cast-row').forEach((row, index) => {
    const select = row.querySelector<HTMLSelectElement>('select');
    if (!select || select.dataset.voiceAutosaveBound === 'true') return;
    select.dataset.voiceAutosaveBound = 'true';
    select.addEventListener('change', () => void saveOneVoice(row, index, select));
  });
  renderBatchRegeneration();
}
async function regenerateSegment(segmentId: string, button: HTMLButtonElement) {
  const projectId = activeProjectId();
  if (!projectId) return;
  const segment = detail?.segments?.find(item => item.segmentId === segmentId);
  if (!segment) return;
  button.disabled = true;
  const previous = button.textContent || 'Regenerar áudio';
  button.textContent = 'Gerando áudio…';
  try {
    const cards = Array.from(document.querySelectorAll<HTMLElement>('.segment'));
    const card = cards.find((item, index) => detail?.segments?.[index]?.segmentId === segmentId);
    const textarea = card?.querySelector<HTMLTextAreaElement>('textarea');
    const speaker = card?.querySelector<HTMLSelectElement>('.script-speaker-select');
    if (textarea && textarea.value !== segment.spokenText) {
      await requestJson(`/api/projects/${encodeURIComponent(projectId)}/script-segments/${encodeURIComponent(segmentId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spokenText: textarea.value, speakerId: speaker?.value || segment.speakerId, direction: segment.direction }),
      });
    }
    const result = await requestJson(`/api/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(segmentId)}/tts`, { method: 'POST' });
    affectedSegments.delete(segmentId);
    button.textContent = 'Áudio regenerado';
    if (result?.segment && detail?.segments) detail.segments = detail.segments.map(item => item.segmentId === segmentId ? result.segment : item);
    window.setTimeout(() => { button.textContent = previous; }, 1800);
    refreshMainView();
  } catch (error: any) {
    button.textContent = 'Falha ao gerar';
    window.alert(error?.message || 'Não foi possível regenerar o áudio.');
  } finally {
    button.disabled = false;
    renderBatchRegeneration();
  }
}
function addSegmentRegenerationButtons() {
  if (!['Roteiro', 'Áudio'].includes(stageTitle())) return;
  document.querySelectorAll<HTMLElement>('.segment').forEach((card, index) => {
    const segment = detail?.segments?.[index];
    if (!segment || card.querySelector('.voice-regenerate-button')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'voice-regenerate-button';
    button.textContent = segment.status === 'ready' ? 'Regenerar áudio' : 'Gerar este áudio';
    button.addEventListener('click', () => void regenerateSegment(segment.segmentId, button));
    const main = card.querySelector('.segment-main') || card;
    main.appendChild(button);
  });
}
async function regenerateAffected(button: HTMLButtonElement) {
  const ids = Array.from(affectedSegments);
  if (!ids.length) return;
  button.disabled = true;
  let completed = 0;
  for (const id of ids) {
    button.textContent = `Regenerando ${completed + 1}/${ids.length}…`;
    try {
      await requestJson(`/api/projects/${encodeURIComponent(activeProjectId())}/segments/${encodeURIComponent(id)}/tts`, { method: 'POST' });
      affectedSegments.delete(id);
      completed += 1;
    } catch (error: any) {
      window.alert(`Falha no trecho ${id}: ${error?.message || 'erro desconhecido'}`);
      break;
    }
  }
  button.disabled = false;
  refreshMainView();
  await sync(true);
}
function renderBatchRegeneration() {
  const panel = Array.from(document.querySelectorAll<HTMLElement>('section.panel')).find(item => /Elenco de vozes inteligente|Voz única do narrador/.test(item.querySelector('h2')?.textContent || ''));
  if (!panel) return;
  const actions = panel.querySelector('.panel-actions');
  if (!actions) return;
  let button = actions.querySelector<HTMLButtonElement>('.voice-batch-regenerate');
  if (!affectedSegments.size) { button?.remove(); return; }
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'button quiet voice-batch-regenerate';
    button.addEventListener('click', () => void regenerateAffected(button!));
    actions.appendChild(button);
  }
  button.textContent = `Regenerar áudios afetados (${affectedSegments.size})`;
}
function applyUi() {
  ensureStyles();
  bindVoiceAutosave();
  addSegmentRegenerationButtons();
  renderBatchRegeneration();
}
async function sync(force = false) {
  if (syncing) return;
  const projectId = activeProjectId();
  if (!projectId) return;
  syncing = true;
  try {
    const response = await delegatedFetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: 'no-store' });
    if (response.ok) detail = await response.json().catch(() => detail);
    if (force && detail?.segments) {
      for (const segment of detail.segments) if (segment.status === 'pending' && segment.voiceInvalidatedAt) affectedSegments.add(segment.segmentId);
    }
    applyUi();
  } finally { syncing = false; }
}
function scheduleSync(delay = 100) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void sync(), delay);
}
function install() {
  if (stateWindow.__voxlibroVoiceScriptPersistenceInstalled) return;
  stateWindow.__voxlibroVoiceScriptPersistenceInstalled = true;
  installFetchPersistence();
  ensureStyles();
  const observer = new MutationObserver(() => { applyUi(); scheduleSync(250); });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener('focus', () => void sync(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync(true); });
  void sync(true);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
else install();
