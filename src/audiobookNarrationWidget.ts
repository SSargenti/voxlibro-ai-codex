type ProjectDetail = {
  project?: { projectId?: string; productionMode?: string };
  characters?: any[];
  segments?: any[];
};

type WindowState = typeof window & {
  __voxlibroAudiobookNarrationInstalled?: boolean;
};

const stateWindow = window as WindowState;
const delegatedFetch = window.fetch.bind(window);
let detail: ProjectDetail | null = null;
let currentProjectId = '';
let scheduled = 0;
let syncing = false;
let applyingUi = false;
let lastSyncAt = 0;

function isAudiobook() {
  return detail?.project?.productionMode === 'audiobook';
}
function narrator() {
  return detail?.characters?.find(character => character.characterId === 'char_narrator')
    || detail?.characters?.find(character => character.role === 'narrator');
}
function activeProjectId() {
  return localStorage.getItem('voxlibro.project') || '';
}
function projectIdFromUrl(url: string) {
  const pathname = new URL(url, window.location.origin).pathname;
  const match = pathname.match(/^\/api\/projects\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}
function isMutation(method: string, url: string) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
  const pathname = new URL(url, window.location.origin).pathname;
  if (pathname.includes('/audiobook-narration-policy')) return false;
  return /^\/api\/projects\/[^/]+\/(?:segments\/|voices|script(?:$|\/|-)|merge-characters|split-character|characters\/)/.test(pathname);
}
function jsonResponse(body: unknown, source: Response) {
  const headers = new Headers(source.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), {
    status: source.status,
    statusText: source.statusText,
    headers,
  });
}
async function enforce(projectId: string) {
  if (!projectId) return null;
  const response = await delegatedFetch(`/api/projects/${encodeURIComponent(projectId)}/audiobook-narration-policy/enforce`, {
    method: 'POST',
    cache: 'no-store',
  });
  return response.ok ? response.json().catch(() => null) : null;
}
function patchMutationBody(body: any, enforced: any) {
  if (!body || typeof body !== 'object' || !enforced?.audiobook) return body;
  const next = { ...body };
  if (enforced.project && next.project) next.project = enforced.project;
  if (Array.isArray(enforced.segments)) {
    if (Array.isArray(next.segments)) next.segments = enforced.segments;
    if (next.result?.segments) next.result = { ...next.result, segments: enforced.segments };
    if (next.segment?.segmentId) {
      next.segment = enforced.segments.find((segment: any) => segment.segmentId === next.segment.segmentId) || next.segment;
    }
  }
  if (enforced.report && next.report) next.report = enforced.report;
  return next;
}

function installFetchPolicy() {
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const response = await delegatedFetch(input, init);
    if (!response.ok || !isMutation(method, url)) return response;
    const projectId = projectIdFromUrl(url);
    if (!projectId) return response;
    const enforced = await enforce(projectId).catch(() => null);
    scheduleSync(20);
    if (!enforced?.audiobook || !(response.headers.get('content-type') || '').includes('application/json')) return response;
    const body = await response.clone().json().catch(() => null);
    return body === null ? response : jsonResponse(patchMutationBody(body, enforced), response);
  }) as typeof window.fetch;
}

function ensureStyles() {
  if (document.getElementById('voxlibro-audiobook-policy-styles')) return;
  const style = document.createElement('style');
  style.id = 'voxlibro-audiobook-policy-styles';
  style.textContent = `
    .voxlibro-audiobook-hidden { display: none !important; }
    .audiobook-single-narrator-note { display: flex; gap: 11px; align-items: flex-start; margin: 14px 0; padding: 13px 14px; border: 1px solid rgba(44,115,92,.22); border-radius: 14px; background: rgba(44,115,92,.07); color: #24483d; }
    .audiobook-single-narrator-note strong { display: block; font-size: 13px; }
    .audiobook-single-narrator-note span { display: block; margin-top: 3px; color: #61766e; font-size: 11px; line-height: 1.45; }
    .audiobook-single-narrator-note b { display: grid; place-items: center; flex: 0 0 28px; height: 28px; border-radius: 9px; background: #18382f; color: white; font-size: 12px; }
  `;
  document.head.appendChild(style);
}
function addNote(panel: Element, id: string, title: string, text: string) {
  if (panel.querySelector(`[data-audiobook-note="${id}"]`)) return;
  const note = document.createElement('div');
  note.className = 'audiobook-single-narrator-note';
  note.dataset.audiobookNote = id;
  note.innerHTML = `<b>N</b><div><strong>${title}</strong><span>${text}</span></div>`;
  const actions = panel.querySelector('.panel-actions');
  if (actions) panel.insertBefore(note, actions);
  else panel.appendChild(note);
}
function setButtonText(button: HTMLButtonElement, text: string) {
  const textNode = Array.from(button.childNodes).find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
  if (textNode) textNode.textContent = text;
  else button.append(document.createTextNode(text));
}
function findPanelByTitle(title: string) {
  return Array.from(document.querySelectorAll<HTMLElement>('section.panel')).find(panel => panel.querySelector('h2')?.textContent?.trim() === title);
}

