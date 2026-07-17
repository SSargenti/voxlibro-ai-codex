import { useEffect, useMemo, useState } from 'react';
import {
  AudioLines, BookOpen, Check, ChevronLeft, CircleDollarSign, Download, FileAudio,
  FileText, Gauge, KeyRound, Library, LoaderCircle, Mic2, MoreVertical, Play,
  Plus, RefreshCw, Save, Settings, Sparkles, Trash2, Upload, Users, WandSparkles,
} from 'lucide-react';

type Project = {
  projectId: string; name: string; status: string; productionMode: string; sourceLanguage: string;
  translationEnabled: boolean; wordCount?: number; durationSeconds?: number; estimatedCost?: number;
  createdAt: string; detectedTitle?: string; recommendedProductionMode?: string;
};
type Detail = { project: Project; chapters: any[]; characters: any[]; segments: any[]; logs: any[] };
type StepId = 'source' | 'translation' | 'bible' | 'casting' | 'script' | 'audio' | 'export';

const steps: { id: StepId; label: string; icon: any }[] = [
  { id: 'source', label: 'Obra', icon: FileText }, { id: 'translation', label: 'Tradução', icon: Sparkles },
  { id: 'bible', label: 'Bíblia', icon: BookOpen }, { id: 'casting', label: 'Elenco', icon: Users },
  { id: 'script', label: 'Roteiro', icon: WandSparkles }, { id: 'audio', label: 'Áudio', icon: AudioLines },
  { id: 'export', label: 'Exportar', icon: Download },
];

const voices = [
  ['gcp:pt-BR-Wavenet-A', 'WaveNet A · econômica'], ['gcp:pt-BR-Wavenet-B', 'WaveNet B · econômica'],
  ['gcp:pt-BR-Wavenet-C', 'WaveNet C · econômica'], ['gcp:pt-BR-Wavenet-D', 'WaveNet D · econômica'],
  ['gcp:pt-BR-Neural2-A', 'Neural2 A · natural'], ['gcp:pt-BR-Neural2-B', 'Neural2 B · natural'],
  ['gemini:Kore', 'Kore · Gemini Flash'], ['gemini:Puck', 'Puck · Gemini Flash'],
  ['gemini:Aoede', 'Aoede · Gemini Flash'], ['gemini:Charon', 'Charon · Gemini Flash'],
  ['gemini:Zephyr', 'Zephyr · Gemini Flash'], ['gemini:Fenrir', 'Fenrir · Gemini Flash'],
  ['gemini:Leda', 'Leda · Gemini Flash'], ['gemini:Orus', 'Orus · Gemini Flash'],
  ['gemini:Enceladus', 'Enceladus · Gemini Flash'], ['gemini:Sulafat', 'Sulafat · Gemini Flash'],
  ['gemini-pro:Kore', 'Kore · Gemini Pro premium'], ['gemini-pro:Puck', 'Puck · Gemini Pro premium'],
  ['gemini-pro:Aoede', 'Aoede · Gemini Pro premium'], ['gemini-pro:Charon', 'Charon · Gemini Pro premium'],
];

async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.error || data?.message || `HTTP ${response.status}`);
  return data;
}

