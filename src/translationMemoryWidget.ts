type GlossaryEntry = {
  glossaryId?: string;
  sourceTerm: string;
  preferredTranslation: string;
  notes?: string;
  locked: boolean;
  occurrences?: number;
};

type GlossarySuggestion = {
  sourceTerm: string;
  occurrences: number;
  reason: string;
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.error || data?.message || `HTTP ${response.status}`);
  return data;
}

function installStyles() {
  if (document.getElementById('voxlibro-translation-memory-styles')) return;
  const style = document.createElement('style');
  style.id = 'voxlibro-translation-memory-styles';
  style.textContent = `
    #translation-memory-root { position: relative; z-index: 71; }
    .translation-memory-dock { position: fixed; top: 86px; left: 270px; width: min(410px, calc(100vw - 32px)); max-height: calc(100vh - 108px); overflow: auto; border: 1px solid rgba(20,42,36,.16); border-radius: 20px; background: rgba(252,253,249,.98); box-shadow: 0 22px 65px rgba(18,39,32,.19); color: #142a24; font-family: inherit; backdrop-filter: blur(16px); }
    .translation-memory-dock[hidden] { display: none !important; }
    .translation-memory-dock.collapsed .translation-memory-body { display: none; }
    .translation-memory-head { display: flex; align-items: center; gap: 10px; position: sticky; top: 0; z-index: 2; padding: 14px 15px; border-bottom: 1px solid rgba(20,42,36,.10); background: rgba(252,253,249,.98); }
    .translation-memory-mark { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 11px; background: #dce9e2; color: #18382f; font-size: 12px; font-weight: 900; }
    .translation-memory-title { flex: 1; min-width: 0; }
    .translation-memory-title strong { display: block; font-size: 14px; }
    .translation-memory-title small { display: block; margin-top: 2px; color: #697870; font-size: 10px; }
    .translation-memory-head button { border: 0; border-radius: 10px; background: #edf1eb; color: #203b32; padding: 7px 9px; cursor: pointer; font-weight: 800; }
    .translation-memory-body { padding: 14px 15px 16px; }
    .translation-memory-intro { margin: 0 0 11px; color: #5b6a62; font-size: 11px; line-height: 1.45; }
    .translation-memory-toolbar { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 11px; }
    .translation-memory-toolbar button, .translation-memory-primary { border: 1px solid rgba(20,42,36,.13); border-radius: 10px; background: white; color: #18382f; padding: 8px 10px; cursor: pointer; font-size: 10px; font-weight: 800; }
    .translation-memory-toolbar button:disabled, .translation-memory-primary:disabled { cursor: not-allowed; opacity: .45; }
    .translation-memory-list { display: grid; gap: 8px; }
    .translation-memory-empty { padding: 14px; border-radius: 13px; background: #f1f4ef; color: #637169; font-size: 11px; line-height: 1.45; text-align: center; }
    .translation-memory-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 6px; align-items: center; padding: 8px; border: 1px solid rgba(20,42,36,.09); border-radius: 12px; background: #f8faf6; }
    .translation-memory-row input[type="text"] { min-width: 0; width: 100%; border: 1px solid rgba(20,42,36,.13); border-radius: 8px; background: white; color: #18382f; padding: 7px 8px; font: inherit; font-size: 10px; }
    .translation-memory-row label { display: grid; place-items: center; cursor: pointer; }
    .translation-memory-row button { border: 0; background: transparent; color: #8b3535; cursor: pointer; padding: 4px; font-size: 14px; }
    .translation-memory-row-meta { grid-column: 1 / -1; display: flex; justify-content: space-between; gap: 8px; color: #748179; font-size: 9px; }
    .translation-memory-actions { display: grid; grid-template-columns: 1fr 1.4fr; gap: 8px; margin-top: 12px; }
    .translation-memory-primary { background: #18382f; color: white; }
    .translation-memory-status { margin-top: 11px; padding: 10px 11px; border-radius: 12px; background: #edf3ef; color: #526159; font-size: 10px; line-height: 1.45; }
    .translation-memory-status.error { background: #fff0ee; color: #8d2d2d; }
    .translation-memory-status.warning { background: #fff5e8; color: #80531b; }
    .translation-memory-progress { height: 7px; margin-top: 8px; overflow: hidden; border-radius: 99px; background: #d7dfda; }
    .translation-memory-progress i { display: block; height: 100%; border-radius: inherit; background: #2e725c; transition: width .25s ease; }
    @media (max-width: 1080px) { .translation-memory-dock { left: 14px; top: 86px; } }
    @media (max-width: 820px) { .translation-memory-dock { top: 76px; left: 14px; max-height: 58vh; } }
  `;
  document.head.appendChild(style);
}

