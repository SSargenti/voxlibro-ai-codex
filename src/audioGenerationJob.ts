import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type AudioGenerationStorage = { projectsRoot: string; projectsDbFile: string };
export type AudioGenerationDependencies = {
  generateSegment: (projectId: string, segmentId: string) => Promise<any>;
};

type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
type JobError = { code: string; message: string; retryable: boolean; segmentId?: string; attempt?: number; at: string };

export type AudioGenerationJob = {
  version: 1;
  jobId: string;
  projectId: string;
  status: JobStatus;
  batchSize: number;
  maxRetries: number;
  totalSegments: number;
  completedSegments: number;
  failedSegments: number;
  pendingSegments: number;
  currentBatch: number;
  totalBatches: number;
  currentSegmentId?: string;
  currentSegmentOrder?: number;
  retryAttempt: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: JobError;
};

const activeProjects = new Set<string>();
const DEFAULT_BATCH_SIZE = 120;

const now = () => new Date().toISOString();
function safeProjectId(value: string) {
  const clean = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean || clean !== value) throw new Error('ID de projeto inválido.');
  return clean;
}
function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}
function atomicWriteJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}
const projectDir = (storage: AudioGenerationStorage, projectId: string) => path.join(storage.projectsRoot, projectId);
const segmentsPath = (storage: AudioGenerationStorage, projectId: string) => path.join(projectDir(storage, projectId), 'scripts', 'segments.json');
const jobPath = (storage: AudioGenerationStorage, projectId: string) => path.join(projectDir(storage, projectId), 'audio', 'generation-job.json');
export const readAudioGenerationJob = (storage: AudioGenerationStorage, projectId: string) => readJson<AudioGenerationJob | null>(jobPath(storage, projectId), null);
const persist = (storage: AudioGenerationStorage, job: AudioGenerationJob) => {
  job.updatedAt = now();
  atomicWriteJson(jobPath(storage, job.projectId), job);
};

function hasValidAudio(storage: AudioGenerationStorage, projectId: string, segment: any) {
  if (segment?.status !== 'ready' || !segment?.audioPath) return false;
  const fileName = path.basename(String(segment.audioPath));
  return fs.existsSync(path.join(projectDir(storage, projectId), 'audio', 'segments', fileName));
}

function refreshCounts(storage: AudioGenerationStorage, job: AudioGenerationJob, segments = readJson<any[]>(segmentsPath(storage, job.projectId), [])) {
  const completed = segments.filter(segment => hasValidAudio(storage, job.projectId, segment)).length;
  const failed = segments.filter(segment => segment?.status === 'failed').length;
  job.totalSegments = segments.length;
  job.completedSegments = completed;
  job.failedSegments = failed;
  job.pendingSegments = Math.max(0, segments.length - completed - failed);
  job.totalBatches = Math.max(1, Math.ceil(segments.length / job.batchSize));
  const currentOrder = Math.max(1, Number(job.currentSegmentOrder || completed + 1));
  job.currentBatch = Math.min(job.totalBatches, Math.ceil(currentOrder / job.batchSize));
  return segments;
}