function adaptCasting() {
  const panel = findPanelByTitle('Elenco de vozes inteligente') || findPanelByTitle('Voz única do narrador');
  if (!panel) return;
  const heading = panel.querySelector('h2');
  const description = panel.querySelector('.panel-title p');
  if (heading) heading.textContent = 'Voz única do narrador';
  if (description) description.textContent = 'No audiolivro, uma única voz narra todo o conteúdo. Personagens e circunstâncias alteram interpretação, emoção, ritmo e pausas — nunca a identidade vocal.';
  const narratorName = narrator()?.canonicalName || 'Narrador';
  panel.querySelectorAll<HTMLElement>('.cast-row').forEach(row => {
    const name = row.querySelector('.cast-name strong')?.textContent?.trim() || '';
    row.classList.toggle('voxlibro-audiobook-hidden', name !== narratorName);
  });
  const saveButton = Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.includes('Salvar elenco'));
  if (saveButton) setButtonText(saveButton, 'Salvar voz do narrador');
  addNote(panel, 'casting', 'Uma voz para toda a obra', 'As fichas dos personagens continuam na Bíblia para orientar a interpretação do narrador, mas suas vozes individuais não são utilizadas.');
}

function adaptScript() {
  const panel = findPanelByTitle('Roteiro de locução');
  if (!panel) return;
  const description = panel.querySelector('.panel-title p');
  if (description) description.textContent = 'Cada trecho usa a mesma voz do narrador. A direção de interpretação varia conforme personagem, emoção e circunstância da cena.';
  const narratorCharacter = narrator();
  const narratorReady = Boolean(narratorCharacter?.voiceAssignmentId || narratorCharacter?.voiceAssignment?.voiceName);
  const generationButton = Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find(button => /Criar roteiro|Refazer roteiro|Conclua o elenco|Defina a voz/.test(button.textContent || ''));
  if (generationButton) {
    generationButton.disabled = !narratorReady;
    if (narratorReady && generationButton.textContent?.includes('Conclua o elenco')) setButtonText(generationButton, detail?.segments?.length ? 'Refazer roteiro' : 'Criar roteiro');
    if (!narratorReady) setButtonText(generationButton, 'Defina a voz do narrador');
  }
  addNote(panel, 'script', 'Narrador único com interpretação contextual', 'Diálogos não recebem vozes separadas. O roteiro conserva emoção, intensidade, ritmo e pausas para o narrador interpretar cada personagem sem mudar de voz.');

  document.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
    if (/locutores pendentes/i.test(button.textContent || '')) button.classList.add('voxlibro-audiobook-hidden');
  });
  document.querySelectorAll<HTMLElement>('.segment').forEach((article, index) => {
    const segment = detail?.segments?.[index];
    const label = article.querySelector<HTMLElement>('.segment-meta b');
    if (!segment || !label) return;
    const portrayedId = segment.portrayedSpeakerId || segment.performanceContext?.portrayedSpeakerId;
    const portrayed = detail?.characters?.find(character => character.characterId === portrayedId)?.canonicalName;
    label.textContent = portrayed ? `Narrador · interpreta ${portrayed}` : segment.type === 'fala' ? 'Narrador · diálogo' : 'Narrador';
  });
}

function adaptAudio() {
  const panel = findPanelByTitle('Geração e revisão de áudio');
  if (!panel) return;
  const description = panel.querySelector('.panel-title p');
  if (description) description.textContent = 'Todos os trechos utilizam a voz escolhida para o narrador; somente a direção interpretativa muda entre os segmentos.';
  addNote(panel, 'audio', 'Continuidade vocal protegida', 'O TTS recebe sempre a voz do narrador. Emoção, intensidade, ritmo e pausas continuam específicos para cada trecho.');
}

function applyUi() {
  if (applyingUi) return;
  applyingUi = true;
  try {
    ensureStyles();
    if (!isAudiobook()) {
      document.querySelectorAll('.voxlibro-audiobook-hidden').forEach(element => element.classList.remove('voxlibro-audiobook-hidden'));
      return;
    }
    adaptCasting();
    adaptScript();
    adaptAudio();
  } finally {
    applyingUi = false;
  }
}

async function sync(force = false) {
  if (syncing) return;
  const projectId = activeProjectId();
  if (!projectId) return;
  const now = Date.now();
  if (!force && projectId === currentProjectId && now - lastSyncAt < 1800) {
    applyUi();
    return;
  }
  syncing = true;
  try {
    await enforce(projectId).catch(() => null);
    const response = await delegatedFetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: 'no-store' });
    if (response.ok) {
      detail = await response.json().catch(() => null);
      currentProjectId = projectId;
      lastSyncAt = Date.now();
    }
    applyUi();
  } finally {
    syncing = false;
  }
}
function scheduleSync(delay = 120) {
  window.clearTimeout(scheduled);
  scheduled = window.setTimeout(() => void sync(), delay);
}
function install() {
  if (stateWindow.__voxlibroAudiobookNarrationInstalled) return;
  stateWindow.__voxlibroAudiobookNarrationInstalled = true;
  installFetchPolicy();
  ensureStyles();
  const observer = new MutationObserver(() => scheduleSync());
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'class'] });
  window.addEventListener('focus', () => void sync(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync(true); });
  window.addEventListener('storage', () => void sync(true));
  void sync(true);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
else install();
