import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAudioGenerationJobRoutes, resetAudioGenerationRuntimeForTests } from './audioGenerationJob';

const roots: string[] = [];
afterEach(() => {
  resetAudioGenerationRuntimeForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(count: number, readyOrders: number[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vox-audio-job-'));
  roots.push(root);
  const projectId = 'proj_audio_test';
  const projectDir = path.join(root, projectId);
  fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'audio', 'segments'), { recursive: true });
  const segments = Array.from({ length: count }, (_, index) => {
    const order = index + 1;
    const ready = readyOrders.includes(order);
    if (ready) fs.writeFileSync(path.join(projectDir, 'audio', 'segments', `seg_${order}.wav`), 'valid');
    return { segmentId: `seg_${order}`, order, spokenText: `Trecho ${order}`, status: ready ? 'ready' : 'pending', ...(ready ? { audioPath: `/projects/${projectId}/audio/segments/seg_${order}.wav` } : {}) };
  });
  fs.writeFileSync(path.join(projectDir, 'scripts', 'segments.json'), JSON.stringify(segments));
  const projectsDbFile = path.join(root, 'projects.json');
  fs.writeFileSync(projectsDbFile, JSON.stringify([{ projectId }]));
  return { root, projectId, projectDir, projectsDbFile };
}

async function waitForStatus(app: express.Express, projectId: string, statuses: string[]) {
  for (let index = 0; index < 200; index++) {
    const response = await request(app).get(`/api/projects/${projectId}/audio-generation/status`);
    if (statuses.includes(response.body?.job?.status)) return response.body.job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Job não alcançou ${statuses.join('/')}`);
}

describe('audio generation job', () => {
  it('encadeia lotes de 120, cria checkpoints e não repete áudios prontos', async () => {
    const data = fixture(241, [1, 121]);
    const generated: string[] = [];
    const app = express(); app.use(express.json());
    registerAudioGenerationJobRoutes(app, () => ({ projectsRoot: data.root, projectsDbFile: data.projectsDbFile }), {
      generateSegment: async (_projectId, segmentId) => {
        generated.push(segmentId);
        const file = path.join(data.projectDir, 'scripts', 'segments.json');
        const segments = JSON.parse(fs.readFileSync(file, 'utf8'));
        const segment = segments.find((item: any) => item.segmentId === segmentId);
        segment.status = 'ready'; segment.audioPath = `/projects/${data.projectId}/audio/segments/${segmentId}.wav`;
        fs.writeFileSync(path.join(data.projectDir, 'audio', 'segments', `${segmentId}.wav`), 'valid');
        fs.writeFileSync(file, JSON.stringify(segments));
      },
    });
    const start = await request(app).post(`/api/projects/${data.projectId}/audio-generation/start`).send({ maxRetries: 1 });
    expect(start.status).toBe(202);
    const job = await waitForStatus(app, data.projectId, ['completed']);
    expect(job).toMatchObject({ completedSegments: 241, pendingSegments: 0, totalBatches: 3, status: 'completed' });
    expect(generated).toHaveLength(239);
    expect(generated).not.toContain('seg_1');
    expect(generated).not.toContain('seg_121');
    expect(fs.existsSync(path.join(data.projectDir, 'audio', 'generation-job.json'))).toBe(true);
  }, 30_000);

  it('para após retries, preserva o progresso e retoma exatamente do segmento falho', async () => {
    const data = fixture(4);
    const attempts = new Map<string, number>();
    let allowFailure = false;
    const app = express(); app.use(express.json());
    registerAudioGenerationJobRoutes(app, () => ({ projectsRoot: data.root, projectsDbFile: data.projectsDbFile }), {
      generateSegment: async (_projectId, segmentId) => {
        attempts.set(segmentId, (attempts.get(segmentId) || 0) + 1);
        if (segmentId === 'seg_3' && !allowFailure) { const error: any = new Error('quota temporária'); error.status = 429; throw error; }
        const file = path.join(data.projectDir, 'scripts', 'segments.json');
        const segments = JSON.parse(fs.readFileSync(file, 'utf8'));
        const segment = segments.find((item: any) => item.segmentId === segmentId);
        segment.status = 'ready'; segment.audioPath = `/projects/${data.projectId}/audio/segments/${segmentId}.wav`;
        fs.writeFileSync(path.join(data.projectDir, 'audio', 'segments', `${segmentId}.wav`), 'valid');
        fs.writeFileSync(file, JSON.stringify(segments));
      },
    });
    await request(app).post(`/api/projects/${data.projectId}/audio-generation/start`).send({ maxRetries: 1 });
    const failed = await waitForStatus(app, data.projectId, ['failed']);
    expect(failed.completedSegments).toBe(2);
    expect(failed.lastError).toMatchObject({ segmentId: 'seg_3', retryable: true, attempt: 2 });
    allowFailure = true;
    await request(app).post(`/api/projects/${data.projectId}/audio-generation/start`).send({ maxRetries: 1 });
    const completed = await waitForStatus(app, data.projectId, ['completed']);
    expect(completed.completedSegments).toBe(4);
    expect(attempts.get('seg_1')).toBe(1);
    expect(attempts.get('seg_2')).toBe(1);
    expect(attempts.get('seg_3')).toBe(3);
  });

  it('cancela sem apagar os arquivos concluídos', async () => {
    const data = fixture(3, [1]);
    const app = express(); app.use(express.json());
    registerAudioGenerationJobRoutes(app, () => ({ projectsRoot: data.root, projectsDbFile: data.projectsDbFile }), { generateSegment: async () => new Promise(resolve => setTimeout(resolve, 100)) });
    await request(app).post(`/api/projects/${data.projectId}/audio-generation/start`).send();
    const cancelled = await request(app).post(`/api/projects/${data.projectId}/audio-generation/cancel`);
    expect(cancelled.body.job.status).toBe('cancelled');
    expect(fs.existsSync(path.join(data.projectDir, 'audio', 'segments', 'seg_1.wav'))).toBe(true);
  });
});
