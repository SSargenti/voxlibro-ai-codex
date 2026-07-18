import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sliceTextIntoSourceUnits } from './src/lib/losslessScript';
import {
  normalizeScriptGenerationResponseObject,
  parseAndNormalizeScriptGenerationResponse,
  readScriptGenerationJob,
  registerScriptGenerationJobRoutes,
  resetScriptGenerationRuntimeForTests,
  type ScriptGenerationDependencies,
  type ScriptGenerationStorage,
} from './src/scriptGenerationJob';

const tempDirs: string[] = [];

function sha256(value: string | Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixture(options?: { mode?: string; chapters?: any[] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxlibro-script-job-'));
  tempDirs.push(root);
  const projectsRoot = path.join(root, 'projects');
  const projectId = 'proj_script_job';
  const projectDir = path.join(projectsRoot, projectId);
  fs.mkdirSync(path.join(projectDir, 'normalized'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'narrative-bible'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
  const projectsDbFile = path.join(projectsRoot, 'projects.json');
  const project = {
    projectId,
    name: 'Livro de teste',
    status: 'scripting',
    productionMode: options?.mode || 'audiodrama',
    intensity: 0.65,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(projectsDbFile, JSON.stringify([project], null, 2));
  const chapters = options?.chapters || [{
    chapterId: 'chapter_001',
    order: 1,
    title: 'Um',
    translatedText: 'Capítulo 1\n— Olá — disse Mara.\nA noite caiu sobre a estação.',
  }];
  fs.writeFileSync(path.join(projectDir, 'normalized', 'chapters.json'), JSON.stringify(chapters, null, 2));
  const characters = [
    { characterId: 'char_narrator', canonicalName: 'Narrador', aliases: [], role: 'narrator', voiceAssignmentId: 'gcp:pt-BR-Wavenet-B' },
    { characterId: 'char_mara', canonicalName: 'Mara', aliases: ['Dra. Mara'], role: 'main', voiceAssignmentId: 'gcp:pt-BR-Wavenet-A' },
  ];
  fs.writeFileSync(path.join(projectDir, 'narrative-bible', 'characters.json'), JSON.stringify(characters, null, 2));
  return {
    root,
    projectId,
    projectDir,
    project,
    chapters,
    characters,
    storage: { projectsRoot, projectsDbFile } satisfies ScriptGenerationStorage,
  };
}

function appFor(storage: ScriptGenerationStorage, dependencies: ScriptGenerationDependencies) {
  const app = express();
  app.use(express.json());
  registerScriptGenerationJobRoutes(app, () => storage, dependencies);
  return app;
}

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForStatus(app: express.Express, projectId: string, expected: string, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await request(app).get(`/api/projects/${projectId}/script-generation/status`);
    if (response.status === 200 && response.body.job?.status === expected) return response.body;
    await wait(15);
  }
  throw new Error(`Job não alcançou o estado ${expected}.`);
}

function unitsFrom(chapters: any[]) {
  return chapters.flatMap(chapter => sliceTextIntoSourceUnits(chapter.translatedText || chapter.originalText || '', chapter.chapterId));
}

function successfulGenerator(gate?: Promise<void>) {
  let calls = 0;
  const generateContent = vi.fn(async (args: any) => {
    calls += 1;
    if (calls === 1 && gate) await gate;
    const prompt = String(args?.contents?.[0]?.text || '');
    const marker = 'sourceUnits:\n';
    const index = prompt.lastIndexOf(marker);
    const units = JSON.parse(prompt.slice(index + marker.length));
    return {
      text: JSON.stringify({
        segments: units.map((unit: any) => ({
          source_unit_id: unit.sourceUnitId,
          classification: unit.type === 'fala' ? 'dialogue' : unit.type === 'título' ? 'title' : 'paragraph',
          speaker_id: unit.type === 'fala' ? 'char_mara' : 'char_narrator',
          spoken_text: unit.sourceText,
          direction: { emotion: 'calmo', intensity: 0.6, pace: 'moderate', pause_after_ms: 280 },
        })),
      }),
    };
  });
  return {
    dependencies: {
      generateContent,
      hasTextAi: () => true,
      editorialModel: () => 'gpt-5.6-terra',
    } satisfies ScriptGenerationDependencies,
    calls: () => calls,
  };
}

function failingGenerator() {
  const error: any = new Error('Resposta inválida simulada');
  error.retryable = false;
  return {
    generateContent: vi.fn(async () => { throw error; }),
    hasTextAi: () => true,
    editorialModel: () => 'gpt-5.6-terra',
  } satisfies ScriptGenerationDependencies;
}

function sourceHash(project: any, units: any[], characters: any[]) {
  const characterSnapshot = characters.map(character => ({
    characterId: character.characterId,
    canonicalName: character.canonicalName,
    aliases: character.aliases,
    role: character.role,
  }));
  return sha256(JSON.stringify({
    mode: project.productionMode || 'audiobook',
    intensity: project.intensity ?? 0.5,
    units: units.map(unit => ({ id: unit.sourceUnitId, text: unit.sourceText, type: unit.type })),
    characters: characterSnapshot,
  }));
}

function batchesFrom(units: any[]) {
  const batches: any[] = [];
  for (let index = 0; index < units.length; index += 10) {
    const batchUnits = units.slice(index, index + 10);
    const hash = sha256(batchUnits.map(unit => `${unit.sourceUnitId}:${sha256(unit.sourceText)}`).join('|'));
    batches.push({ batchId: `script_batch_${hash.slice(0, 20)}`, index: batches.length, units: batchUnits, hash });
  }
  return batches;
}

afterEach(() => {
  resetScriptGenerationRuntimeForTests();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('normalização da resposta do roteiro', () => {
  it('aceita aliases de campos, classificações em inglês e cercas JSON', () => {
    const normalized = parseAndNormalizeScriptGenerationResponse(`\`\`\`json\n${JSON.stringify({
      results: [{
        unit_id: 'su_1',
        type: 'dialogue',
        character_id: 'char_mara',
        text: 'Olá.',
        voiceDirection: { emotion: 'feliz', intensity: 80, pace: 'moderate', pause: 420 },
      }],
    })}\n\`\`\``);
    expect(normalized.segments[0]).toEqual({
      sourceUnitId: 'su_1',
      classificação: 'fala',
      speakerId: 'char_mara',
      spokenText: 'Olá.',
      direction: { emotion: 'feliz', intensity: 1, pace: 'normal', pauseAfterMs: 420 },
    });
  });

  it('aceita uma lista direta de segmentos', () => {
    const normalized = normalizeScriptGenerationResponseObject([{ id: 'u1', classificacao: 'paragrafo', speaker: 'char_narrator', content: 'Texto' }]);
    expect(normalized.segments[0].classificação).toBe('parágrafo');
  });
});

describe('job persistente do roteiro', () => {
  it('responde imediatamente, salva checkpoint e publica cobertura integral', async () => {
    const { projectId, projectDir, storage } = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const generator = successfulGenerator(gate);
    const app = appFor(storage, generator.dependencies);

    const started = await Promise.race([
      request(app).post(`/api/projects/${projectId}/script-generation/start`).send({}),
      wait(500).then(() => { throw new Error('A rota não respondeu rapidamente.'); }),
    ]);
    expect(started.status).toBe(202);
    expect(started.body.job.status).toBe('queued');
    release();

    const completed = await waitForStatus(app, projectId, 'completed');
    expect(completed.job.progress).toBe(100);
    expect(completed.result.report).toMatchObject({ status: 'PASS', coverage: 100, totalUnresolved: 0, scriptComplete: true });
    expect(completed.result.segments).toHaveLength(3);
    expect(fs.readdirSync(path.join(projectDir, 'scripts', 'generation-batches'))).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(storage.projectsDbFile, 'utf8'))[0].status).toBe('generating_audio');
  });

  it('não transforma fallback completo em falha quando o modo audiolivro resolve tudo para o narrador', async () => {
    const { projectId, storage } = fixture({ mode: 'audiobook' });
    const app = appFor(storage, failingGenerator());
    await request(app).post(`/api/projects/${projectId}/script-generation/start`).send({}).expect(202);
    const completed = await waitForStatus(app, projectId, 'completed');

    expect(completed.job.fallbackBatchIds).toHaveLength(1);
    expect(completed.result.report).toMatchObject({ status: 'PASS', coverage: 100, totalUnresolved: 0, scriptComplete: true, usedDeterministicDraft: true });
    expect(completed.result.segments.every((segment: any) => segment.speakerId === 'char_narrator')).toBe(true);
  });

  it('permite resolver locutor pendente e libera a etapa de áudio sem refazer o roteiro', async () => {
    const { projectId, storage } = fixture({
      mode: 'audiodrama',
      chapters: [{ chapterId: 'chapter_001', order: 1, title: 'Um', translatedText: 'Capítulo 1\n— Quem está aí?' }],
    });
    const app = appFor(storage, failingGenerator());
    await request(app).post(`/api/projects/${projectId}/script-generation/start`).send({}).expect(202);
    const completed = await waitForStatus(app, projectId, 'completed');
    expect(completed.result.report).toMatchObject({ coverage: 100, totalUnresolved: 1, scriptComplete: false });
    const unresolved = completed.result.segments.find((segment: any) => segment.speakerId === 'unresolved');

    const updated = await request(app)
      .put(`/api/projects/${projectId}/script-generation/segments/${unresolved.segmentId}`)
      .send({ speakerId: 'char_mara' })
      .expect(200);

    expect(updated.body.report).toMatchObject({ coverage: 100, totalUnresolved: 0, scriptComplete: true, status: 'PASS' });
    expect(updated.body.project.status).toBe('generating_audio');
    expect(updated.body.segment.manuallyReviewed).toBe(true);
  });

  it('retoma somente os lotes pendentes depois de reinicialização', async () => {
    const lines = ['Capítulo 1', ...Array.from({ length: 14 }, (_, index) => `Parágrafo ${index + 1} da obra.`)];
    const { projectId, projectDir, project, chapters, characters, storage } = fixture({
      mode: 'audiobook',
      chapters: [{ chapterId: 'chapter_001', order: 1, title: 'Um', translatedText: lines.join('\n') }],
    });
    const units = unitsFrom(chapters);
    const batches = batchesFrom(units);
    const first = batches[0];
    const checkpointDir = path.join(projectDir, 'scripts', 'generation-batches');
    fs.mkdirSync(checkpointDir, { recursive: true });
    fs.writeFileSync(path.join(checkpointDir, `${first.batchId}.json`), JSON.stringify({
      version: 1,
      batchId: first.batchId,
      batchIndex: 0,
      hash: first.hash,
      source: 'ai',
      segments: first.units.map((unit: any) => ({
        segmentId: `seg_${sha256(unit.sourceUnitId).slice(0, 24)}`,
        projectId,
        chapterId: unit.chapterId,
        sourceUnitId: unit.sourceUnitId,
        order: unit.order,
        type: unit.type,
        speakerId: 'char_narrator',
        originalText: unit.sourceText,
        spokenText: unit.sourceText,
        direction: { emotion: 'neutral', intensity: 0.5, pace: 'normal', pauseAfterMs: 300 },
        status: 'pending',
      })),
      completedAt: new Date().toISOString(),
    }, null, 2));
    fs.writeFileSync(path.join(projectDir, 'scripts', 'generation-job.json'), JSON.stringify({
      version: 1,
      jobId: 'script_job_before_restart',
      projectId,
      status: 'processing',
      sourceHash: sourceHash(project, units, characters),
      forceFresh: false,
      totalBatches: batches.length,
      completedBatchIds: [first.batchId],
      fallbackBatchIds: [],
      progress: 50,
      attempts: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2));

    const generator = successfulGenerator();
    const app = appFor(storage, generator.dependencies);
    const completed = await waitForStatus(app, projectId, 'completed');

    expect(completed.job.jobId).toBe('script_job_before_restart');
    expect(completed.job.completedBatchIds).toHaveLength(2);
    expect(generator.calls()).toBe(1);
    expect(completed.result.report.coverage).toBe(100);
    expect(readScriptGenerationJob(storage, projectId)?.status).toBe('completed');
  });

  it('preserva trechos travados durante uma nova geração', async () => {
    const { projectId, projectDir, storage, chapters } = fixture();
    const firstUnit = unitsFrom(chapters)[0];
    fs.writeFileSync(path.join(projectDir, 'scripts', 'segments.json'), JSON.stringify([{
      segmentId: 'seg_locked_custom',
      projectId,
      chapterId: firstUnit.chapterId,
      sourceUnitId: firstUnit.sourceUnitId,
      order: 1,
      type: firstUnit.type,
      speakerId: 'char_mara',
      originalText: firstUnit.sourceText,
      spokenText: 'Texto revisado e travado pelo usuário.',
      direction: { emotion: 'solene', intensity: 0.9, pace: 'slow', pauseAfterMs: 800 },
      status: 'pending',
      locked: true,
    }], null, 2));
    const generator = successfulGenerator();
    const app = appFor(storage, generator.dependencies);
    await request(app).post(`/api/projects/${projectId}/script-generation/start`).send({ forceFresh: true }).expect(202);
    const completed = await waitForStatus(app, projectId, 'completed');
    const preserved = completed.result.segments.find((segment: any) => segment.sourceUnitId === firstUnit.sourceUnitId);
    expect(preserved).toMatchObject({ segmentId: 'seg_locked_custom', spokenText: 'Texto revisado e travado pelo usuário.', speakerId: 'char_mara', locked: true });
  });
});