function createDock() {
  const root = document.getElementById('translation-memory-root') || document.body.appendChild(element('div'));
  root.id = 'translation-memory-root';
  const dock = element('aside', 'translation-memory-dock');
  dock.hidden = true;
  dock.setAttribute('aria-live', 'polite');

  const head = element('div', 'translation-memory-head');
  head.appendChild(element('div', 'translation-memory-mark', 'Aa'));
  const title = element('div', 'translation-memory-title');
  title.append(element('strong', '', 'Memória da tradução'), element('small', '', 'Nomes, locais e termos consistentes'));
  const collapse = element('button', '', '−');
  collapse.type = 'button';
  collapse.title = 'Recolher';
  head.append(title, collapse);

  const body = element('div', 'translation-memory-body');
  dock.append(head, body);
  root.appendChild(dock);
  collapse.addEventListener('click', () => {
    dock.classList.toggle('collapsed');
    collapse.textContent = dock.classList.contains('collapsed') ? '+' : '−';
  });
  return { dock, body };
}

function isTranslationStage() {
  return Boolean(document.querySelector('.workspace') && document.querySelector('.stage-top h1')?.textContent?.trim() === 'Tradução');
}

function clickWorkspaceRefresh() {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.stage-top button'));
  buttons.find(button => button.textContent?.includes('Atualizar'))?.click();
  document.querySelector<HTMLButtonElement>('#translated-book-root .translated-book-head button')?.click();
}

