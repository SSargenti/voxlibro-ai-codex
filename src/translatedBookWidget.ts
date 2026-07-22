type TranslationIssue = {
  severity: 'blocking' | 'warning' | 'info';
  code: string;
  chapterId?: string;
  message: string;
};

type TranslatedBookStatus = {
  projectId: string;
  title: string;
  ready: boolean;
  formats: string[];
  report: {
    exportReady: boolean;
    translationRequired: boolean;
    summary: {
      chapters: number;
      readyChapters: number;
      missingChapters: number;
      untranslatedCopyChapters: number;
      sourceUnits: number;
      translatedUnits: number;
      excludedUnits: number;
      chapterCoveragePercent: number;
      structuralAlignmentPercent: number;
      blockingIssues: number;
      warnings: number;
    };
    issues: TranslationIssue[];
  };
};

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function installStyles() {
  if (document.getElementById('voxlibro-translated-book-styles')) return;
  const style = document.createElement('style');
  style.id = 'voxlibro-translated-book-styles';
  style.textContent = `
    #translated-book-root { position: relative; z-index: 72; }
    .translated-book-dock { position: fixed; right: 22px; bottom: 22px; width: min(420px, calc(100vw - 32px)); max-height: min(72vh, 690px); overflow: auto; border: 1px solid rgba(20,42,36,.16); border-radius: 20px; background: rgba(252,253,249,.98); box-shadow: 0 22px 65px rgba(18,39,32,.22); color: #142a24; font-family: inherit; backdrop-filter: blur(16px); }
    .translated-book-dock[hidden] { display: none !important; }
    .translated-book-dock.collapsed .translated-book-body { display: none; }
    .translated-book-head { display: flex; align-items: center; gap: 10px; position: sticky; top: 0; z-index: 2; padding: 14px 15px; border-bottom: 1px solid rgba(20,42,36,.10); background: rgba(252,253,249,.98); }
    .translated-book-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 11px; background: #18382f; color: white; font-weight: 900; }
    .translated-book-title { flex: 1; min-width: 0; }
    .translated-book-title strong { display: block; font-size: 14px; }
    .translated-book-title small { display: block; margin-top: 2px; overflow: hidden; color: #66756d; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .translated-book-head button { border: 0; border-radius: 10px; background: #edf1eb; color: #203b32; padding: 7px 9px; cursor: pointer; font-weight: 800; }
    .translated-book-body { padding: 14px 15px 16px; }
    .translated-book-summary { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; padding: 13px; border-radius: 15px; background: #18382f; color: white; }
    .translated-book-summary.warning { background: #7a4f19; }
    .translated-book-summary strong { display: block; font-size: 14px; }
    .translated-book-summary span { display: block; margin-top: 3px; color: #d8e3de; font-size: 11px; line-height: 1.35; }
    .translated-book-percent { font-size: 24px; font-weight: 900; }
    .translated-book-progress { height: 6px; margin: 10px 0 2px; overflow: hidden; border-radius: 99px; background: #dce3de; }
    .translated-book-progress i { display: block; height: 100%; border-radius: inherit; background: #2d705b; }
    .translated-book-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 11px; }
    .translated-book-metric { padding: 9px; border: 1px solid rgba(20,42,36,.08); border-radius: 12px; background: #f5f7f2; }
    .translated-book-metric strong { display: block; font-size: 14px; }
    .translated-book-metric span { display: block; margin-top: 2px; color: #6b7972; font-size: 9px; line-height: 1.25; text-transform: uppercase; }
    .translated-book-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 13px; }
    .translated-book-actions button { border: 1px solid rgba(20,42,36,.12); border-radius: 11px; background: white; color: #18382f; padding: 10px 7px; cursor: pointer; font-size: 11px; font-weight: 800; }
    .translated-book-actions button.primary { grid-column: span 2; background: #18382f; color: white; }
    .translated-book-actions button:disabled { cursor: not-allowed; opacity: .45; }
    .translated-book-note { margin: 12px 0 0; padding: 10px 11px; border-radius: 12px; background: #eef3ef; color: #526159; font-size: 10px; line-height: 1.45; }
    .translated-book-issues { margin-top: 12px; }
    .translated-book-issues h4 { margin: 0 0 7px; color: #65736c; font-size: 10px; letter-spacing: .05em; text-transform: uppercase; }
    .translated-book-issue { padding: 8px 0; border-bottom: 1px solid rgba(20,42,36,.08); font-size: 10px; line-height: 1.4; }
    .translated-book-issue:last-child { border-bottom: 0; }
    .translated-book-issue.blocking { color: #8b2929; }
    .translated-book-issue.warning { color: #865615; }
    .translated-book-loading, .translated-book-error { padding: 12px; border-radius: 12px; font-size: 12px; line-height: 1.45; }
    .translated-book-loading { background: #f1f4ef; color: #58675f; }
    .translated-book-error { background: #fff0ee; color: #8d2d2d; }
    @media (max-width: 820px) {
      .translated-book-dock { right: 14px; bottom: 14px; max-height: 66vh; }
      .translated-book-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .translated-book-actions button.primary { grid-column: span 2; }
    }
  `;
  document.head.appendChild(style);
}

