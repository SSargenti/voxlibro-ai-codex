import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type CharacterAnalysisStorage = {
  projectsRoot: string;
  projectsDbFile: string;
};

export type CharacterAnalysisDependencies = {
  performMapReduceCharacterAnalysis: (
    projectId: string,
    forceFresh?: boolean,
    allowTechnicalAuthors?: boolean,
  ) => Promise<{ characters: any[]; sightings: any[]; mergeSuggestions: any[] }>;
};

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

type WorkUnit = {
  unitId: string;
  chapterId: string;
  chapterTitle: string;
  chapterOrder: number;
  unitOrder: number;
  text: string;
  textHash: string;
};

export type CharacterAnalysisJob = {
  version: 1;
  jobId: string;
  projectId: string;
  status: JobStatus;
  forceFresh: boolean;
  freshResetApplied: boolean;
  allowTechnicalAuthors: boolean;
  sourceHash: string;
  totalUnits: number;
  completedUnitIds: string[];
  currentUnitId?: string;
  currentChapterId?: string;
  progress: number;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: { code: string; message: string; retryable: boolean; at: string };
  summary?: { characters: number; sightings: number; mergeSuggestions: number };
};

const activeProjects = new Set<string>();
const MAX_UNIT_CHARS = 11_500;

function now() {
  return new Date().toISOString();
}

function sha256(value: string | Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeProjectId(value: string) {
  const clean = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean || clean !== value) throw new Error('ID de projeto inválido.');
  return clean;
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function atomicWriteJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function atomicCopyJson(sourcePath: string, targetPath: string, transform?: (value: any) => any) {
  if (!fs.existsSync(sourcePath)) return;
  const value = readJson<any>(sourcePath, null);
  atomicWriteJson(targetPath, transform ? transform(value) : value);
}

function projectDir(storage: CharacterAnalysisStorage, projectId: string) {
  return path.join(storage.projectsRoot, projectId);
}

function chaptersPath(storage: CharacterAnalysisStorage, projectId: string) {
  return path.join(projectDir(storage, projectId), 'normalized', 'chapters.json');
}

function bibleDir(storage: CharacterAnalysisStorage, projectId: string) {
  return path.join(projectDir(storage, projectId), 'narrative-bible');
}

function jobPath(storage: CharacterAnalysisStorage, projectId: string) {
  return path.join(bibleDir(storage, projectId), 'analysis-job.json');
}

function cachePath(storage: CharacterAnalysisStorage, projectId: string) {
  return path.join(bibleDir(storage, projectId), 'chunks-cache.json');
}

function readProjects(storage: CharacterAnalysisStorage) {
  const projects = readJson<any[]>(storage.projectsDbFile, []);
  return Array.isArray(projects) ? projects : [];
}

function writeProjects(storage: CharacterAnalysisStorage, projects: any[]) {
  atomicWriteJson(storage.projectsDbFile, projects);
}

function getProject(storage: CharacterAnalysisStorage, projectId: string) {
  return readProjects(storage).find(project => project.projectId === projectId);
}

function updateMainProject(storage: CharacterAnalysisStorage, projectId: string, patch: Record<string, any>) {
  const projects = readProjects(storage);
  const project = projects.find(item => item.projectId === projectId);
  if (!project) throw new Error('Projeto não encontrado.');
  Object.assign(project, patch, { updatedAt: now() });
  writeProjects(storage, projects);
  return project;
}

function splitLongBlock(block: string, limit = MAX_UNIT_CHARS) {
  const pieces: string[] = [];
  let remaining = block.trim();
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const candidates = [window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf('; '), window.lastIndexOf(' ')];
    const cut = Math.max(...candidates);
    const safeCut = cut >= Math.floor(limit * 0.55) ? cut + 1 : limit;
    pieces.push(remaining.slice(0, safeCut).trim());
    remaining = remaining.slice(safeCut).trim();
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}

export function splitCharacterAnalysisWorkUnits(chapters: any[]): WorkUnit[] {
  const units: WorkUnit[] = [];
  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex++) {
    const chapter = chapters[chapterIndex] || {};
    const chapterId = String(chapter.chapterId || `chapter_${chapterIndex + 1}`);
    const chapterTitle = String(chapter.title || `Capítulo ${chapterIndex + 1}`);
    const chapterOrder = Number(chapter.order || chapterIndex + 1);
    const text = String(chapter.translatedText || chapter.originalText || '').replace(/\r\n?/g, '\n').trim();
    if (!text) continue;

    const blocks = text.split(/\n\s*\n/g).map(value => value.trim()).filter(Boolean);
    const chapterUnits: string[] = [];
    let current = '';
    const flush = () => {
      if (current.trim()) chapterUnits.push(current.trim());
      current = '';
    };

    for (const block of blocks) {
      const pieces = block.length > MAX_UNIT_CHARS ? splitLongBlock(block) : [block];
      for (const piece of pieces) {
        const candidate = current ? `${current}\n\n${piece}` : piece;
        if (candidate.length > MAX_UNIT_CHARS && current) {
          flush();
          current = piece;
        } else {
          current = candidate;
        }
      }
    }
    flush();
    if (!chapterUnits.length) chapterUnits.push(text.slice(0, MAX_UNIT_CHARS));

    chapterUnits.forEach((unitText, index) => {
      const textHash = sha256(unitText);
      units.push({
        unitId: `bible_unit_${sha256(`${chapterId}|${index}|${textHash}`).slice(0, 20)}`,
        chapterId,
        chapterTitle,
        chapterOrder,
        unitOrder: index + 1,
        text: unitText,
        textHash,
      });
    });
  }
  return units;
}