function installTranslationMemoryWidget() {
  installStyles();
  const { dock, body } = createDock();
  let activeProject = '';
  let wasVisible = false;
  let entries: GlossaryEntry[] = [];
  let busy = false;
  let statusText = '';
  let statusKind: 'normal' | 'warning' | 'error' = 'normal';
  let progress = 0;

  const projectId = () => localStorage.getItem('voxlibro.project') || '';

  const setStatus = (text: string, kind: 'normal' | 'warning' | 'error' = 'normal', nextProgress = progress) => {
    statusText = text;
    statusKind = kind;
    progress = nextProgress;
    render();
  };

  const save = async () => {
    const id = projectId();
    if (!id) return;
    const result = await api(`/api/projects/${encodeURIComponent(id)}/translation/glossary`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
    entries = result.entries || [];
  };

  const load = async (force = false) => {
    const visible = isTranslationStage();
    const id = projectId();
    dock.hidden = !visible || !id;
    if (!visible || !id) {
      wasVisible = false;
      return;
    }
    const entering = !wasVisible;
    wasVisible = true;
    if (!force && activeProject === id && !entering && entries.length >= 0 && body.childElementCount > 0) return;
    activeProject = id;
    try {
      const result = await api(`/api/projects/${encodeURIComponent(id)}/translation/glossary`, { cache: 'no-store' });
      entries = result.entries || [];
      statusText = entries.length ? `${entries.length} termo(s) persistente(s) carregado(s).` : 'Nenhum termo fixado. Sugira nomes recorrentes ou adicione manualmente.';
      statusKind = 'normal';
      render();
    } catch (error: any) {
      setStatus(error?.message || 'Não foi possível carregar a memória da tradução.', 'error');
    }
  };

  const suggest = async () => {
    const id = projectId();
    if (!id) return;
    busy = true;
    render();
    try {
      const result = await api(`/api/projects/${encodeURIComponent(id)}/translation/glossary/suggest`, { method: 'POST' });
      const suggestions = (result.suggestions || []) as GlossarySuggestion[];
      const existing = new Set(entries.map(entry => entry.sourceTerm.toLocaleLowerCase('pt-BR')));
      for (const suggestion of suggestions) {
        if (existing.has(suggestion.sourceTerm.toLocaleLowerCase('pt-BR'))) continue;
        entries.push({
          sourceTerm: suggestion.sourceTerm,
          preferredTranslation: suggestion.sourceTerm,
          locked: true,
          occurrences: suggestion.occurrences,
        });
        existing.add(suggestion.sourceTerm.toLocaleLowerCase('pt-BR'));
      }
      await save();
      setStatus(suggestions.length
        ? `${suggestions.length} nome(s) ou termo(s) recorrente(s) foram adicionados. Revise traduções que não devam permanecer iguais.`
        : 'Nenhum novo termo recorrente foi encontrado.', suggestions.length ? 'warning' : 'normal');
    } catch (error: any) {
      setStatus(error?.message || 'Não foi possível sugerir termos.', 'error');
    } finally {
      busy = false;
      render();
    }
  };

  const translate = async () => {
    const id = projectId();
    if (!id) return;
    busy = true;
    progress = 0;
    render();
    try {
      await save();
      const started = await api(`/api/projects/${encodeURIComponent(id)}/translation/automated`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style: 'literário' }),
      });
      let job = started.job;
      setStatus(`Tradução iniciada com ${started.glossaryEntries || 0} termo(s) de memória.`, 'normal', Number(job?.progress || 0));
      for (let iteration = 0; iteration < 10000 && job && !['completed', 'failed', 'cancelled'].includes(job.status); iteration++) {
        const next = await api(`/api/projects/${encodeURIComponent(id)}/jobs/process-next`, { method: 'POST' });
        job = next.job;
        setStatus(`Traduzindo a obra automaticamente… ${Number(job?.progress || 0)}%`, 'normal', Number(job?.progress || 0));
      }
      if (!job || job.status !== 'completed') throw new Error(job?.lastError?.message || `A tradução terminou com status ${job?.status || 'desconhecido'}.`);
      const audit = await api(`/api/projects/${encodeURIComponent(id)}/translation/glossary/audit`, { method: 'POST' });
      const issueCount = Number(audit?.report?.issues?.length || 0);
      setStatus(issueCount
        ? `Tradução concluída. A memória encontrou ${issueCount} capítulo(s) para revisão terminológica.`
        : 'Tradução integral concluída e memória terminológica consistente.', issueCount ? 'warning' : 'normal', 100);
      clickWorkspaceRefresh();
    } catch (error: any) {
      setStatus(error?.message || 'A tradução automatizada falhou.', 'error');
    } finally {
      busy = false;
      render();
    }
  };

  const render = () => {
    body.replaceChildren();
    body.appendChild(element('p', 'translation-memory-intro', 'Esta memória é enviada a todos os blocos da obra. O processamento continua sozinho e pode ser retomado sem perder traduções já concluídas.'));

    const toolbar = element('div', 'translation-memory-toolbar');
    const add = element('button', '', '+ Adicionar termo');
    add.type = 'button';
    add.disabled = busy;
    add.addEventListener('click', () => {
      entries.push({ sourceTerm: '', preferredTranslation: '', locked: true });
      render();
    });
    const suggestButton = element('button', '', 'Sugerir nomes');
    suggestButton.type = 'button';
    suggestButton.disabled = busy;
    suggestButton.addEventListener('click', () => void suggest());
    toolbar.append(add, suggestButton);
    body.appendChild(toolbar);

    const list = element('div', 'translation-memory-list');
    if (!entries.length) {
      list.appendChild(element('div', 'translation-memory-empty', 'O glossário ainda está vazio. Nomes próprios recorrentes podem ser detectados automaticamente.'));
    } else {
      entries.forEach((entry, index) => {
        const row = element('div', 'translation-memory-row');
        const source = element('input') as HTMLInputElement;
        source.type = 'text';
        source.placeholder = 'Termo original';
        source.value = entry.sourceTerm;
        source.disabled = busy;
        source.addEventListener('input', () => { entries[index].sourceTerm = source.value; });
        const translated = element('input') as HTMLInputElement;
        translated.type = 'text';
        translated.placeholder = 'Forma preferida em pt-BR';
        translated.value = entry.preferredTranslation;
        translated.disabled = busy;
        translated.addEventListener('input', () => { entries[index].preferredTranslation = translated.value; });
        const lockLabel = element('label');
        lockLabel.title = 'Bloquear esta tradução';
        const locked = element('input') as HTMLInputElement;
        locked.type = 'checkbox';
        locked.checked = entry.locked !== false;
        locked.disabled = busy;
        locked.addEventListener('change', () => { entries[index].locked = locked.checked; });
        lockLabel.appendChild(locked);
        const remove = element('button', '', '×');
        remove.type = 'button';
        remove.title = 'Remover termo';
        remove.disabled = busy;
        remove.addEventListener('click', () => { entries.splice(index, 1); render(); });
        row.append(source, translated, lockLabel, remove);
        const meta = element('div', 'translation-memory-row-meta');
        meta.append(element('span', '', entry.occurrences ? `${entry.occurrences} ocorrência(s)` : 'Termo manual'), element('span', '', entry.locked !== false ? 'tradução bloqueada' : 'preferência flexível'));
        row.appendChild(meta);
        list.appendChild(row);
      });
    }
    body.appendChild(list);

    const actions = element('div', 'translation-memory-actions');
    const saveButton = element('button', '', 'Salvar memória');
    saveButton.type = 'button';
    saveButton.disabled = busy;
    saveButton.addEventListener('click', async () => {
      busy = true;
      render();
      try {
        await save();
        setStatus('Memória da tradução salva.', 'normal');
      } catch (error: any) {
        setStatus(error?.message || 'Não foi possível salvar a memória.', 'error');
      } finally {
        busy = false;
        render();
      }
    });
    const translateButton = element('button', 'translation-memory-primary', busy ? 'Processando…' : 'Traduzir obra com memória');
    translateButton.type = 'button';
    translateButton.disabled = busy || entries.some(entry => !entry.sourceTerm.trim() || !entry.preferredTranslation.trim());
    translateButton.addEventListener('click', () => void translate());
    actions.append(saveButton, translateButton);
    body.appendChild(actions);

    if (statusText) {
      const status = element('div', `translation-memory-status${statusKind === 'normal' ? '' : ` ${statusKind}`}`, statusText);
      if (progress > 0 || busy) {
        const track = element('div', 'translation-memory-progress');
        const fill = element('i');
        fill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
        track.appendChild(fill);
        status.appendChild(track);
      }
      body.appendChild(status);
    }
  };

  const observer = new MutationObserver(() => void load(false));
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener('focus', () => void load(false));
  void load(false);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installTranslationMemoryWidget, { once: true });
} else {
  installTranslationMemoryWidget();
}
