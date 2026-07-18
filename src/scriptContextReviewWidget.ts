type ReviewMode = 'pending_speakers' | 'final_audit';
type ReviewJob = {
  jobId: string;
  mode: ReviewMode;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  totalItems: number;
  completedWorkItemIds: string[];
  currentChapterId?: string;
  lastError?: { message?: string };
};
type Suggestion = {
  suggestionId: string;
  mode: ReviewMode;
  segmentId: string;
  category: string;
  current: { speakerId: string; spokenText: string; direction: any };
  suggested: { speakerId?: string; spokenText?: string; direction?: any };
  confidence: number;
  reason: string;
  evidence: string[];
  status: string;
};
type ReviewState = {
  project?: any;
  characters?: any[];
  suggestions?: Suggestion[];
  scriptReport?: any;
  finalReport?: any;
  jobs?: { pendingSpeakers?: ReviewJob | null; finalAudit?: ReviewJob | null };
};
type ReviewWindow = typeof window & { __voxlibroScriptContextReviewInstalled?: boolean };

const reviewWindow = window as ReviewWindow;
const nativeFetch = window.fetch.bind(window);
let panel: HTMLElement | null = null;
let activePoll: Promise<void> | null = null;
let lastProjectId = '';

function sleep(ms: number) { return new Promise(resolve => window.setTimeout(resolve, ms)); }
function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] || character));
}
function currentProjectId() { return localStorage.getItem('voxlibro.project') || ''; }
function scriptStageVisible() { return document.querySelector('.stage-top h1')?.textContent?.trim() === 'Roteiro'; }
function modeSlug(mode: ReviewMode) { return mode === 'pending_speakers' ? 'pending-speakers' : 'final-audit'; }
function modeLabel(mode: ReviewMode) { return mode === 'pending_speakers' ? 'Locutores pendentes' : 'Auditoria contextual final'; }
function categoryLabel(category: string) {
  const labels: Record<string, string> = {
    pending_speaker: 'Locutor pendente',
    speaker_continuity: 'Continuidade de locutor',
    narration_role: 'Narrador/personagem',
    alias_identity: 'Identidade ou alias',
    direction_consistency: 'Direção emocional',
    text_fidelity: 'Fidelidade textual',
    scene_continuity: 'Continuidade da cena',
  };
  return labels[category] || category;
}
function installStyles() {
  if (document.getElementById('voxlibro-script-review-styles')) return;
  const style = document.createElement('style');
  style.id = 'voxlibro-script-review-styles';
  style.textContent = `
    .script-review-panel { margin: 0 0 18px; padding: 20px; border: 1px solid rgba(20,42,36,.13); border-radius: 20px; background: linear-gradient(145deg, rgba(249,252,248,.98), rgba(239,247,243,.94)); box-shadow: 0 14px 42px rgba(24,56,47,.08); color: #17372f; }
    .script-review-panel[hidden] { display: none !important; }
    .script-review-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
    .script-review-head h2 { margin: 0; font-size: 20px; }
    .script-review-head p { margin: 5px 0 0; color: #67766f; font-size: 12px; line-height: 1.5; }
    .script-review-badge { padding: 6px 10px; border-radius: 99px; background: #dfeae5; font-size: 11px; font-weight: 800; white-space: nowrap; }
    .script-review-badge.pass { background: #d8eee4; color: #27634e; }
    .script-review-badge.review { background: #fff0c9; color: #72520b; }
    .script-review-badge.fail { background: #f9dddd; color: #8b3030; }
    .script-review-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 16px; }
    .script-review-stat { padding: 12px; border-radius: 14px; background: rgba(255,255,255,.72); }
    .script-review-stat small { display: block; color: #6b7972; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
    .script-review-stat strong { display: block; margin-top: 4px; font-size: 18px; }
    .script-review-actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 15px; }
    .script-review-actions button, .script-review-item button { border: 0; border-radius: 11px; padding: 9px 12px; background: #18382f; color: white; font: inherit; font-size: 11px; font-weight: 800; cursor: pointer; }
    .script-review-actions button.secondary, .script-review-item button.secondary { background: #e3ebe7; color: #29473e; }
    .script-review-actions button:disabled, .script-review-item button:disabled { opacity: .45; cursor: not-allowed; }
    .script-review-progress { margin-top: 14px; padding: 12px; border-radius: 14px; background: rgba(255,255,255,.76); }
    .script-review-progress[hidden] { display: none; }
    .script-review-progress header { display: flex; justify-content: space-between; gap: 12px; font-size: 11px; font-weight: 800; }
    .script-review-track { height: 7px; margin-top: 8px; overflow: hidden; border-radius: 99px; background: #d9e3de; }
    .script-review-track i { display: block; height: 100%; border-radius: inherit; background: #2c735c; transition: width .25s ease; }
    .script-review-progress p { margin: 7px 0 0; color: #6b7972; font-size: 10px; }
    .script-review-list { display: grid; gap: 10px; margin-top: 15px; }
    .script-review-item { padding: 14px; border: 1px solid rgba(24,56,47,.1); border-radius: 15px; background: rgba(255,255,255,.8); }
    .script-review-item header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .script-review-item header strong { font-size: 12px; }
    .script-review-confidence { font-size: 12px; font-weight: 900; color: #2b6b56; }
    .script-review-change { margin: 8px 0; color: #324b43; font-size: 11px; line-height: 1.45; }
    .script-review-item p { margin: 6px 0; color: #65756e; font-size: 11px; line-height: 1.45; }
    .script-review-evidence { color: #7a8781; font-size: 10px; }
    .script-review-item footer { display: flex; gap: 8px; margin-top: 10px; }
    .script-review-empty { margin: 14px 0 0; color: #687770; font-size: 11px; }
    @media (max-width: 760px) { .script-review-stats { grid-template-columns: repeat(2, 1fr); } .script-review-head { flex-direction: column; } }
  `;
  document.head.appendChild(style);
}
function ensurePanel() {
  installStyles();
  if (!panel) {
    panel = document.createElement('section');
    panel.className = 'script-review-panel';
    panel.hidden = true;
  }
  const stage = document.querySelector('.stage');
  const stageTop = stage?.querySelector('.stage-top');
  if (stage && stageTop && panel.parentElement !== stage) stageTop.insertAdjacentElement('afterend', panel);
}
async function api(url: string, init?: RequestInit) {
  const response = await nativeFetch(url, { ...init, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
  return data;
}
async function refreshWorkspace() {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.stage-top button'));
  buttons.find(button => button.textContent?.includes('Atualizar'))?.click();
}
function speakerName(id: string | undefined, characters: any[]) {
  if (!id) return '—';
  if (id === 'char_narrator') return 'Narrador';
  if (id === 'unresolved') return 'Pendente';
  return characters.find(character => character.characterId === id)?.canonicalName || id;
}
function suggestedChange(suggestion: Suggestion, characters: any[]) {
  const parts: string[] = [];
  if (suggestion.suggested.speakerId) parts.push(`${speakerName(suggestion.current.speakerId, characters)} → ${speakerName(suggestion.suggested.speakerId, characters)}`);
  if (suggestion.suggested.spokenText) parts.push('ajuste do texto falado');
  if (suggestion.suggested.direction) parts.push('ajuste da direção emocional');
  return parts.join(' · ') || 'revisão contextual';
}
function jobInProgress(state: ReviewState) {
  return [state.jobs?.pendingSpeakers, state.jobs?.finalAudit].find(job => job && ['queued', 'processing'].includes(job.status)) || null;
}
function render(state: ReviewState) {
  ensurePanel();
  if (!panel) return;
  const characters = state.characters || [];
  const pendingSuggestions = (state.suggestions || []).filter(suggestion => suggestion.status === 'pending').sort((a, b) => b.confidence - a.confidence);
  const unresolved = Number(state.scriptReport?.totalUnresolved || 0);
  const finalStatus = String(state.finalReport?.status || (unresolved ? 'FAIL' : '—'));
  const progressJob = jobInProgress(state);
  const progress = Number(progressJob?.progress || 0);
  const completed = progressJob?.completedWorkItemIds?.length || 0;
  panel.hidden = !scriptStageVisible();
  panel.innerHTML = `
    <div class="script-review-head">
      <div><h2>Revisão contextual do roteiro</h2><p>Reanalise somente locutores pendentes com Terra e execute uma auditoria editorial final com Sol. As alterações dependem de aprovação.</p></div>
      <span class="script-review-badge ${escapeHtml(finalStatus.toLowerCase())}">${escapeHtml(finalStatus)}</span>
    </div>
    <div class="script-review-stats">
      <div class="script-review-stat"><small>Locutores pendentes</small><strong>${unresolved}</strong></div>
      <div class="script-review-stat"><small>Sugestões abertas</small><strong>${pendingSuggestions.length}</strong></div>
      <div class="script-review-stat"><small>Aplicadas</small><strong>${Number(state.finalReport?.appliedSuggestions || 0)}</strong></div>
      <div class="script-review-stat"><small>Cobertura</small><strong>${Number(state.scriptReport?.coverage ?? 0)}%</strong></div>
    </div>
    <div class="script-review-actions">
      <button data-action="pending" ${!unresolved || progressJob ? 'disabled' : ''}>Reanalisar locutores pendentes</button>
      <button data-action="audit" ${!state.scriptReport || progressJob ? 'disabled' : ''}>Revisão final com contexto · Sol</button>
      <button class="secondary" data-action="apply-high" ${!pendingSuggestions.some(item => item.confidence >= .9) || progressJob ? 'disabled' : ''}>Aplicar sugestões ≥ 90%</button>
      <button class="secondary" data-action="refresh">Atualizar revisão</button>
    </div>
    <div class="script-review-progress" ${progressJob ? '' : 'hidden'}>
      <header><span>${progressJob ? escapeHtml(modeLabel(progressJob.mode)) : ''}</span><b>${progress}%</b></header>
      <div class="script-review-track"><i style="width:${progress}%"></i></div>
      <p>${progressJob ? `${completed} de ${progressJob.totalItems} item(ns) concluídos${progressJob.currentChapterId ? ` · capítulo ${escapeHtml(progressJob.currentChapterId)}` : ''}. O checkpoint sobrevive a reinicializações.` : ''}</p>
    </div>
    ${pendingSuggestions.length ? `<div class="script-review-list">${pendingSuggestions.slice(0, 40).map(suggestion => `
      <article class="script-review-item">
        <header><strong>${escapeHtml(categoryLabel(suggestion.category))} · ${escapeHtml(suggestion.segmentId)}</strong><span class="script-review-confidence">${Math.round(suggestion.confidence * 100)}%</span></header>
        <div class="script-review-change">${escapeHtml(suggestedChange(suggestion, characters))}</div>
        <p>${escapeHtml(suggestion.reason)}</p>
        ${suggestion.evidence?.length ? `<div class="script-review-evidence">Evidência: ${escapeHtml(suggestion.evidence.join(' · '))}</div>` : ''}
        <footer><button data-apply="${escapeHtml(suggestion.suggestionId)}">Aplicar</button><button class="secondary" data-reject="${escapeHtml(suggestion.suggestionId)}">Rejeitar</button></footer>
      </article>`).join('')}</div>` : '<p class="script-review-empty">Nenhuma sugestão aberta. A análise pode ser executada novamente após alterações no roteiro ou na Bíblia.</p>'}
  `;
  panel.querySelector<HTMLButtonElement>('[data-action="pending"]')?.addEventListener('click', () => void startReview('pending_speakers'));
  panel.querySelector<HTMLButtonElement>('[data-action="audit"]')?.addEventListener('click', () => void startReview('final_audit'));
  panel.querySelector<HTMLButtonElement>('[data-action="apply-high"]')?.addEventListener('click', () => void applyHigh());
  panel.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.addEventListener('click', () => void loadState());
  panel.querySelectorAll<HTMLButtonElement>('[data-apply]').forEach(button => button.addEventListener('click', () => void handleSuggestion(button.dataset.apply || '', 'apply')));
  panel.querySelectorAll<HTMLButtonElement>('[data-reject]').forEach(button => button.addEventListener('click', () => void handleSuggestion(button.dataset.reject || '', 'reject')));
}
async function loadState() {
  const projectId = currentProjectId();
  if (!projectId || !scriptStageVisible()) { if (panel) panel.hidden = true; return; }
  lastProjectId = projectId;
  try { render(await api(`/api/projects/${encodeURIComponent(projectId)}/script-review`)); }
  catch (error: any) {
    ensurePanel();
    if (panel) { panel.hidden = false; panel.innerHTML = `<div class="script-review-head"><div><h2>Revisão contextual do roteiro</h2><p>${escapeHtml(error.message)}</p></div></div>`; }
  }
}
async function poll(mode: ReviewMode) {
  const projectId = currentProjectId();
  if (!projectId) return;
  for (let attempt = 0; attempt < 43_200; attempt++) {
    try {
      const payload = await api(`/api/projects/${encodeURIComponent(projectId)}/script-review/${modeSlug(mode)}/status`);
      if (payload.result) render(payload.result); else await loadState();
      const job = payload.job as ReviewJob;
      if (job.status === 'completed') { await loadState(); return; }
      if (job.status === 'failed' || job.status === 'cancelled') throw new Error(job.lastError?.message || `Análise encerrada: ${job.status}`);
      await sleep(1200);
    } catch (error: any) {
      if (attempt > 180) throw error;
      await sleep(Math.min(5000, 1000 + attempt * 100));
    }
  }
}
async function startReview(mode: ReviewMode) {
  if (activePoll) return;
  const projectId = currentProjectId();
  if (!projectId) return;
  activePoll = (async () => {
    await api(`/api/projects/${encodeURIComponent(projectId)}/script-review/${modeSlug(mode)}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ forceFresh: false }) });
    await loadState();
    await poll(mode);
  })().catch(error => window.alert(error.message)).finally(() => { activePoll = null; void loadState(); });
  await activePoll;
}
async function handleSuggestion(suggestionId: string, action: 'apply' | 'reject') {
  const projectId = currentProjectId();
  if (!projectId || !suggestionId) return;
  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}/script-review/suggestions/${encodeURIComponent(suggestionId)}/${action}`, { method: 'POST' });
    await loadState();
    await refreshWorkspace();
  } catch (error: any) { window.alert(error.message); }
}
async function applyHigh() {
  const projectId = currentProjectId();
  if (!projectId) return;
  try {
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}/script-review/suggestions/apply-high-confidence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threshold: .9 }) });
    render(result.state);
    await refreshWorkspace();
    if (result.failed?.length) window.alert(`${result.failed.length} sugestão(ões) não puderam ser aplicadas porque o contexto mudou.`);
  } catch (error: any) { window.alert(error.message); }
}
function install() {
  if (reviewWindow.__voxlibroScriptContextReviewInstalled) return;
  reviewWindow.__voxlibroScriptContextReviewInstalled = true;
  ensurePanel();
  const observer = new MutationObserver(() => {
    ensurePanel();
    const projectId = currentProjectId();
    if (scriptStageVisible() && (projectId !== lastProjectId || panel?.hidden)) void loadState();
    else if (!scriptStageVisible() && panel) panel.hidden = true;
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener('focus', () => void loadState());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void loadState(); });
  void loadState();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
else install();