function createDock() {
  const root = document.getElementById('translated-book-root') || document.body.appendChild(node('div'));
  root.id = 'translated-book-root';
  const dock = node('aside', 'translated-book-dock');
  dock.hidden = true;
  dock.setAttribute('aria-live', 'polite');

  const head = node('div', 'translated-book-head');
  head.appendChild(node('div', 'translated-book-icon', 'PT'));
  const title = node('div', 'translated-book-title');
  title.append(node('strong', '', 'Livro traduzido'), node('small', '', 'Produto independente da geração de áudio'));
  const refresh = node('button', '', '↻');
  refresh.type = 'button';
  refresh.title = 'Reconstruir e verificar';
  const collapse = node('button', '', '−');
  collapse.type = 'button';
  collapse.title = 'Recolher';
  head.append(title, refresh, collapse);

  const body = node('div', 'translated-book-body');
  dock.append(head, body);
  root.appendChild(dock);

  collapse.addEventListener('click', () => {
    dock.classList.toggle('collapsed');
    collapse.textContent = dock.classList.contains('collapsed') ? '+' : '−';
  });
  return { dock, body, refresh, title };
}

function visibleStage() {
  const workspace = document.querySelector('.workspace');
  const title = document.querySelector('.stage-top h1')?.textContent?.trim();
  return Boolean(workspace && (title === 'Tradução' || title === 'Exportar'));
}

