import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type TranslationJobStorage = { projectsRoot: string; projectsDbFile: string };
export type TranslationChunkRequest = {
  projectId: string;
  jobId: string;
  unitId: string;
  chapterId: string;
  chapterTitle: string;
  chunkIndex: number;
  totalChunks: number;
  text: string;
  contextBefore?: string;
  contextAfter?: string;
  style: string;
  glossaryEntries: any[];
};
export type TranslationJobDependencies = {
  translateChunk: (request: TranslationChunkRequest) => Promise<{ translatedText: string }>;
  legacyCompletedChunks?: (projectId: string) => Array<{ chapterId: string; chunkIndex: number; inputHash: string; translatedText: string }>;
  hasTextAi?: () => boolean;
};

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
type UnitStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
type TranslationError = { code: string; message: string; retryable: boolean; unitId?: string; chapterId?: string; attempt?: number; at: string };
type TranslationUnit = {
  unitId: string;
  chapterId: string;
  chapterTitle: string;
  chapterOrder: number;
  chunkIndex: number;
  totalChunks: number;
  inputHash: string;
  status: UnitStatus;
  attempts: number;
  resultPath?: string;
  lastError?: TranslationError;
};
export type TranslationGenerationJob = {
  version: 1;
  jobId: string;
  projectId: string;
  status: JobStatus;
  sourceHash: string;
  configurationHash: string;
  style: string;
  maxRetries: number;
  totalUnits: number;
  completedUnits: number;
  failedUnits: number;
  totalChapters: number;
  completedChapters: number;
  progress: number;
  units: TranslationUnit[];
  currentUnitId?: string;
  currentChapterId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: TranslationError;
};

const activeProjects = new Set<string>();
const TARGET_CHARS = 8_000;
const MAX_CHARS = 12_000;
const now = () => new Date().toISOString();
const sha256 = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');

function safeProjectId(value: string) {
  const clean = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean || clean !== value) throw new Error('ID de projeto inválido.');
  return clean;
}
function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}
function atomicWrite(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}
const projectDir = (storage: TranslationJobStorage, projectId: string) => path.join(storage.projectsRoot, projectId);
const chaptersPath = (storage: TranslationJobStorage, projectId: string) => path.join(projectDir(storage, projectId), 'normalized', 'chapters.json');
const translationDir = (storage: TranslationJobStorage, projectId: string) => path.join(projectDir(storage, projectId), 'translation');
const jobPath = (storage: TranslationJobStorage, projectId: string) => path.join(translationDir(storage, projectId), 'generation-job.json');
const chunkDir = (storage: TranslationJobStorage, projectId: string) => path.join(translationDir(storage, projectId), 'chunks');
export const readTranslationGenerationJob = (storage: TranslationJobStorage, projectId: string) => readJson<TranslationGenerationJob | null>(jobPath(storage, projectId), null);
function persist(storage: TranslationJobStorage, job: TranslationGenerationJob) { job.updatedAt = now(); atomicWrite(jobPath(storage, job.projectId), job); }

function splitText(text: string) {
  const chunks: string[] = [];
  let remaining = String(text || '').trim();
  while (remaining.length > MAX_CHARS) {
    const window = remaining.slice(0, MAX_CHARS + 1);
    const candidates = [window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf('; '), window.lastIndexOf(' ')];
    const cut = Math.max(...candidates);
    const safe = cut >= TARGET_CHARS ? cut + 1 : MAX_CHARS;
    chunks.push(remaining.slice(0, safe).trim());
    remaining = remaining.slice(safe).trim();
  }
  if (remaining || !chunks.length) chunks.push(remaining);
  return chunks.filter(Boolean);
}

function sourceHash(chapters: any[]) {
  return sha256(chapters.map(chapter => `${chapter.chapterId}:${sha256(String(chapter.originalText || ''))}`).join('|'));
}
function configHash(style: string, glossary: any[]) { return sha256(JSON.stringify({ style, glossary })); }
function resultPath(storage: TranslationJobStorage, projectId: string, unitId: string) { return path.join(chunkDir(storage, projectId), `${unitId}.json`); }
function resultRelative(unitId: string) { return `translation/chunks/${unitId}.json`; }