function sourceHash(units: WorkUnit[]) {
  return sha256(units.map(unit => `${unit.chapterId}:${unit.textHash}`).join('|'));
}

function progressFor(job: CharacterAnalysisJob) {
  if (job.status === 'completed') return 100;
  if (!job.totalUnits) return 0;
  return Math.min(99, Math.round((job.completedUnitIds.length / job.totalUnits) * 100));
}

function persistJob(storage: CharacterAnalysisStorage, job: CharacterAnalysisJob) {
  job.progress = progressFor(job);
  job.updatedAt = now();
  atomicWriteJson(jobPath(storage, job.projectId), job);
  return job;
}

export function readCharacterAnalysisJob(storage: CharacterAnalysisStorage, projectIdInput: string) {
  const projectId = safeProjectId(projectIdInput);
  return readJson<CharacterAnalysisJob | null>(jobPath(storage, projectId), null);
}

function mergeCaches(storage: CharacterAnalysisStorage, sourceProjectId: string, targetProjectId: string) {
  const source = readJson<Record<string, any[]>>(cachePath(storage, sourceProjectId), {});
  const target = readJson<Record<string, any[]>>(cachePath(storage, targetProjectId), {});
  atomicWriteJson(cachePath(storage, targetProjectId), { ...target, ...source });
}

function removeStage(storage: CharacterAnalysisStorage, stageId: string) {
  const projects = readProjects(storage).filter(project => project.projectId !== stageId);
  writeProjects(storage, projects);
  fs.rmSync(projectDir(storage, stageId), { recursive: true, force: true });
}

