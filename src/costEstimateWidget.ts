type CostRange = { minUsd: number; maxUsd: number };

type EstimateResponse = {
  estimate: {
    pricingVersion: string;
    basis: {
      sourceWords: number;
      sourceCharacters: number;
      estimatedAudioMinutes: { min: number; max: number };
      translationLikely: boolean;
      languageUnknown: boolean;
    };
    textProcessing: {
      provider: string;
      total: CostRange;
      stages: Array<{ label: string; model: string; cost: CostRange }>;
    };
    voiceOptions: Array<{
      id: string;
      provider: string;
      label: string;
      cost: CostRange;
      totalWithText: CostRange;
      freeTierNote: string;
    }>;
    assumptions: string[];
  };
};

const money = (value: number) => {
  if (!Number.isFinite(value)) return '—';
  if (value > 0 && value < 0.01) return `US$ ${value.toFixed(4)}`;
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
};

const rangeLabel = (range: CostRange) => `${money(range.minUsd)}–${money(range.maxUsd)}`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function installStyles() {
  if (document.getElementById('voxlibro-cost-estimate-styles')) return;
  const style = document.createElement('style');
  style.id = 'voxlibro-cost-estimate-styles';
  style.textContent = `
    #cost-estimate-root { position: relative; z-index: 70; }
    .cost-estimate-dock { position: fixed; top: 86px; right: 22px; width: min(390px, calc(100vw - 32px)); max-height: calc(100vh - 108px); overflow: auto; border: 1px solid rgba(20,42,36,.16); border-radius: 18px; background: rgba(252,253,249,.97); box-shadow: 0 18px 55px rgba(18,39,32,.18); color: #142a24; font-family: inherit; backdrop-filter: blur(14px); }
    .cost-estimate-dock[hidden] { display: none !important; }
    .cost-estimate-dock.collapsed .cost-estimate-body { display: none; }
    .cost-estimate-head { display: flex; align-items: center; gap: 10px; padding: 14px 15px; border-bottom: 1px solid rgba(20,42,36,.10); position: sticky; top: 0; background: rgba(252,253,249,.98); z-index: 1; }
    .cost-estimate-head strong { flex: 1; font-size: 14px; }
    .cost-estimate-head small { display: block; color: #627169; font-size: 11px; font-weight: 500; margin-top: 2px; }
    .cost-estimate-head button { border: 0; border-radius: 10px; background: #edf1eb; color: #203b32; padding: 7px 9px; cursor: pointer; font-weight: 700; }
    .cost-estimate-body { padding: 14px 15px 16px; }
    .cost-estimate-summary { border-radius: 14px; padding: 13px; background: #18382f; color: white; margin-bottom: 12px; }
    .cost-estimate-summary span { display: block; color: #cbd8d1; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    .cost-estimate-summary strong { display: block; font-size: 22px; margin: 3px 0 2px; }
    .cost-estimate-summary small { color: #dbe5e0; line-height: 1.35; }
    .cost-estimate-section { margin-top: 13px; }
    .cost-estimate-section h4 { margin: 0 0 7px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #607068; }
    .cost-estimate-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid rgba(20,42,36,.08); }
    .cost-estimate-row:last-child { border-bottom: 0; }
    .cost-estimate-row strong { display: block; font-size: 12px; }
    .cost-estimate-row small { display: block; color: #708078; font-size: 10px; line-height: 1.3; margin-top: 2px; }
    .cost-estimate-value { font-size: 12px; font-weight: 800; white-space: nowrap; }
    .cost-estimate-note { margin: 11px 0 0; padding: 10px; border-radius: 12px; background: #f1f3ed; color: #596961; font-size: 10px; line-height: 1.45; }
    .cost-estimate-error { color: #8d2d2d; background: #fff0ee; border-radius: 12px; padding: 11px; font-size: 12px; line-height: 1.4; }
    .cost-estimate-loading { color: #5c6d64; font-size: 12px; padding: 6px 0; }
    @media (max-width: 820px) {
      .cost-estimate-dock { top: auto; bottom: 14px; right: 14px; max-height: min(68vh, 560px); }
    }
  `;
  document.head.appendChild(style);
}

function createDock() {
  const root = document.getElementById('cost-estimate-root') || document.body.appendChild(element('div'));
  root.id = 'cost-estimate-root';
  const dock = element('aside', 'cost-estimate-dock');
  dock.hidden = true;
  dock.setAttribute('aria-live', 'polite');

  const head = element('div', 'cost-estimate-head');
  const titleWrap = element('div');
  titleWrap.append(element('strong', '', 'Previsão de custo'), element('small', '', 'Calculada após a extração da obra'));
  const refresh = element('button', '', '↻');
  refresh.type = 'button';
  refresh.title = 'Recalcular';
  const collapse = element('button', '', '−');
  collapse.type = 'button';
  collapse.title = 'Recolher';
  head.append(titleWrap, refresh, collapse);

  const body = element('div', 'cost-estimate-body');
  dock.append(head, body);
  root.appendChild(dock);

  collapse.addEventListener('click', () => {
    dock.classList.toggle('collapsed');
    collapse.textContent = dock.classList.contains('collapsed') ? '+' : '−';
  });

  return { dock, body, refresh };
}