function createUnits(chapters: any[]) {
  const units: TranslationUnit[] = [];
  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex++) {
    const chapter = chapters[chapterIndex] || {};
    const chapterId = String(chapter.chapterId || `chapter_${chapterIndex + 1}`);
    const chunks = splitText(String(chapter.originalText || ''));
    chunks.forEach((text, chunkIndex) => {
      const inputHash = sha256(text);
      const unitId = `translation_${sha256(`${chapterId}|${chunkIndex}|${inputHash}`).slice(0, 20)}`;
      units.push({ unitId, chapterId, chapterTitle: String(chapter.title || `Capítulo ${chapterIndex + 1}`), chapterOrder: Number(chapter.order || chapterIndex + 1), chunkIndex, totalChunks: chunks.length, inputHash, status: 'queued', attempts: 0 });
    });
  }
  return units;
}

function updateCounts(job: TranslationGenerationJob) {
  job.totalUnits = job.units.length;
  job.completedUnits = job.units.filter(unit => unit.status === 'completed').length;
  job.failedUnits = job.units.filter(unit => unit.status === 'failed').length;
  const chapterIds = new Set(job.units.map(unit => unit.chapterId));
  job.totalChapters = chapterIds.size;
  job.completedChapters = [...chapterIds].filter(chapterId => job.units.filter(unit => unit.chapterId === chapterId).every(unit => unit.status === 'completed')).length;
  job.progress = job.totalUnits ? Math.round(job.completedUnits / job.totalUnits * 100) : 100;
}

function updateProject(storage: TranslationJobStorage, projectId: string, patch: Record<string, any>) {
  const projects = readJson<any[]>(storage.projectsDbFile, []);
  const project = projects.find(item => item.projectId === projectId);
  if (project) { Object.assign(project, patch, { updatedAt: now() }); atomicWrite(storage.projectsDbFile, projects); }
  return project;
}

function readChunkResult(storage: TranslationJobStorage, job: TranslationGenerationJob, unit: TranslationUnit) {
  const file = resultPath(storage, job.projectId, unit.unitId);
  const result = readJson<any>(file, null);
  return result?.inputHash === unit.inputHash && typeof result?.translatedText === 'string' && result.translatedText.trim() ? result : null;
}

function consolidateChapter(storage: TranslationJobStorage, job: TranslationGenerationJob, chapterId: string) {
  const chapterUnits = job.units.filter(unit => unit.chapterId === chapterId).sort((a, b) => a.chunkIndex - b.chunkIndex);
  if (!chapterUnits.length || chapterUnits.some(unit => unit.status !== 'completed')) return false;
  const results = chapterUnits.map(unit => readChunkResult(storage, job, unit));
  if (results.some(result => !result)) return false;
  const translatedText = results.map(result => result.translatedText.trim()).join('\n\n');
  const chapters = readJson<any[]>(chaptersPath(storage, job.projectId), []);
  const chapter = chapters.find(item => String(item.chapterId) === chapterId);
  if (!chapter) return false;
  chapter.translatedText = translatedText;
  chapter.status = 'translated';
  chapter.translationCompletedAt = now();
  atomicWrite(chaptersPath(storage, job.projectId), chapters);
  const outputDir = path.join(projectDir(storage, job.projectId), 'normalized', 'chapters');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, `${chapter.order}-${chapter.chapterId}.pt-BR.txt`), translatedText, 'utf8');
  return true;
}

function writeReport(storage: TranslationJobStorage, job: TranslationGenerationJob) {
  const chapters = readJson<any[]>(chaptersPath(storage, job.projectId), []);
  atomicWrite(path.join(translationDir(storage, job.projectId), 'report.json'), {
    version: 2,
    projectId: job.projectId,
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    totalChunks: job.totalUnits,
    completedChunks: job.completedUnits,
    failedChunks: job.failedUnits,
    totalChapters: job.totalChapters,
    completedChapters: job.completedChapters,
    chapters: chapters.map(chapter => ({ chapterId: chapter.chapterId, title: chapter.title, status: chapter.translatedText ? 'completed' : 'pending', characterCount: String(chapter.translatedText || '').length })),
    updatedAt: now(),
    lastError: job.lastError,
  });
}