function createStage(
  storage: CharacterAnalysisStorage,
  mainProject: any,
  stageId: string,
  chapters: any[],
  copyExistingBible: boolean,
) {
  removeStage(storage, stageId);
  const projects = readProjects(storage);
  projects.push({
    ...mainProject,
    projectId: stageId,
    name: `Processamento interno da Bíblia · ${mainProject.name || mainProject.projectId}`,
    status: 'analyzing_characters',
    internalTemporary: true,
    parentProjectId: mainProject.projectId,
    createdAt: now(),
    updatedAt: now(),
  });
  writeProjects(storage, projects);

  const dir = projectDir(storage, stageId);
  fs.mkdirSync(path.join(dir, 'normalized'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'narrative-bible'), { recursive: true });
  atomicWriteJson(path.join(dir, 'normalized', 'chapters.json'), chapters);
  atomicCopyJson(cachePath(storage, mainProject.projectId), cachePath(storage, stageId));

  if (copyExistingBible) {
    for (const file of ['characters.json', 'merge-suggestions.json']) {
      atomicCopyJson(path.join(bibleDir(storage, mainProject.projectId), file), path.join(bibleDir(storage, stageId), file));
    }
  }
}

function stageId(projectId: string, discriminator: string) {
  return `bible_stage_${sha256(`${projectId}|${discriminator}`).slice(0, 18)}`;
}

function normalizeProjectReferences(value: any, projectId: string): any {
  if (Array.isArray(value)) return value.map(item => normalizeProjectReferences(item, projectId));
  if (!value || typeof value !== 'object') return value;
  const next: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    next[key] = key === 'projectId' ? projectId : normalizeProjectReferences(item, projectId);
  }
  return next;
}

function publishConsolidatedBible(storage: CharacterAnalysisStorage, stageIdValue: string, projectId: string) {
  const sourceDir = bibleDir(storage, stageIdValue);
  const targetDir = bibleDir(storage, projectId);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of ['characters.json', 'sightings.json', 'merge-suggestions.json', 'chunks-cache.json']) {
    atomicCopyJson(path.join(sourceDir, file), path.join(targetDir, file), value => normalizeProjectReferences(value, projectId));
  }
  for (const file of ['sightings.json', 'merge-suggestions.json']) {
    atomicCopyJson(path.join(sourceDir, file), path.join(projectDir(storage, projectId), file), value => normalizeProjectReferences(value, projectId));
  }
}

function loadResult(storage: CharacterAnalysisStorage, projectId: string) {
  const dir = bibleDir(storage, projectId);
  return {
    project: getProject(storage, projectId),
    characters: readJson<any[]>(path.join(dir, 'characters.json'), []),
    sightings: readJson<any[]>(path.join(dir, 'sightings.json'), []),
    mergeSuggestions: readJson<any[]>(path.join(dir, 'merge-suggestions.json'), []),
  };
}

