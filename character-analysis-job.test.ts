import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readCharacterAnalysisJob,
  registerCharacterAnalysisJobRoutes,
  resetCharacterAnalysisRuntimeForTests,
  splitCharacterAnalysisWorkUnits,
  type CharacterAnalysisDependencies,
  type CharacterAnalysisStorage,
} from './src/characterAnalysisJob';

const tempDirs: string[] = [];

function fixture(chapters?: any[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxlibro-character-job-'));
  tempDirs.push(root);
  const projectsRoot = path.join(root, 'projects');
  const projectId = 'proj_character_job';
  const projectDir = path.join(projectsRoot, projectId);
  fs.mkdirSync(path.join(projectDir, 'normalized'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'narrative-bible'), { recursive: true });
  const projectsDbFile = path.join(projectsRoot, 'projects.json');
  fs.writeFileSync(projectsDbFile, JSON.stringify([{
    projectId,
    name: 'Livro de teste',
    status: 'analyzing_characters',
    productionMode: 'audiodrama',
    allowTechnicalAuthors: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }], null, 2));
  const sourceChapters = chapters || [
    { chapterId: 'chapter_001', order: 1, title: 'Um', translatedText: 'Mara abriu a porta da estação e chamou Jonas.' },
    { chapterId: 'chapter_002', order: 2, title: 'Dois', translatedText: 'Jonas respondeu e encontrou Mara no corredor.' },
  ];
  fs.writeFileSync(path.join(projectDir, 'normalized', 'chapters.json'), JSON.stringify(sourceChapters, null, 2));
  return {
    projectId,
    projectDir,
    sourceChapters,
    storage: { projectsRoot, projectsDbFile } satisfies CharacterAnalysisStorage,
  };
}

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForStatus(app: express.Express, projectId: string, expected: string, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await request(app).get(`/api/projects/${projectId}/character-analysis/status`);
    if (response.status === 200 && response.body.job?.status === expected) return response.body;
    await wait(15);
  }
  throw new Error(`Job não alcançou o estado ${expected}.`);
}

function cacheHash(text: string) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function mockAnalyzer(options?: { failOnCall?: number; gateFirstCall?: Promise<void> }) {
  let calls = 0;
  const perform = vi.fn(async (stageProjectId: string) => {
    calls += 1;
    if (calls === 1 && options?.gateFirstCall) await options.gateFirstCall;
    if (options?.failOnCall === calls) throw new Error('Interrupção simulada do serviço');

    const root = currentStorage!.projectsRoot;
    const dir = path.join(root, stageProjectId);
    const chapters = JSON.parse(fs.readFileSync(path.join(dir, 'normalized', 'chapters.json'), 'utf8'));
    const bible = path.join(dir, 'narrative-bible');
    fs.mkdirSync(bible, { recursive: true });
    const cacheFile = path.join(bible, 'chunks-cache.json');
    const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
    for (const chapter of chapters) {
      const text = String(chapter.translatedText || chapter.originalText || '');
      cache[cacheHash(text)] = [{ candidateName: 'Mara', aliases: [], atributos: [], papel: 'main', evidenceUnitIds: [text], confidence: 1 }];
    }
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));

    const characters = [{ characterId: 'char_mara', projectId: stageProjectId, canonicalName: 'Mara', aliases: [], role: 'main', voiceAssignmentId: 'gcp:pt-BR-Wavenet-A', locked: true }];
    const sightings = chapters.map((chapter: any, index: number) => ({ projectId: stageProjectId, characterId: 'char_mara', chapterId: chapter.chapterId, order: index + 1 }));
    const mergeSuggestions: any[] = [];
    fs.writeFileSync(path.join(bible, 'characters.json'), JSON.stringify(characters, null, 2));
    fs.writeFileSync(path.join(bible, 'sightings.json'), JSON.stringify(sightings, null, 2));
    fs.writeFileSync(path.join(bible, 'merge-suggestions.json'), JSON.stringify(mergeSuggestions, null, 2));
    return { characters, sightings, mergeSuggestions };
  });
  return { perform, calls: () => calls };
}

let currentStorage: CharacterAnalysisStorage | null = null;

function appFor(storage: CharacterAnalysisStorage, dependencies: CharacterAnalysisDependencies) {
  currentStorage = storage;
  const app = express();
  app.use(express.json());
  registerCharacterAnalysisJobRoutes(app, () => storage, dependencies);
  return app;
}