const post = (url: string, body?: unknown) => api(url, {
  method: 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function finishQueuedJob(projectId: string, started: any) {
  let job = started?.job;
  if (!job) return started;
  for (let i = 0; i < 10000 && !['completed', 'failed', 'cancelled'].includes(job.status); i++) {
    const next = await post(`/api/projects/${projectId}/jobs/process-next`);
    job = next.job;
  }
  if (job.status !== 'completed') throw new Error(job?.lastError?.message || `Job encerrado com status ${job.status}`);
  return job;
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    created: 'Criado', awaiting_configuration: 'Revisar obra', translating: 'Traduzindo',
    analyzing_characters: 'Analisando', awaiting_voice_approval: 'Definir elenco', scripting: 'Criar roteiro',
    generating_audio: 'Gerando áudio', reviewing: 'Em revisão', completed: 'Concluído', failed: 'Atenção',
  };
  return labels[status] || status?.replaceAll('_', ' ') || 'Novo';
}

function isPortugueseLanguage(language?: string) {
  const normalized = (language || '').toLowerCase().trim();
  return normalized.startsWith('pt') || normalized.includes('portug') || normalized.includes('brazil');
}

function Button({ children, variant = 'primary', busy, ...props }: any) {
  return <button className={`button ${variant}`} disabled={busy || props.disabled} {...props}>
    {busy ? <LoaderCircle size={16} className="spin" /> : null}{children}
  </button>;
}

function Empty({ icon: Icon, title, text, action }: any) {
  return <div className="empty"><div className="empty-icon"><Icon size={24} /></div><h3>{title}</h3><p>{text}</p>{action}</div>;
}

export default function App() {
  const [view, setView] = useState<'projects' | 'workspace' | 'settings'>('projects');
  const [projects, setProjects] = useState<Project[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [step, setStep] = useState<StepId>('source');
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const loadProjects = async () => {
    try { setProjects((await api('/api/projects')).projects || []); }
    catch (e: any) { setNotice({ kind: 'error', text: e.message }); }
  };
  const loadDetail = async (id = detail?.project.projectId) => {
    if (!id) return;
    const data = await api(`/api/projects/${id}`);
    setDetail(data);
    localStorage.setItem('voxlibro.project', id);
  };
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = (await api('/api/projects')).projects || [];
        if (cancelled) return;
        setProjects(list);
        const savedId = localStorage.getItem('voxlibro.project');
        if (!savedId || !list.some((project: Project) => project.projectId === savedId)) return;
        const data = await api(`/api/projects/${savedId}`);
        if (cancelled) return;
        setDetail(data);
        const savedStep = localStorage.getItem(`voxlibro.step.${savedId}`) as StepId | null;
        setStep(savedStep && steps.some(item => item.id === savedStep) ? savedStep : 'source');
        setView('workspace');
      } catch (e: any) {
        if (!cancelled) setNotice({ kind: 'error', text: e.message });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const openProject = async (id: string) => {
    setBusy('open');
    try {
      const data = await api(`/api/projects/${id}`); setDetail(data); setView('workspace');
      localStorage.setItem('voxlibro.project', id);
      const saved = localStorage.getItem(`voxlibro.step.${id}`) as StepId | null;
      setStep(saved && steps.some(s => s.id === saved) ? saved : 'source');
    } catch (e: any) { setNotice({ kind: 'error', text: e.message }); }
    finally { setBusy(''); }
  };
  const changeStep = (id: StepId) => {
    setStep(id); if (detail) localStorage.setItem(`voxlibro.step.${detail.project.projectId}`, id);
  };
  const run = async (name: string, fn: () => Promise<any>, success: string) => {
    setBusy(name); setNotice(null);
    try { const result = await fn(); await loadDetail(); await loadProjects(); setNotice({ kind: 'ok', text: success }); return result; }
    catch (e: any) { setNotice({ kind: 'error', text: e.message }); return null; }
    finally { setBusy(''); }
  };
  const showProjects = () => { setView('projects'); void loadProjects(); };

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={showProjects}><span className="brand-mark"><AudioLines size={20}/></span><span>VOXLIBRO <b>AI</b></span></button>
      <nav><button className={view === 'projects' ? 'active' : ''} onClick={showProjects}><Library size={17}/>Projetos</button><button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}><Settings size={17}/>Configurações</button></nav>
      <div className="local-pill"><span/>Uso individual</div>
    </header>

    {notice && <div className={`toast ${notice.kind}`} onClick={() => setNotice(null)}>{notice.kind === 'ok' ? <Check size={16}/> : null}{notice.text}</div>}

    {view === 'projects' && <Projects projects={projects} openProject={openProject} onCreate={() => setCreateOpen(true)} onDelete={async (id: string) => {
      if (!confirm('Excluir este projeto e os arquivos gerados?')) return;
      await api(`/api/projects/${id}`, { method: 'DELETE' }); await loadProjects();
    }}/>} 
    {view === 'workspace' && detail && <Workspace detail={detail} step={step} changeStep={changeStep} run={run} busy={busy} refresh={loadDetail} goBack={showProjects} setDetail={setDetail}/>} 
    {view === 'settings' && <SettingsView notify={setNotice}/>} 
    {createOpen && <CreateProject close={() => setCreateOpen(false)} created={async id => { setCreateOpen(false); await loadProjects(); await openProject(id); }}/>} 
  </div>;
}

function Projects({ projects, openProject, onCreate, onDelete }: any) {
  return <main className="page"><section className="hero"><div><span className="eyebrow">ESTÚDIO DE AUDIONOVELAS</span><h1>Da obra ao áudio,<br/><em>com controle editorial.</em></h1><p>Importe, traduza, defina o elenco, revise o roteiro e gere somente o que aprovou.</p></div><Button onClick={onCreate}><Plus size={17}/>Nova produção</Button></section>
    <div className="section-heading"><div><h2>Suas produções</h2><p>{projects.length} {projects.length === 1 ? 'projeto' : 'projetos'} neste estúdio</p></div></div>
    {projects.length === 0 ? <Empty icon={BookOpen} title="Sua estante está vazia" text="Comece importando um PDF, DOCX, EPUB, TXT ou HTML." action={<Button onClick={onCreate}><Upload size={16}/>Importar primeira obra</Button>}/> : <div className="project-grid">{projects.map((p: Project) => <article className="project-card" key={p.projectId} onClick={() => openProject(p.projectId)}><div className="cover"><BookOpen size={30}/><span>{p.productionMode === 'audiodrama' ? 'DRAMA' : p.productionMode === 'technical' ? 'TÉCNICO' : 'LIVRO'}</span></div><div className="project-info"><div className="card-top"><span className="status-dot"/> {statusLabel(p.status)}<button aria-label="Excluir" onClick={e => { e.stopPropagation(); onDelete(p.projectId); }}><Trash2 size={15}/></button></div><h3>{p.name}</h3><p>{p.wordCount?.toLocaleString('pt-BR') || 0} palavras · {p.sourceLanguage || 'idioma automático'}</p><div className="progress"><i style={{ width: `${projectProgress(p.status)}%` }}/></div><small>{projectProgress(p.status)}% do fluxo</small></div></article>)}</div>}
  </main>;
}

function projectProgress(status: string) {
  const value: Record<string, number> = { created: 5, awaiting_configuration: 15, translating: 28, analyzing_characters: 42, awaiting_voice_approval: 56, scripting: 68, generating_audio: 82, reviewing: 92, completed: 100 };
  return value[status] || 8;
}

function CreateProject({ close, created }: any) {
  const [file, setFile] = useState<File | null>(null); const [name, setName] = useState('');
  const [mode, setMode] = useState('audiodrama'); const [translate, setTranslate] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async (e: any) => { e.preventDefault(); if (!file) return; setBusy(true); setError(''); try {
    const data = await post('/api/projects', { name: name || file.name.replace(/\.[^.]+$/, ''), ownerId: 'local-owner', productionMode: mode, sourceLanguage: 'auto', targetLanguage: 'pt-BR', translationEnabled: translate, copyrightDeclared: true });
    const fd = new FormData(); fd.append('file', file); await api(`/api/projects/${data.project.projectId}/upload`, { method: 'POST', body: fd }); await created(data.project.projectId);
  } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && close()}><form className="modal" onSubmit={submit}><div className="modal-head"><div><span className="eyebrow">NOVA PRODUÇÃO</span><h2>Importar uma obra</h2></div><button type="button" onClick={close}>×</button></div><label className={`dropzone ${file ? 'has-file' : ''}`}><input type="file" accept=".pdf,.docx,.epub,.txt,.html,.htm" onChange={e => { const f = e.target.files?.[0] || null; setFile(f); if (f && !name) setName(f.name.replace(/\.[^.]+$/, '')); }}/><Upload size={25}/><strong>{file ? file.name : 'Escolha ou arraste seu arquivo'}</strong><span>PDF, DOCX, EPUB, TXT ou HTML · até 50 MB</span></label><label>Nome da produção<input value={name} onChange={e => setName(e.target.value)} placeholder="Ex.: O último farol"/></label><div className="mode-grid">{[['audiodrama','Audionovela','Elenco e direção emocional'],['audiobook','Audiolivro','Narração fiel e contínua'],['technical','Técnico','Clareza para fórmulas e tabelas']].map(x => <button type="button" className={mode === x[0] ? 'selected' : ''} onClick={() => setMode(x[0])} key={x[0]}><strong>{x[1]}</strong><span>{x[2]}</span></button>)}</div><label className="check"><input type="checkbox" checked={translate} onChange={e => setTranslate(e.target.checked)}/><span>Traduzir para português do Brasil quando necessário</span></label><p className="legal">Ao importar, você declara possuir autorização para processar e narrar esta obra.</p>{error && <p className="form-error">{error}</p>}<div className="modal-actions"><Button type="button" variant="ghost" onClick={close}>Cancelar</Button><Button busy={busy} disabled={!file}><Upload size={16}/>Importar e analisar</Button></div></form></div>;
}

function Workspace({ detail, step, changeStep, run, busy, refresh, goBack, setDetail }: any) {
  const { project, chapters, characters, segments } = detail;
  return <div className="workspace"><aside className="workflow-nav"><button className="back" onClick={goBack}><ChevronLeft size={17}/>Projetos</button><div className="book-mini"><div><BookOpen size={20}/></div><span><strong>{project.name}</strong><small>{statusLabel(project.status)}</small></span></div><ol>{steps.map((item, index) => { const Icon = item.icon; return <li key={item.id}><button className={step === item.id ? 'active' : ''} onClick={() => changeStep(item.id)}><span>{index + 1}</span><Icon size={17}/>{item.label}</button></li>; })}</ol><div className="workflow-note"><Gauge size={18}/><span><strong>Estado preservado</strong><small>Você volta exatamente a esta etapa.</small></span></div></aside><main className="stage"><div className="stage-top"><div><span className="eyebrow">{statusLabel(project.status)}</span><h1>{steps.find(s => s.id === step)?.label}</h1></div><Button variant="quiet" onClick={refresh}><RefreshCw size={16}/>Atualizar</Button></div>
    {step === 'source' && <SourcePanel detail={detail} run={run} busy={busy} changeStep={changeStep}/>} 
    {step === 'translation' && <TranslationPanel project={project} chapters={chapters} run={run} busy={busy}/>} 
    {step === 'bible' && <BiblePanel characters={characters} run={run} project={project} busy={busy}/>} 
    {step === 'casting' && <CastingPanel detail={detail} setDetail={setDetail} run={run} busy={busy}/>} 
    {step === 'script' && <ScriptPanel detail={detail} setDetail={setDetail} run={run} busy={busy}/>} 
    {step === 'audio' && <AudioPanel detail={detail} run={run} busy={busy}/>} 
    {step === 'export' && <ExportPanel detail={detail} run={run} busy={busy}/>} 
  </main></div>;
}

function SourcePanel({ detail, run, busy, changeStep }: any) {
  const p = detail.project; const [title, setTitle] = useState(p.name); const [mode, setMode] = useState(p.productionMode); const [lang, setLang] = useState(p.sourceLanguage || 'auto');
  const configure = async () => {
    const result = await run('configure', () => post(`/api/projects/${p.projectId}/configure`, { userTitle: title, selectedProductionMode: mode, sourceLanguage: lang, translationEnabled: p.translationEnabled }), 'Configuração salva.');
    if (!result?.project) return;
    const nextStep: StepId = isPortugueseLanguage(result.project.sourceLanguage) || result.project.translationEnabled === false ? 'bible' : 'translation';
    changeStep(nextStep);
  };
  return <><div className="stats"><Stat label="Palavras" value={(p.wordCount || 0).toLocaleString('pt-BR')}/><Stat label="Capítulos" value={detail.chapters.length}/><Stat label="Modo sugerido" value={p.recommendedProductionMode || p.productionMode}/><Stat label="Idioma" value={p.sourceLanguage || 'auto'}/></div><section className="panel"><div className="panel-title"><div><h2>Confirmar leitura da obra</h2><p>A extração é preservada; as etapas seguintes usam esta configuração.</p></div><FileText size={21}/></div><div className="form-grid"><label>Título<input value={title} onChange={e => setTitle(e.target.value)}/></label><label>Formato<select value={mode} onChange={e => setMode(e.target.value)}><option value="audiodrama">Audionovela</option><option value="audiobook">Audiolivro</option><option value="technical">Técnico</option></select></label><label>Idioma de origem<input value={lang} onChange={e => setLang(e.target.value)} placeholder="auto, en, es, pt-BR"/></label></div><div className="panel-actions"><Button busy={busy === 'configure'} onClick={configure}><Save size={16}/>Salvar configuração</Button></div></section><ChapterList chapters={detail.chapters}/></>;
}

function TranslationPanel({ project, chapters, run, busy }: any) {
  const translated = chapters.filter((c: any) => c.status === 'translated').length;
  return <section className="panel"><div className="panel-title"><div><h2>Tradução editorial para pt-BR</h2><p>O texto original permanece intacto. Quando a obra já está em português, nenhuma cópia falsa é criada.</p></div><Sparkles size={21}/></div><div className="callout"><div><strong>{translated} de {chapters.length} capítulos traduzidos</strong><span>GPT-5.6 com esforço baixo · continuidade preservada entre lotes</span></div></div><div className="panel-actions"><Button busy={busy === 'translate'} disabled={!project.translationEnabled} onClick={() => run('translate', async () => { const started = await post(`/api/projects/${project.projectId}/translate`, { glossaryEntries: [] }); await finishQueuedJob(project.projectId, started); }, 'Tradução concluída.')}><Sparkles size={16}/>{project.translationEnabled ? 'Traduzir obra' : 'Tradução desativada'}</Button></div><ChapterList chapters={chapters}/></section>;
}

function BiblePanel({ characters, run, project, busy }: any) {
  return <><section className="panel"><div className="panel-title"><div><h2>Bíblia narrativa</h2><p>Identidade, aliases, função dramática e estilo de fala persistem por toda a produção.</p></div><BookOpen size={21}/></div><div className="panel-actions"><Button busy={busy === 'bible'} onClick={() => run('bible', () => post(`/api/projects/${project.projectId}/analyze-characters`, { forceFresh: false }), 'Bíblia narrativa atualizada.')}><WandSparkles size={16}/>{characters.length ? 'Reanalisar com continuidade' : 'Criar bíblia narrativa'}</Button></div></section>{characters.length ? <div className="character-grid">{characters.map((c: any) => <article className="character-card" key={c.characterId}><div className="avatar">{c.canonicalName?.slice(0,1)}</div><div><span className="role">{c.role}</span><h3>{c.canonicalName}</h3><p>{c.description || c.personality?.join(', ') || 'Descrição a confirmar'}</p><small>{c.aliases?.length ? `Também: ${c.aliases.join(', ')}` : 'Sem aliases'}</small></div></article>)}</div> : <Empty icon={Users} title="Bíblia ainda não criada" text="A análise editorial formará o elenco canônico antes do casting."/>}</>;
}

function CastingPanel({ detail, setDetail, run, busy }: any) {
  const [playing, setPlaying] = useState('');
  const update = (id: string, voice: string) => setDetail((d: Detail) => ({ ...d, characters: d.characters.map(c => c.characterId === id ? { ...c, voiceAssignmentId: voice, voiceAssignment: { providerId: voice.split(':')[0], voiceName: voice.split(':')[1] } } : c) }));
  const preview = async (id: string, voice: string, name: string) => { setPlaying(id); try { const d = await post('/api/tts-sample', { text: `Olá. Eu sou ${name}, e esta será a minha voz nesta história.`, voiceId: voice }); const audio = new Audio(`data:audio/wav;base64,${d.base64Audio}`); await audio.play(); } catch (e: any) { alert(e.message); } finally { setPlaying(''); } };
  return <section className="panel"><div className="panel-title"><div><h2>Elenco de vozes</h2><p>WaveNet prioriza economia; Gemini Flash prioriza interpretação. A voz fica vinculada ao personagem.</p></div><Mic2 size={21}/></div>{detail.characters.length === 0 ? <Empty icon={Users} title="Crie a bíblia primeiro" text="O casting depende dos personagens canônicos."/> : <div className="cast-list">{detail.characters.map((c: any) => { const selected = c.voiceAssignmentId || 'gcp:pt-BR-Wavenet-A'; return <div className="cast-row" key={c.characterId}><div className="avatar">{c.canonicalName?.slice(0,1)}</div><div className="cast-name"><strong>{c.canonicalName}</strong><span>{c.role} · {c.speechStyle?.pace || 'ritmo moderado'}</span></div><select value={selected} onChange={e => update(c.characterId, e.target.value)}>{voices.map(v => <option value={v[0]} key={v[0]}>{v[1]}</option>)}</select><button className="icon-button" onClick={() => preview(c.characterId, selected, c.canonicalName)}>{playing === c.characterId ? <LoaderCircle className="spin" size={18}/> : <Play size={18}/>}</button></div>; })}</div>}<div className="panel-actions"><Button busy={busy === 'voices'} disabled={!detail.characters.length} onClick={() => run('voices', () => post(`/api/projects/${detail.project.projectId}/voices`, { characters: detail.characters }), 'Elenco salvo. Alterações de voz invalidaram somente os trechos afetados.')}><Save size={16}/>Salvar elenco</Button></div></section>;
}

function ScriptPanel({ detail, setDetail, run, busy }: any) {
  const saveSegment = async (segment: any) => { await post(`/api/projects/${detail.project.projectId}/segments/${segment.segmentId}`, { spokenText: segment.spokenText, speakerId: segment.speakerId, direction: segment.direction }); await run('refresh-segment', async () => {}, 'Trecho salvo; o áudio anterior foi invalidado.'); };
  const edit = (id: string, value: string) => setDetail((d: Detail) => ({ ...d, segments: d.segments.map(s => s.segmentId === id ? { ...s, spokenText: value } : s) }));
  const castingReady = detail.characters.length > 0 && detail.characters.every((character: any) => character.voiceAssignmentId || character.voiceAssignment?.voiceName);
  return <><section className="panel"><div className="panel-title"><div><h2>Roteiro de locução</h2><p>Cada unidade mantém o texto-fonte, o locutor e a direção. Editar invalida apenas seu áudio.</p></div><WandSparkles size={21}/></div><div className="panel-actions"><Button busy={busy === 'script'} disabled={!castingReady} onClick={() => run('script', () => post(`/api/projects/${detail.project.projectId}/script`), 'Roteiro criado e validado contra a obra.')}><WandSparkles size={16}/>{!castingReady ? 'Conclua o elenco primeiro' : detail.segments.length ? 'Refazer roteiro' : 'Criar roteiro'}</Button></div></section>{detail.segments.length ? <div className="segments">{detail.segments.slice(0, 120).map((s: any, i: number) => <article className="segment" key={s.segmentId}><span className="segment-number">{i + 1}</span><div className="segment-main"><div className="segment-meta"><b>{detail.characters.find((c: any) => c.characterId === s.speakerId)?.canonicalName || 'Narrador'}</b><span>{s.type}</span><i className={s.status}>{s.status}</i></div><textarea value={s.spokenText || ''} onChange={e => edit(s.segmentId, e.target.value)}/><button onClick={() => saveSegment(s)}><Save size={14}/>Salvar trecho</button></div></article>)}</div> : <Empty icon={FileText} title="Roteiro ainda não gerado" text="Salve o elenco e gere unidades de locução revisáveis."/>}</>;
}

function AudioPanel({ detail, run, busy }: any) {
  const pending = detail.segments.filter((s: any) => s.status !== 'ready'); const ready = detail.segments.length - pending.length;
  const chars = pending.reduce((n: number, s: any) => n + (s.spokenText?.length || 0), 0);
  const [pricing, setPricing] = useState<any>(null);
  useEffect(() => { api('/api/pricing').then(setPricing).catch(() => {}); }, []);
  const estimatedUsd = useMemo(() => pending.reduce((total: number, segment: any) => {
    const count = segment.spokenText?.length || 0;
    const character = detail.characters.find((c: any) => c.characterId === segment.speakerId);
    const voice = character?.voiceAssignmentId || 'gcp:pt-BR-Wavenet-A';
    if (voice.startsWith('gcp:')) {
      const rate = voice.includes('Neural2')
        ? (pricing?.tts?.googleCloud?.neural2UsdPerMillionCharacters ?? 16)
        : (pricing?.tts?.googleCloud?.wavenetUsdPerMillionCharacters ?? 4);
      return total + count / 1_000_000 * rate;
    }
    const configured = voice.startsWith('gemini-pro:') ? pricing?.tts?.geminiPro : pricing?.tts?.geminiFlash;
    const tier = voice.startsWith('gemini-pro:')
      ? { input: configured?.inputUsdPerMillionTextTokens ?? 1, output: configured?.outputUsdPerMillionAudioTokens ?? 20 }
      : { input: configured?.inputUsdPerMillionTextTokens ?? .5, output: configured?.outputUsdPerMillionAudioTokens ?? 10 };
    const textTokens = count / 4;
    const seconds = count / 15;
    return total + textTokens / 1_000_000 * tier.input + (seconds * 25) / 1_000_000 * tier.output;
  }, 0), [pending, detail.characters, pricing]);
  const generateAll = async () => { if (!confirm(`Gerar ${pending.length} trechos (${chars.toLocaleString('pt-BR')} caracteres)? O provedor poderá cobrar pelo uso.`)) return; await run('audio-all', async () => { for (const segment of pending) await post(`/api/projects/${detail.project.projectId}/segments/${segment.segmentId}/tts`); }, 'Áudios pendentes gerados.'); };
  return <><div className="stats"><Stat label="Prontos" value={`${ready}/${detail.segments.length}`}/><Stat label="Pendentes" value={pending.length}/><Stat label="Caracteres a gerar" value={chars.toLocaleString('pt-BR')}/><Stat label="Estimativa" value={`US$ ${estimatedUsd.toFixed(2)}`}/></div><section className="panel"><div className="panel-title"><div><h2>Geração e revisão de áudio</h2><p>Antes de confirmar, veja o volume e o custo indicativo. Não existe voz do navegador nem sucesso simulado.</p></div><CircleDollarSign size={21}/></div><div className="cost-box"><div><span>ESTIMATIVA ANTES DE GERAR</span><strong>US$ {estimatedUsd.toFixed(2)} · {chars.toLocaleString('pt-BR')} caracteres</strong><small>Referência {pricing?.pricingAsOf || 'vigente'}; duração Gemini estimada em 15 caracteres/s. O faturamento do provedor prevalece.</small></div><Button busy={busy === 'audio-all'} disabled={!pending.length} onClick={generateAll}><AudioLines size={16}/>Gerar pendentes</Button></div></section><div className="audio-list">{detail.segments.map((s: any, i: number) => <div key={s.segmentId}><span>{String(i + 1).padStart(3,'0')}</span><div><strong>{s.spokenText?.slice(0, 90)}</strong><small>{s.status} · {s.durationMs ? `${Math.round(s.durationMs/1000)}s` : 'sem áudio'}</small></div>{s.audioPath ? <audio controls preload="none" src={s.audioPath}/> : <Button variant="quiet" busy={busy === s.segmentId} onClick={() => run(s.segmentId, () => post(`/api/projects/${detail.project.projectId}/segments/${s.segmentId}/tts`), 'Trecho gerado.')}><Play size={15}/>Gerar</Button>}</div>)}</div></>;
}

function ExportPanel({ detail, run, busy }: any) {
  const ready = detail.segments.filter((s: any) => s.status === 'ready').length; const complete = detail.segments.length > 0 && ready === detail.segments.length;
  const [exports, setExports] = useState<any[]>([]);
  const loadExports = () => api(`/api/projects/${detail.project.projectId}/exports`).then(d => setExports((d.jobs || []).filter((j: any) => j.status === 'completed').reverse())).catch(() => {});
  useEffect(() => { void loadExports(); }, [detail.project.projectId]);
  const exportIt = async (format: string) => { await run(`export-${format}`, () => post(`/api/projects/${detail.project.projectId}/export`, { format }), 'Exportação preparada. Use o botão de download.'); await loadExports(); };
  return <><section className="panel"><div className="panel-title"><div><h2>Pacote final</h2><p>O servidor valida cobertura, arquivos, duração e checksums antes de liberar a produção.</p></div><FileAudio size={21}/></div><div className={`readiness ${complete ? 'complete' : ''}`}><span>{complete ? <Check/> : <Gauge/>}</span><div><strong>{complete ? 'Produção pronta para exportar' : 'Produção ainda incompleta'}</strong><p>{ready} de {detail.segments.length} trechos possuem áudio validado.</p></div></div><div className="panel-actions"><Button variant="quiet" busy={busy === 'audit'} disabled={!detail.segments.length} onClick={() => run('audit', () => post(`/api/projects/${detail.project.projectId}/audit`), 'Auditoria editorial salva nos logs do projeto.')}><Sparkles size={16}/>Auditoria difícil sob demanda</Button></div><div className="export-grid"><button disabled={!complete || !!busy} onClick={() => exportIt('mp3_single')}><FileAudio/><strong>MP3 único</strong><span>Livro contínuo</span></button><button disabled={!complete || !!busy} onClick={() => exportIt('mp3_chapters')}><BookOpen/><strong>Por capítulos</strong><span>Faixas separadas</span></button><button disabled={!complete || !!busy} onClick={() => exportIt('zip_assets')}><Download/><strong>Pacote ZIP</strong><span>Áudio, roteiro e manifesto</span></button></div>{exports.map((job: any) => <a className="download-link" key={job.exportJobId} href={job.downloadUrl}><Download size={17}/>Baixar {job.format.replaceAll('_', ' ')}</a>)}</section></>;
}

function ChapterList({ chapters }: any) { return <div className="chapter-list">{chapters.map((c: any, i: number) => <div key={c.chapterId}><span>{String(i + 1).padStart(2,'0')}</span><div><strong>{c.title}</strong><small>{c.wordCount?.toLocaleString('pt-BR')} palavras</small></div><i>{c.status}</i></div>)}</div>; }
function Stat({ label, value }: any) { return <div className="stat"><span>{label}</span><strong>{value}</strong></div>; }

function SettingsView({ notify }: any) {
  const [status, setStatus] = useState<any>(null); const [keys, setKeys] = useState({ openai: '', gemini: '', gcp: '' }); const [busy, setBusy] = useState('');
  const load = () => api('/api/settings/credentials/status').then(setStatus).catch((e: any) => notify({ kind: 'error', text: e.message })); useEffect(() => { void load(); }, []);
  const save = async (provider: 'openai'|'gemini'|'gcp') => { setBusy(provider); try { const url = provider === 'gcp' ? 'google-cloud-tts' : provider; const body = provider === 'gcp' ? { method: 'apiKey', apiKey: keys.gcp, sessionOnly: true } : { apiKey: keys[provider], sessionOnly: true }; await api(`/api/settings/credentials/${url}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) }); setKeys(k => ({ ...k, [provider]: '' })); await load(); notify({ kind: 'ok', text: 'Credencial salva somente na memória desta sessão.' }); } catch (e: any) { notify({ kind: 'error', text: e.message }); } finally { setBusy(''); } };
  return <main className="page settings-page"><section className="hero compact"><div><span className="eyebrow">CONFIGURAÇÕES</span><h1>Provedores e <em>credenciais.</em></h1><p>Cada chave tem uma função única. Os campos nunca devolvem nem revelam o valor salvo.</p></div></section><div className="credential-stack"><Credential name="OpenAI" tag="TEXTO" description="Tradução, bíblia narrativa, continuidade e roteiro." configured={status?.openai?.configured} value={keys.openai} onChange={(v: string) => setKeys({...keys, openai:v})} onSave={() => save('openai')} busy={busy==='openai'} models="GPT-5.6 · esforço baixo, médio ou alto"/><Credential name="Gemini TTS" tag="VOZ EXPRESSIVA" description="Vozes interpretativas nos níveis Standard e Premium." configured={status?.gemini?.configured} value={keys.gemini} onChange={(v: string) => setKeys({...keys, gemini:v})} onSave={() => save('gemini')} busy={busy==='gemini'} models="Gemini 2.5 Flash TTS · Pro TTS"/><Credential name="Google Cloud TTS" tag="VOZ ECONÔMICA" description="WaveNet e Neural2 em português do Brasil." configured={status?.gcp?.configured} value={keys.gcp} onChange={(v: string) => setKeys({...keys, gcp:v})} onSave={() => save('gcp')} busy={busy==='gcp'} models="WaveNet · Neural2"/></div><div className="security-note"><KeyRound size={20}/><div><strong>Separação rígida</strong><p>O VoxLibro não reutiliza uma chave em outro provedor e não recorre à voz do navegador. Falhas são exibidas de forma explícita.</p></div></div></main>;
}

function Credential({ name, tag, description, configured, value, onChange, onSave, busy, models }: any) { return <section className="credential"><div className="provider-icon"><KeyRound/></div><div className="provider-copy"><span className="eyebrow">{tag}</span><h2>{name}</h2><p>{description}</p><small>{models}</small></div><div className="key-form"><span className={configured ? 'configured' : ''}>{configured ? '● Configurada' : '○ Não configurada'}</span><div><input type="password" autoComplete="off" value={value} onChange={e => onChange(e.target.value)} placeholder="Cole uma nova chave"/><Button busy={busy} disabled={!value} onClick={onSave}>Salvar na sessão</Button></div></div></section>; }