async function processJob(
  storage: CharacterAnalysisStorage,
  dependencies: CharacterAnalysisDependencies,
  projectId: string,
) {
  if (activeProjects.has(projectId)) return;
  activeProjects.add(projectId);
  let job = readCharacterAnalysisJob(storage, projectId);
  try {
    if (!job || ['completed', 'cancelled'].includes(job.status)) return;
    const mainProject = getProject(storage, projectId);
    if (!mainProject) throw new Error('Projeto não encontrado.');
    const chapters = readJson<any[]>(chaptersPath(storage, projectId), []);
    if (!chapters.length) throw new Error('Nenhum capítulo disponível para a Bíblia.');
    const units = splitCharacterAnalysisWorkUnits(chapters);
    if (!units.length) throw new Error('Nenhum texto utilizável foi encontrado para a Bíblia.');
    const currentSourceHash = sourceHash(units);

    if (job.sourceHash !== currentSourceHash) {
      job.sourceHash = currentSourceHash;
      job.totalUnits = units.length;
      job.completedUnitIds = [];
      job.freshResetApplied = false;
    }
    if (job.forceFresh && !job.freshResetApplied) {
      fs.rmSync(cachePath(storage, projectId), { force: true });
      job.completedUnitIds = [];
      job.freshResetApplied = true;
    }

    job.status = 'processing';
    job.startedAt ||= now();
    job.attempts += 1;
    job.lastError = undefined;
    persistJob(storage, job);
    updateMainProject(storage, projectId, { status: 'analyzing_characters', lastError: undefined });

    const completed = new Set(job.completedUnitIds);
    for (const unit of units) {
      job = readCharacterAnalysisJob(storage, projectId) || job;
      if (job.status === 'cancelled') return;
      if (completed.has(unit.unitId)) continue;

      job.currentUnitId = unit.unitId;
      job.currentChapterId = unit.chapterId;
      persistJob(storage, job);

      const unitStageId = stageId(projectId, unit.unitId);
      try {
        createStage(storage, mainProject, unitStageId, [{
          chapterId: unit.chapterId,
          order: unit.chapterOrder,
          title: unit.chapterTitle,
          originalText: unit.text,
          translatedText: unit.text,
        }], false);
        await dependencies.performMapReduceCharacterAnalysis(unitStageId, false, job.allowTechnicalAuthors);
        mergeCaches(storage, unitStageId, projectId);
        completed.add(unit.unitId);
        job.completedUnitIds = Array.from(completed);
        job.currentUnitId = undefined;
        job.currentChapterId = undefined;
        persistJob(storage, job);
      } finally {
        removeStage(storage, unitStageId);
      }
    }

    const consolidationId = stageId(projectId, `consolidate|${job.sourceHash}`);
    try {
      const stagedChapters = units.map((unit, index) => ({
        chapterId: unit.chapterId,
        order: index + 1,
        title: unit.chapterTitle,
        originalText: unit.text,
        translatedText: unit.text,
      }));
      createStage(storage, mainProject, consolidationId, stagedChapters, true);
      const result = await dependencies.performMapReduceCharacterAnalysis(consolidationId, false, job.allowTechnicalAuthors);
      publishConsolidatedBible(storage, consolidationId, projectId);

      job.status = 'completed';
      job.progress = 100;
      job.currentUnitId = undefined;
      job.currentChapterId = undefined;
      job.completedAt = now();
      job.summary = {
        characters: result.characters.length,
        sightings: result.sightings.length,
        mergeSuggestions: result.mergeSuggestions.length,
      };
      persistJob(storage, job);
      updateMainProject(storage, projectId, { status: 'awaiting_voice_approval', lastError: undefined });
    } finally {
      removeStage(storage, consolidationId);
    }
  } catch (error: any) {
    job = readCharacterAnalysisJob(storage, projectId) || job;
    if (job) {
      job.status = 'failed';
      job.currentUnitId = undefined;
      job.currentChapterId = undefined;
      job.lastError = {
        code: 'CHARACTER_ANALYSIS_INTERRUPTED',
        message: error?.message || String(error),
        retryable: true,
        at: now(),
      };
      persistJob(storage, job);
      try {
        updateMainProject(storage, projectId, { status: 'analyzing_characters', lastError: job.lastError });
      } catch {
        // O job permanece persistido mesmo se o registro do projeto estiver indisponível.
      }
    }
  } finally {
    activeProjects.delete(projectId);
  }
}

function launch(
  storage: CharacterAnalysisStorage,
  dependencies: CharacterAnalysisDependencies,
  projectId: string,
) {
  if (activeProjects.has(projectId)) return;
  setTimeout(() => void processJob(storage, dependencies, projectId), 0);
}

function publicStatus(storage: CharacterAnalysisStorage, job: CharacterAnalysisJob) {
  const payload: any = { job };
  if (job.status === 'completed') payload.result = loadResult(storage, job.projectId);
  return payload;
}

