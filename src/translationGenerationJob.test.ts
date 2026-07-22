import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { registerTranslationGenerationJobRoutes, resetTranslationGenerationRuntimeForTests } from './translationGenerationJob';

const roots: string[] = [];
afterEach(() => {
  resetTranslationGenerationRuntimeForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(chapters = [{ chapterId: 'chapter_1', order: 1, title: 'Capítulo 1', originalText: 'First chapter.' }, { chapterId: 'chapter_2', order: 2, title: 'Capítulo 2', originalText: 'Second chapter.' }]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vox-translation-job-'));
  roots.push(root);
  const projectId = 'proj_translation_test';
  const projectDir = path.join(root, projectId);
  fs.mkdirSync(path.join(projectDir, 'normalized'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'normalized', 'chapters.json'), JSON.stringify(chapters));
  const projectsDbFile = path.join(root, 'projects.json');
  fs.writeFileSync(projectsDbFile, JSON.stringify([{ projectId, translationEnabled: true, status: 'awaiting_configuration' }]));
  return { root, projectId, projectDir, projectsDbFile };
}

async function waitForStatus(app: express.Express, projectId: string, statuses: string[]) {
  for (let index = 0; index < 300; index++) {
    const response = await request(app).get(`/api/projects/${projectId}/translation/status`);
    if (statuses.includes(response.body?.job?.status)) return response.body.job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Job não alcançou ${statuses.join('/')}`);
}

describe('persistent translation generation job', () => {
  it('responde imediatamente, salva cada capítulo e conclui sem chamadas HTTP longas', async () => {
    const data = fixture();
    const translated: string[] = [];
    const app = express(); app.use(express.json());
    registerTranslationGenerationJobRoutes(app, () => ({ projectsRoot: data.root, projectsDbFile: data.projectsDbFile }), {
      hasTextAi: () => true,
      translateChunk: async chunk => { translated.push(chunk.unitId); return { translatedText: `PT: ${chunk.text}` }; },
    });
    const start = await request(app).post(`/api/projects/${data.projectId}/translation/automated`).send({ maxRetries: 0 });
    expect(start.status).toBe(202);
    const completed = await waitForStatus(app, data.projectId, ['completed']);
    expect(completed).toMatchObject({ status: 'completed', completedChapters: 2, completedUnits: 2, progress: 100 });
    expect(translated).toHaveLength(2);
    const chapters = JSON.parse(fs.readFileSync(path.join(data.projectDir, 'normalized', 'chapters.json'), 'utf8'));
    expect(chapters.map((chapter: any) => chapter.translatedText)).toEqual(['PT: First chapter.', 'PT: Second chapter.']);
    expect(fs.existsSync(path.join(data.projectDir, 'translation', 'generation-job.json'))).toBe(true);
  });

  it('preserva o capítulo concluído, exibe o erro e retoma sem repetir trabalho', async () => {
    const data = fixture();
    const attempts = new Map<string, number>();
    let allowSecond = false;
    const app = express(); app.use(express.json());
    registerTranslationGenerationJobRoutes(app, () => ({ projectsRoot: data.root, projectsDbFile: data.projectsDbFile }), {
      translateChunk: async chunk => {
        attempts.set(chunk.chapterId, (attempts.get(chunk.chapterId) || 0) + 1);
        if (chunk.chapterId === 'chapter_2' && !allowSecond) { const error: any = new Error('serviço temporariamente indisponível'); error.status = 503; throw error; }
        return { translatedText: `PT: ${chunk.text}` };
      },
    });
    await request(app).post(`/api/projects/${data.projectId}/translation/automated`).send({ maxRetries: 0 });
    const failed = await waitForStatus(app, data.projectId, ['failed']);
    expect(failed).toMatchObject({ completedChapters: 1, completedUnits: 1, failedUnits: 1 });
    expect(failed.lastError).toMatchObject({ chapterId: 'chapter_2', retryable: true, attempt: 1 });
    const partial = JSON.parse(fs.readFileSync(path.join(data.projectDir, 'normalized', 'chapters.json'), 'utf8'));
    expect(partial[0].translatedText).toBe('PT: First chapter.');
    expect(partial[1].translatedText).toBeUndefined();
    allowSecond = true;
    await request(app).post(`/api/projects/${data.projectId}/translation/automated`).send({ maxRetries: 0 });
    const completed = await waitForStatus(app, data.projectId, ['completed']);
    expect(completed.completedChapters).toBe(2);
    expect(attempts.get('chapter_1')).toBe(1);
    expect(attempts.get('chapter_2')).toBe(2);
  });

  it('cancela, mantém checkpoints e permite continuar depois', async () => {
    const data = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const app = express(); app.use(express.json());
    registerTranslationGenerationJobRoutes(app, () => ({ projectsRoot: data.root, projectsDbFile: data.projectsDbFile }), {
      translateChunk: async chunk => { calls.push(chunk.chapterId); await gate; return { translatedText: `PT: ${chunk.text}` }; },
    });
    await request(app).post(`/api/projects/${data.projectId}/translation/automated`).send({ maxRetries: 0 });
    await new Promise(resolve => setTimeout(resolve, 20));
    const cancelled = await request(app).post(`/api/projects/${data.projectId}/translation/cancel`);
    expect(cancelled.body.job.status).toBe('cancelled');
    release();
    await new Promise(resolve => setTimeout(resolve, 30));
    const stillCancelled = await request(app).get(`/api/projects/${data.projectId}/translation/status`);
    expect(stillCancelled.body.job.status).toBe('cancelled');
    expect(fs.readdirSync(path.join(data.projectDir, 'translation', 'chunks')).length).toBeGreaterThan(0);
    await request(app).post(`/api/projects/${data.projectId}/translation/automated`).send({ maxRetries: 0 });
    const completed = await waitForStatus(app, data.projectId, ['completed']);
    expect(completed.completedChapters).toBe(2);
    expect(calls.filter(chapterId => chapterId === 'chapter_1')).toHaveLength(1);
  });
});