function errorDetails(error: any, segmentId: string, attempt: number): JobError {
  const payload = error?.payload?.error || error?.error || {};
  const status = Number(error?.status || payload?.status || 0);
  const retryable = typeof payload?.retryable === 'boolean'
    ? payload.retryable
    : status === 408 || status === 429 || status >= 500 || status === 0;
  return {
    code: String(payload?.code || error?.code || 'TTS_GENERATION_FAILED'),
    message: String(payload?.message || error?.message || 'Falha desconhecida ao gerar o áudio.'),
    retryable,
    segmentId,
    attempt,
    at: now(),
  };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function processJob(storage: AudioGenerationStorage, dependencies: AudioGenerationDependencies, projectId: string) {
  if (activeProjects.has(projectId)) return;
  activeProjects.add(projectId);
  try {
    let job = readAudioGenerationJob(storage, projectId);
    if (!job || !['queued', 'processing'].includes(job.status)) return;
    job.status = 'processing';
    job.startedAt ||= now();
    persist(storage, job);

    while (true) {
      job = readAudioGenerationJob(storage, projectId);
      if (!job || job.status === 'cancelled') return;
      const segments = refreshCounts(storage, job);
      const next = segments.find(segment => !hasValidAudio(storage, projectId, segment));
      if (!next) {
        job.status = 'completed';
        job.completedAt = now();
        job.currentSegmentId = undefined;
        job.currentSegmentOrder = undefined;
        job.retryAttempt = 0;
        job.lastError = undefined;
        refreshCounts(storage, job, segments);
        persist(storage, job);
        return;
      }

      job.currentSegmentId = String(next.segmentId);
      job.currentSegmentOrder = Number(next.order || segments.indexOf(next) + 1);
      job.retryAttempt = 0;
      persist(storage, job); // checkpoint before the provider call

      let generated = false;
      for (let attempt = 1; attempt <= job.maxRetries + 1; attempt++) {
        const latest = readAudioGenerationJob(storage, projectId);
        if (!latest || latest.status === 'cancelled') return;
        job = latest;
        job.retryAttempt = attempt;
        persist(storage, job);
        try {
          await dependencies.generateSegment(projectId, String(next.segmentId));
          generated = true;
          job.lastError = undefined;
          job.retryAttempt = 0;
          refreshCounts(storage, job);
          persist(storage, job); // checkpoint after every completed segment
          break;
        } catch (error: any) {
          const detail = errorDetails(error, String(next.segmentId), attempt);
          job.lastError = detail;
          persist(storage, job);
          if (!detail.retryable || attempt > job.maxRetries) break;
          await wait(Math.min(5_000, 250 * 2 ** (attempt - 1)));
        }
      }

      if (!generated) {
        const currentSegments = readJson<any[]>(segmentsPath(storage, projectId), []);
        const failedSegment = currentSegments.find(segment => String(segment?.segmentId) === String(next.segmentId));
        if (failedSegment) {
          failedSegment.status = 'failed';
          failedSegment.lastError = job.lastError;
          atomicWriteJson(segmentsPath(storage, projectId), currentSegments);
        }
        job.status = 'failed';
        refreshCounts(storage, job);
        persist(storage, job);
        return;
      }
    }
  } finally {
    activeProjects.delete(projectId);
  }
}

function launch(storage: AudioGenerationStorage, dependencies: AudioGenerationDependencies, projectId: string) {
  setTimeout(() => void processJob(storage, dependencies, projectId), 0);
}

function publicStatus(storage: AudioGenerationStorage, job: AudioGenerationJob) {
  refreshCounts(storage, job);
  persist(storage, job);
  return { job };
}

export function registerAudioGenerationJobRoutes(app: Express, storageProvider: () => AudioGenerationStorage, dependencies: AudioGenerationDependencies) {
  app.post('/api/projects/:projectId/audio-generation/start', (req: Request, res: Response) => {
    try {
      const storage = storageProvider();
      const projectId = safeProjectId(req.params.projectId);
      const segments = readJson<any[]>(segmentsPath(storage, projectId), []);
      if (!segments.length) return res.status(409).json({ error: { code: 'AUDIO_SEGMENTS_EMPTY', message: 'O roteiro não possui segmentos para gerar.' } });
      const existing = readAudioGenerationJob(storage, projectId);
      const maxRetries = Math.min(10, Math.max(0, Number(req.body?.maxRetries ?? process.env.VOXLIBRO_AUDIO_MAX_RETRIES ?? 3)));
      const timestamp = now();
      const job: AudioGenerationJob = existing && ['failed', 'cancelled', 'queued', 'processing'].includes(existing.status)
        ? { ...existing, status: 'queued', maxRetries, lastError: undefined, completedAt: undefined, updatedAt: timestamp }
        : { version: 1, jobId: `audio_job_${crypto.randomUUID()}`, projectId, status: 'queued', batchSize: DEFAULT_BATCH_SIZE, maxRetries, totalSegments: segments.length, completedSegments: 0, failedSegments: 0, pendingSegments: segments.length, currentBatch: 1, totalBatches: Math.max(1, Math.ceil(segments.length / DEFAULT_BATCH_SIZE)), retryAttempt: 0, createdAt: timestamp, updatedAt: timestamp };
      refreshCounts(storage, job, segments);
      persist(storage, job);
      launch(storage, dependencies, projectId);
      return res.status(202).json(publicStatus(storage, job));
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'AUDIO_GENERATION_START_FAILED', message: error?.message || 'Não foi possível iniciar a geração contínua.' } });
    }
  });

  app.get('/api/projects/:projectId/audio-generation/status', (req: Request, res: Response) => {
    try {
      const storage = storageProvider();
      const projectId = safeProjectId(req.params.projectId);
      const job = readAudioGenerationJob(storage, projectId);
      if (!job) return res.status(404).json({ error: { code: 'AUDIO_GENERATION_JOB_NOT_FOUND', message: 'Nenhum job contínuo foi iniciado.' } });
      if (['queued', 'processing'].includes(job.status)) launch(storage, dependencies, projectId);
      res.setHeader('Cache-Control', 'no-store');
      return res.json(publicStatus(storage, job));
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'AUDIO_GENERATION_STATUS_FAILED', message: error?.message || 'Não foi possível consultar o progresso.' } });
    }
  });

  app.post('/api/projects/:projectId/audio-generation/cancel', (req: Request, res: Response) => {
    const storage = storageProvider();
    const projectId = safeProjectId(req.params.projectId);
    const job = readAudioGenerationJob(storage, projectId);
    if (!job) return res.status(404).json({ error: { code: 'AUDIO_GENERATION_JOB_NOT_FOUND', message: 'Nenhum job contínuo foi iniciado.' } });
    job.status = 'cancelled';
    persist(storage, job);
    return res.json(publicStatus(storage, job));
  });

  setTimeout(() => {
    const storage = storageProvider();
    const projects = readJson<any[]>(storage.projectsDbFile, []);
    for (const project of projects) {
      const projectId = String(project?.projectId || '');
      const job = projectId ? readAudioGenerationJob(storage, projectId) : null;
      if (job && ['queued', 'processing'].includes(job.status)) launch(storage, dependencies, projectId);
    }
  }, 0);
}

export function resetAudioGenerationRuntimeForTests() { activeProjects.clear(); }