function newJob(projectId: string, units: WorkUnit[], forceFresh: boolean, allowTechnicalAuthors: boolean): CharacterAnalysisJob {
  const timestamp = now();
  return {
    version: 1,
    jobId: `character_job_${crypto.randomUUID()}`,
    projectId,
    status: 'queued',
    forceFresh,
    freshResetApplied: false,
    allowTechnicalAuthors,
    sourceHash: sourceHash(units),
    totalUnits: units.length,
    completedUnitIds: [],
    progress: 0,
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function registerCharacterAnalysisJobRoutes(
  app: Express,
  storageProvider: () => CharacterAnalysisStorage,
  dependencies: CharacterAnalysisDependencies,
) {
  app.post('/api/projects/:projectId/character-analysis/start', (req: Request, res: Response) => {
    try {
      const storage = storageProvider();
      const projectId = safeProjectId(req.params.projectId);
      const project = getProject(storage, projectId);
      if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Projeto não encontrado.' } });
      const chapters = readJson<any[]>(chaptersPath(storage, projectId), []);
      const units = splitCharacterAnalysisWorkUnits(chapters);
      if (!units.length) return res.status(409).json({ error: { code: 'CHARACTER_SOURCE_EMPTY', message: 'A obra não possui texto disponível para a Bíblia.' } });

      const forceFresh = req.body?.forceFresh === true;
      const allowTechnicalAuthors = req.body?.allowTechnicalAuthors ?? project.allowTechnicalAuthors ?? false;
      let job = readCharacterAnalysisJob(storage, projectId);
      const canResume = job && ['queued', 'processing', 'failed'].includes(job.status) && job.sourceHash === sourceHash(units) && !forceFresh;
      if (!canResume) {
        job = newJob(projectId, units, forceFresh, Boolean(allowTechnicalAuthors));
      } else {
        job!.status = 'queued';
        job!.allowTechnicalAuthors = Boolean(allowTechnicalAuthors);
        job!.lastError = undefined;
        job!.updatedAt = now();
      }
      persistJob(storage, job!);
      updateMainProject(storage, projectId, { status: 'analyzing_characters', lastError: undefined, allowTechnicalAuthors: Boolean(allowTechnicalAuthors) });
      launch(storage, dependencies, projectId);
      return res.status(202).json(publicStatus(storage, job!));
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'CHARACTER_ANALYSIS_START_FAILED', message: error?.message || 'Não foi possível iniciar a Bíblia.' } });
    }
  });

  app.get('/api/projects/:projectId/character-analysis/status', (req: Request, res: Response) => {
    try {
      const storage = storageProvider();
      const projectId = safeProjectId(req.params.projectId);
      const job = readCharacterAnalysisJob(storage, projectId);
      if (!job) return res.status(404).json({ error: { code: 'CHARACTER_ANALYSIS_JOB_NOT_FOUND', message: 'Nenhum processamento da Bíblia foi iniciado.' } });
      if (['queued', 'processing'].includes(job.status)) launch(storage, dependencies, projectId);
      res.setHeader('Cache-Control', 'no-store');
      return res.json(publicStatus(storage, job));
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'CHARACTER_ANALYSIS_STATUS_FAILED', message: error?.message || 'Não foi possível consultar a Bíblia.' } });
    }
  });

  app.post('/api/projects/:projectId/character-analysis/cancel', (req: Request, res: Response) => {
    try {
      const storage = storageProvider();
      const projectId = safeProjectId(req.params.projectId);
      const job = readCharacterAnalysisJob(storage, projectId);
      if (!job) return res.status(404).json({ error: { code: 'CHARACTER_ANALYSIS_JOB_NOT_FOUND', message: 'Nenhum processamento da Bíblia foi iniciado.' } });
      job.status = 'cancelled';
      job.currentUnitId = undefined;
      job.currentChapterId = undefined;
      persistJob(storage, job);
      return res.json(publicStatus(storage, job));
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'CHARACTER_ANALYSIS_CANCEL_FAILED', message: error?.message || 'Não foi possível cancelar a Bíblia.' } });
    }
  });

  setTimeout(() => {
    const storage = storageProvider();
    for (const project of readProjects(storage)) {
      if (project.internalTemporary) continue;
      const job = readCharacterAnalysisJob(storage, String(project.projectId || ''));
      if (job && ['queued', 'processing'].includes(job.status)) launch(storage, dependencies, job.projectId);
    }
  }, 0);
}

export function resetCharacterAnalysisRuntimeForTests() {
  activeProjects.clear();
}