function download(projectId: string, format: string) {
  const anchor = document.createElement('a');
  anchor.href = `/api/projects/${encodeURIComponent(projectId)}/translated-book/download?format=${encodeURIComponent(format)}`;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function actionButton(label: string, projectId: string, format: string, enabled: boolean, primary = false) {
  const button = node('button', primary ? 'primary' : '', label);
  button.type = 'button';
  button.disabled = !enabled;
  button.addEventListener('click', () => download(projectId, format));
  return button;
}

function render(body: HTMLElement, status: TranslatedBookStatus) {
  const report = status.report;
  const summary = report.summary;
  body.replaceChildren();

  const summaryBox = node('div', `translated-book-summary${status.ready ? '' : ' warning'}`);
  const message = node('div');
  message.append(
    node('strong', '', status.ready ? 'Tradução integral pronta' : 'Tradução ainda incompleta'),
    node('span', '', status.ready
      ? `${summary.readyChapters} capítulos validados e disponíveis para leitura ou TTS.`
      : `${summary.blockingIssues} pendência(s) bloqueante(s). O relatório continua disponível para diagnóstico.`),
  );
  summaryBox.append(message, node('div', 'translated-book-percent', `${summary.chapterCoveragePercent}%`));
  body.appendChild(summaryBox);

  const progress = node('div', 'translated-book-progress');
  const bar = node('i');
  bar.style.width = `${Math.max(0, Math.min(100, summary.chapterCoveragePercent))}%`;
  progress.appendChild(bar);
  body.appendChild(progress);

  const metrics = node('div', 'translated-book-metrics');
  for (const [value, label] of [
    [`${summary.readyChapters}/${summary.chapters}`, 'capítulos prontos'],
    [`${summary.structuralAlignmentPercent}%`, 'alinhamento estrutural'],
    [String(summary.warnings), 'avisos para revisão'],
  ]) {
    const metric = node('div', 'translated-book-metric');
    metric.append(node('strong', '', value), node('span', '', label));
    metrics.appendChild(metric);
  }
  body.appendChild(metrics);

  const actions = node('div', 'translated-book-actions');
  actions.append(
    actionButton('DOCX para leitura', status.projectId, 'docx', status.ready, true),
    actionButton('TXT integral', status.projectId, 'txt', status.ready),
    actionButton('TXT para TTS', status.projectId, 'tts', status.ready),
    actionButton('JSON canônico', status.projectId, 'json', true),
    actionButton('Relatório', status.projectId, 'report', true),
    actionButton('Pacote completo', status.projectId, 'zip', status.ready),
  );
  body.appendChild(actions);

  body.appendChild(node('p', 'translated-book-note', 'O livro traduzido é preservado como produto próprio. A Bíblia, o roteiro e o áudio usam esta mesma fonte validada, sem substituir o texto integral por uma adaptação de TTS.'));

  const visibleIssues = report.issues.filter(issue => issue.severity !== 'info').slice(0, 6);
  if (visibleIssues.length) {
    const issues = node('section', 'translated-book-issues');
    issues.appendChild(node('h4', '', 'Pontos de atenção'));
    for (const issue of visibleIssues) {
      issues.appendChild(node('div', `translated-book-issue ${issue.severity}`, issue.message));
    }
    body.appendChild(issues);
  }
}

function installTranslatedBookWidget() {
  installStyles();
  const { dock, body, refresh, title } = createDock();
  let activeProject = '';
  let wasVisible = false;
  let controller: AbortController | null = null;
  let refreshTimer = 0;

  const load = async (force = false) => {
    const visible = visibleStage();
    const projectId = localStorage.getItem('voxlibro.project') || '';
    dock.hidden = !visible || !projectId;
    if (!visible || !projectId) {
      wasVisible = false;
      window.clearTimeout(refreshTimer);
      return;
    }

    const enteringStage = !wasVisible;
    wasVisible = true;
    if (!force && activeProject === projectId && !enteringStage && body.childElementCount > 0) return;
    activeProject = projectId;
    controller?.abort();
    controller = new AbortController();
    body.replaceChildren(node('div', 'translated-book-loading', 'Verificando cobertura e reconstruindo os arquivos derivados…'));

    try {
      const method = force ? 'POST' : 'GET';
      const suffix = force ? 'rebuild' : 'status';
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/translated-book/${suffix}`, {
        method,
        cache: 'no-store',
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || 'O livro traduzido ficará disponível após a extração e a tradução.');
      title.querySelector('small')!.textContent = data.title || 'Produto independente da geração de áudio';
      render(body, data as TranslatedBookStatus);
      window.clearTimeout(refreshTimer);
      if (!data.ready) refreshTimer = window.setTimeout(() => void load(true), 10_000);
    } catch (error: any) {
      if (error?.name === 'AbortError') return;
      body.replaceChildren(node('div', 'translated-book-error', error?.message || 'Não foi possível preparar o livro traduzido.'));
    }
  };

  refresh.addEventListener('click', () => void load(true));
  const observer = new MutationObserver(() => void load(false));
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener('focus', () => void load(false));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void load(false); });
  void load(false);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installTranslatedBookWidget, { once: true });
} else {
  installTranslatedBookWidget();
}