afterEach(() => {
  resetCharacterAnalysisRuntimeForTests();
  currentStorage = null;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('job persistente da Bíblia narrativa', () => {
  it('responde imediatamente, salva checkpoint por bloco e publica a Bíblia consolidada', async () => {
    const { projectId, projectDir, storage } = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const analyzer = mockAnalyzer({ gateFirstCall: gate });
    const app = appFor(storage, { performMapReduceCharacterAnalysis: analyzer.perform });

    const started = await Promise.race([
      request(app).post(`/api/projects/${projectId}/character-analysis/start`).send({ forceFresh: false }),
      wait(500).then(() => { throw new Error('A rota não respondeu rapidamente.'); }),
    ]);
    expect(started.status).toBe(202);
    expect(started.body.job.status).toBe('queued');
    expect(started.body.job.totalUnits).toBe(2);

    release();
    const completed = await waitForStatus(app, projectId, 'completed');
    expect(completed.job.progress).toBe(100);
    expect(completed.job.completedUnitIds).toHaveLength(2);
    expect(completed.result.characters[0]).toMatchObject({
      projectId,
      canonicalName: 'Mara',
      voiceAssignmentId: 'gcp:pt-BR-Wavenet-A',
      locked: true,
    });
    expect(analyzer.calls()).toBe(3); // dois blocos + consolidação sem novas chamadas reais no servidor
    expect(fs.existsSync(path.join(projectDir, 'narrative-bible', 'chunks-cache.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'narrative-bible', 'analysis-job.json'))).toBe(true);

    const projects = JSON.parse(fs.readFileSync(storage.projectsDbFile, 'utf8'));
    expect(projects).toHaveLength(1);
    expect(projects[0].status).toBe('awaiting_voice_approval');
    expect(projects[0].internalTemporary).not.toBe(true);
  });

  it('retoma somente os blocos pendentes depois de uma falha ou reinicialização', async () => {
    const { projectId, storage } = fixture([
      { chapterId: 'chapter_001', order: 1, title: 'Um', translatedText: 'Primeiro bloco com Mara.' },
      { chapterId: 'chapter_002', order: 2, title: 'Dois', translatedText: 'Segundo bloco com Jonas.' },
      { chapterId: 'chapter_003', order: 3, title: 'Três', translatedText: 'Terceiro bloco com Aurora.' },
    ]);
    const firstAnalyzer = mockAnalyzer({ failOnCall: 2 });
    const firstApp = appFor(storage, { performMapReduceCharacterAnalysis: firstAnalyzer.perform });

    await request(firstApp).post(`/api/projects/${projectId}/character-analysis/start`).send({ forceFresh: false }).expect(202);
    const failed = await waitForStatus(firstApp, projectId, 'failed');
    expect(failed.job.completedUnitIds).toHaveLength(1);
    expect(failed.job.lastError.message).toContain('Interrupção simulada');

    resetCharacterAnalysisRuntimeForTests();
    const resumedAnalyzer = mockAnalyzer();
    const resumedApp = appFor(storage, { performMapReduceCharacterAnalysis: resumedAnalyzer.perform });
    await request(resumedApp).post(`/api/projects/${projectId}/character-analysis/start`).send({ forceFresh: false }).expect(202);
    const completed = await waitForStatus(resumedApp, projectId, 'completed');

    expect(completed.job.completedUnitIds).toHaveLength(3);
    expect(resumedAnalyzer.calls()).toBe(3); // dois pendentes + consolidação; o primeiro não foi repetido
    expect(completed.result.characters).toHaveLength(1);
  });

  it('retoma automaticamente um job marcado como processing ao registrar as rotas após restart', async () => {
    const { projectId, projectDir, sourceChapters, storage } = fixture();
    const units = splitCharacterAnalysisWorkUnits(sourceChapters);
    const completedUnit = units[0];
    const cacheFile = path.join(projectDir, 'narrative-bible', 'chunks-cache.json');
    fs.writeFileSync(cacheFile, JSON.stringify({ [cacheHash(completedUnit.text)]: [{ candidateName: 'Mara' }] }, null, 2));
    fs.writeFileSync(path.join(projectDir, 'narrative-bible', 'analysis-job.json'), JSON.stringify({
      version: 1,
      jobId: 'character_job_before_restart',
      projectId,
      status: 'processing',
      forceFresh: false,
      freshResetApplied: false,
      allowTechnicalAuthors: false,
      sourceHash: crypto.createHash('sha256').update(units.map(unit => `${unit.chapterId}:${unit.textHash}`).join('|')).digest('hex'),
      totalUnits: units.length,
      completedUnitIds: [completedUnit.unitId],
      progress: 50,
      attempts: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2));

    const analyzer = mockAnalyzer();
    const app = appFor(storage, { performMapReduceCharacterAnalysis: analyzer.perform });
    const completed = await waitForStatus(app, projectId, 'completed');

    expect(completed.job.jobId).toBe('character_job_before_restart');
    expect(completed.job.completedUnitIds).toHaveLength(2);
    expect(analyzer.calls()).toBe(2); // um bloco restante + consolidação
    expect(readCharacterAnalysisJob(storage, projectId)?.status).toBe('completed');
  });

  it('forceFresh cria nova execução e limpa checkpoints anteriores sem apagar a Bíblia editada', async () => {
    const { projectId, projectDir, storage } = fixture();
    fs.writeFileSync(path.join(projectDir, 'narrative-bible', 'characters.json'), JSON.stringify([{
      characterId: 'char_mara', projectId, canonicalName: 'Mara Editada', aliases: ['Mara'], role: 'main', locked: true, voiceAssignmentId: 'gcp:pt-BR-Wavenet-B',
    }], null, 2));
    fs.writeFileSync(path.join(projectDir, 'narrative-bible', 'chunks-cache.json'), JSON.stringify({ antigo: [{ candidateName: 'Antigo' }] }, null, 2));

    const analyzer = mockAnalyzer();
    const app = appFor(storage, { performMapReduceCharacterAnalysis: analyzer.perform });
    await request(app).post(`/api/projects/${projectId}/character-analysis/start`).send({ forceFresh: true }).expect(202);
    const completed = await waitForStatus(app, projectId, 'completed');

    expect(completed.job.forceFresh).toBe(true);
    expect(completed.job.freshResetApplied).toBe(true);
    expect(JSON.stringify(JSON.parse(fs.readFileSync(path.join(projectDir, 'narrative-bible', 'chunks-cache.json'), 'utf8')))).not.toContain('antigo');
    expect(completed.result.characters[0].voiceAssignmentId).toBe('gcp:pt-BR-Wavenet-A');
  });
});