function isSourceWorkspaceVisible() {
  const workspace = document.querySelector('.workspace');
  const stageTitle = document.querySelector('.stage-top h1')?.textContent?.trim();
  return Boolean(workspace && stageTitle === 'Obra');
}

function renderEstimate(body: HTMLElement, response: EstimateResponse) {
  const estimate = response.estimate;
  body.replaceChildren();

  const economy = estimate.voiceOptions.find(option => option.id === 'gcp-wavenet') || estimate.voiceOptions[0];
  const summary = element('div', 'cost-estimate-summary');
  summary.append(
    element('span', '', 'Cenário econômico completo'),
    element('strong', '', economy ? rangeLabel(economy.totalWithText) : rangeLabel(estimate.textProcessing.total)),
    element('small', '', `${estimate.basis.sourceWords.toLocaleString('pt-BR')} palavras · ${estimate.basis.estimatedAudioMinutes.min}–${estimate.basis.estimatedAudioMinutes.max} min de áudio`),
  );
  body.appendChild(summary);

  const textSection = element('section', 'cost-estimate-section');
  textSection.appendChild(element('h4', '', 'OpenAI · processamento textual'));
  for (const stage of estimate.textProcessing.stages) {
    const row = element('div', 'cost-estimate-row');
    const description = element('div');
    description.append(element('strong', '', stage.label), element('small', '', stage.model));
    row.append(description, element('span', 'cost-estimate-value', rangeLabel(stage.cost)));
    textSection.appendChild(row);
  }
  const totalRow = element('div', 'cost-estimate-row');
  const totalDescription = element('div');
  totalDescription.append(element('strong', '', 'Total de texto'), element('small', '', 'Luna + Terra + Sol conforme complexidade'));
  totalRow.append(totalDescription, element('span', 'cost-estimate-value', rangeLabel(estimate.textProcessing.total)));
  textSection.appendChild(totalRow);
  body.appendChild(textSection);

  const voiceSection = element('section', 'cost-estimate-section');
  voiceSection.appendChild(element('h4', '', 'Síntese de voz · opções'));
  for (const option of estimate.voiceOptions) {
    const row = element('div', 'cost-estimate-row');
    const description = element('div');
    description.append(element('strong', '', option.label), element('small', '', `${option.provider} · total com texto ${rangeLabel(option.totalWithText)}`));
    row.append(description, element('span', 'cost-estimate-value', rangeLabel(option.cost)));
    row.title = option.freeTierNote;
    voiceSection.appendChild(row);
  }
  body.appendChild(voiceSection);

  const translationText = estimate.basis.translationLikely
    ? estimate.basis.languageUnknown ? 'Tradução considerada por segurança enquanto o idioma está automático.' : 'Tradução incluída na estimativa.'
    : 'Tradução não incluída para obra identificada em português ou com tradução desativada.';
  const note = element('p', 'cost-estimate-note');
  note.textContent = `${translationText} Valores em USD, preços de tabela em ${estimate.pricingVersion}. ${estimate.assumptions.slice(0, 3).join(' ')}`;
  body.appendChild(note);
}

function renderError(body: HTMLElement, message: string) {
  body.replaceChildren(element('div', 'cost-estimate-error', message));
}

function installProjectCostEstimateWidget() {
  installStyles();
  const { dock, body, refresh } = createDock();
  let activeProject = '';
  let wasVisible = false;
  let controller: AbortController | null = null;

  const load = async (force = false) => {
    const visible = isSourceWorkspaceVisible();
    const projectId = localStorage.getItem('voxlibro.project') || '';
    dock.hidden = !visible || !projectId;
    if (!visible || !projectId) {
      wasVisible = false;
      return;
    }

    const enteringStage = !wasVisible;
    wasVisible = true;
    if (!force && projectId === activeProject && !enteringStage && body.childElementCount > 0) return;
    activeProject = projectId;
    controller?.abort();
    controller = new AbortController();
    body.replaceChildren(element('div', 'cost-estimate-loading', 'Calculando a previsão por API…'));

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/cost-estimate`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || 'A previsão ficará disponível após a extração do texto.');
      renderEstimate(body, data as EstimateResponse);
    } catch (error: any) {
      if (error?.name !== 'AbortError') renderError(body, error?.message || 'Não foi possível calcular a previsão de custo.');
    }
  };

  refresh.addEventListener('click', () => void load(true));
  const observer = new MutationObserver(() => void load(false));
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener('focus', () => void load(false));
  void load(false);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installProjectCostEstimateWidget, { once: true });
} else {
  installProjectCostEstimateWidget();
}