function errorDetails(error: any, unit: TranslationUnit): TranslationError {
  const payload = error?.payload?.error || error?.error || {};
  const status = Number(error?.status || payload?.status || 0);
  const message = String(payload?.message || error?.message || 'Falha desconhecida ao traduzir o trecho.');
  const folded = message.toLowerCase();
  const billing = folded.includes('billing') || folded.includes('insufficient_quota') || folded.includes('credits_required');
  const retryable = typeof payload?.retryable === 'boolean' ? payload.retryable : !billing && (status === 0 || status === 408 || status === 429 || status >= 500 || /timeout|temporar|unavailable|rate limit|502|503|504/.test(folded));
  return { code: String(payload?.code || error?.code || (billing ? 'OPENAI_CREDITS_REQUIRED' : 'TRANSLATION_CHUNK_FAILED')), message, retryable, unitId: unit.unitId, chapterId: unit.chapterId, attempt: unit.attempts, at: now() };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function recoverExistingResults(storage: TranslationJobStorage, dependencies: TranslationJobDependencies, job: TranslationGenerationJob) {
  const legacy = dependencies.legacyCompletedChunks?.(job.projectId) || [];
  for (const unit of job.units) {
    const current = readChunkResult(storage, job, unit);
    const recovered = current || legacy.find(item => item.chapterId === unit.chapterId && item.chunkIndex === unit.chunkIndex && item.inputHash === unit.inputHash);
    if (!recovered?.translatedText?.trim()) continue;
    atomicWrite(resultPath(storage, job.projectId, unit.unitId), { unitId: unit.unitId, chapterId: unit.chapterId, chunkIndex: unit.chunkIndex, inputHash: unit.inputHash, translatedText: recovered.translatedText, completedAt: now(), recovered: !current });
    unit.status = 'completed'; unit.resultPath = resultRelative(unit.unitId); unit.lastError = undefined;
  }
  for (const chapterId of new Set(job.units.map(unit => unit.chapterId))) consolidateChapter(storage, job, chapterId);
  updateCounts(job);
}

async function processJob(storage: TranslationJobStorage, dependencies: TranslationJobDependencies, projectId: string) {
  if (activeProjects.has(projectId)) return;
  activeProjects.add(projectId);
  try {
    let job = readTranslationGenerationJob(storage, projectId);
    if (!job || !['queued', 'processing'].includes(job.status)) return;
    job.status = 'processing'; job.startedAt ||= now();
    for (const unit of job.units) if (unit.status === 'processing') unit.status = 'queued';
    updateCounts(job); persist(storage, job); writeReport(storage, job);

    while (true) {
      job = readTranslationGenerationJob(storage, projectId);
      if (!job || job.status === 'cancelled') return;
      const unit = job.units.find(item => item.status !== 'completed');
      if (!unit) {
        job.status = 'completed'; job.completedAt = now(); job.currentUnitId = undefined; job.currentChapterId = undefined; job.lastError = undefined;
        updateCounts(job); persist(storage, job); writeReport(storage, job);
        updateProject(storage, projectId, { status: 'analyzing_characters', lastError: undefined });
        return;
      }
      unit.status = 'processing'; unit.attempts = 0; unit.lastError = undefined;
      job.currentUnitId = unit.unitId; job.currentChapterId = unit.chapterId; job.lastError = undefined;
      persist(storage, job);
      const chapters = readJson<any[]>(chaptersPath(storage, projectId), []);
      const chapter = chapters.find(item => String(item.chapterId) === unit.chapterId);
      const chunks = splitText(String(chapter?.originalText || ''));
      const text = chunks[unit.chunkIndex] || '';
      const glossary = readJson<any[]>(path.join(translationDir(storage, projectId), 'glossary.json'), []);
      let success = false;
      for (let attempt = 1; attempt <= job.maxRetries + 1; attempt++) {
        const latest = readTranslationGenerationJob(storage, projectId);
        if (!latest || latest.status === 'cancelled') return;
        job = latest;
        const liveUnit = job.units.find(item => item.unitId === unit.unitId)!;
        liveUnit.status = 'processing'; liveUnit.attempts = attempt;
        persist(storage, job);
        try {
          const result = await dependencies.translateChunk({ projectId, jobId: job.jobId, unitId: unit.unitId, chapterId: unit.chapterId, chapterTitle: unit.chapterTitle, chunkIndex: unit.chunkIndex, totalChunks: unit.totalChunks, text, contextBefore: chunks[unit.chunkIndex - 1]?.slice(-1000), contextAfter: chunks[unit.chunkIndex + 1]?.slice(0, 1000), style: job.style, glossaryEntries: glossary });
          if (!result?.translatedText?.trim()) throw new Error('A tradução retornou vazia.');
          atomicWrite(resultPath(storage, projectId, unit.unitId), { unitId: unit.unitId, chapterId: unit.chapterId, chunkIndex: unit.chunkIndex, inputHash: unit.inputHash, translatedText: result.translatedText, completedAt: now() });
          const afterCall = readTranslationGenerationJob(storage, projectId);
          if (!afterCall) return;
          job = afterCall;
          const savedUnit = job.units.find(item => item.unitId === unit.unitId)!;
          savedUnit.status = 'completed'; savedUnit.resultPath = resultRelative(unit.unitId); savedUnit.lastError = undefined;
          job.lastError = undefined; success = true;
          consolidateChapter(storage, job, unit.chapterId);
          updateCounts(job); persist(storage, job); writeReport(storage, job);
          if (job.status === 'cancelled') return;
          break;
        } catch (error: any) {
          const detail = errorDetails(error, liveUnit);
          liveUnit.lastError = detail; job.lastError = detail; persist(storage, job); writeReport(storage, job);
          if (!detail.retryable || attempt > job.maxRetries) break;
          await wait(Math.min(10_000, 500 * 2 ** (attempt - 1)));
        }
      }
      if (!success) {
        job = readTranslationGenerationJob(storage, projectId)!;
        const failed = job.units.find(item => item.unitId === unit.unitId)!;
        failed.status = 'failed'; job.status = 'failed'; updateCounts(job); persist(storage, job); writeReport(storage, job);
        updateProject(storage, projectId, { status: 'translation_failed', lastError: job.lastError });
        return;
      }
    }
  } finally { activeProjects.delete(projectId); }
}

function launch(storage: TranslationJobStorage, dependencies: TranslationJobDependencies, projectId: string) {
  setTimeout(() => void processJob(storage, dependencies, projectId), 0);
}
function publicStatus(job: TranslationGenerationJob) { updateCounts(job); return { job }; }

export function registerTranslationGenerationJobRoutes(app: Express, storageProvider: () => TranslationJobStorage, dependencies: TranslationJobDependencies) {
  app.post('/api/projects/:projectId/translation/automated', (req: Request, res: Response) => {
    try {
      const storage = storageProvider(); const projectId = safeProjectId(req.params.projectId);
      if (dependencies.hasTextAi && !dependencies.hasTextAi()) return res.status(400).json({ error: { code: 'MISSING_API_KEY', message: 'OPENAI_API_KEY é necessária para tradução.' } });
      const chapters = readJson<any[]>(chaptersPath(storage, projectId), []);
      if (!chapters.length) return res.status(409).json({ error: { code: 'CHAPTERS_EMPTY', message: 'A obra não possui capítulos traduzíveis.' } });
      const projects = readJson<any[]>(storage.projectsDbFile, []); const project = projects.find(item => item.projectId === projectId);
      if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Projeto não encontrado.' } });
      if (project.translationEnabled === false) return res.status(409).json({ error: { code: 'TRANSLATION_DISABLED', message: 'A tradução está desativada.' } });
      const style = String(req.body?.style || 'literário');
      const glossary = readJson<any[]>(path.join(translationDir(storage, projectId), 'glossary.json'), []);
      const units = createUnits(chapters); const source = sourceHash(chapters); const configuration = configHash(style, glossary);
      let job = readTranslationGenerationJob(storage, projectId);
      const resumable = job && job.sourceHash === source && job.configurationHash === configuration && req.body?.forceFresh !== true;
      if (!resumable) {
        const timestamp = now();
        job = { version: 1, jobId: `translation_job_${crypto.randomUUID()}`, projectId, status: 'queued', sourceHash: source, configurationHash: configuration, style, maxRetries: Math.min(10, Math.max(0, Number(req.body?.maxRetries ?? process.env.VOXLIBRO_TRANSLATION_MAX_RETRIES ?? 3))), totalUnits: units.length, completedUnits: 0, failedUnits: 0, totalChapters: chapters.length, completedChapters: 0, progress: 0, units, createdAt: timestamp, updatedAt: timestamp };
        recoverExistingResults(storage, dependencies, job);
      } else if (job!.status !== 'completed') {
        job!.status = 'queued'; job!.lastError = undefined; job!.completedAt = undefined;
        for (const unit of job!.units) if (['failed', 'cancelled', 'processing'].includes(unit.status)) { unit.status = 'queued'; unit.lastError = undefined; }
      }
      updateCounts(job!); persist(storage, job!); writeReport(storage, job!);
      updateProject(storage, projectId, { status: job!.status === 'completed' ? 'analyzing_characters' : 'translating', lastError: undefined });
      if (job!.status !== 'completed') launch(storage, dependencies, projectId);
      return res.status(job!.status === 'completed' ? 200 : 202).json({ project, chapters, ...publicStatus(job!), glossaryEntries: glossary.length });
    } catch (error: any) { return res.status(400).json({ error: { code: 'AUTOMATED_TRANSLATION_START_FAILED', message: error?.message || 'Não foi possível iniciar a tradução.' } }); }
  });

  app.get('/api/projects/:projectId/translation/status', (req: Request, res: Response) => {
    const storage = storageProvider(); const projectId = safeProjectId(req.params.projectId); const job = readTranslationGenerationJob(storage, projectId);
    if (!job) return res.status(404).json({ error: { code: 'TRANSLATION_JOB_NOT_FOUND', message: 'Nenhuma tradução foi iniciada.' } });
    if (['queued', 'processing'].includes(job.status)) launch(storage, dependencies, projectId);
    res.setHeader('Cache-Control', 'no-store'); return res.json(publicStatus(job));
  });

  app.post('/api/projects/:projectId/translation/cancel', (req: Request, res: Response) => {
    const storage = storageProvider(); const projectId = safeProjectId(req.params.projectId); const job = readTranslationGenerationJob(storage, projectId);
    if (!job) return res.status(404).json({ error: { code: 'TRANSLATION_JOB_NOT_FOUND', message: 'Nenhuma tradução foi iniciada.' } });
    job.status = 'cancelled';
    for (const unit of job.units) if (['queued', 'processing', 'failed'].includes(unit.status)) unit.status = 'cancelled';
    updateCounts(job); persist(storage, job); writeReport(storage, job); updateProject(storage, projectId, { status: 'translation_cancelled' });
    return res.json(publicStatus(job));
  });

  setTimeout(() => {
    const storage = storageProvider(); const projects = readJson<any[]>(storage.projectsDbFile, []);
    for (const project of projects) {
      const projectId = String(project?.projectId || ''); const job = projectId ? readTranslationGenerationJob(storage, projectId) : null;
      if (job && ['queued', 'processing'].includes(job.status)) { for (const unit of job.units) if (unit.status === 'processing') unit.status = 'queued'; persist(storage, job); launch(storage, dependencies, projectId); }
    }
  }, 0);
}

export function resetTranslationGenerationRuntimeForTests() { activeProjects.clear(); }
