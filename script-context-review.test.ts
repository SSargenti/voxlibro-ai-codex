import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sliceTextIntoSourceUnits } from './src/lib/losslessScript';
import {
  readScriptContextReviewJob,
  registerScriptContextReviewRoutes,
  resetScriptContextReviewRuntimeForTests,
  type ScriptContextReviewDependencies,
  type ScriptContextReviewStorage,
} from './src/scriptContextReview';

const tempDirs: string[] = [];

function fixture(options?: { twoPending?: boolean; locked?: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxlibro-script-review-'));
  tempDirs.push(root);
  const projectsRoot = path.join(root, 'projects');
  const projectId = 'proj_script_review';
  const projectDir = path.join(projectsRoot, projectId);
  const scriptsDir = path.join(projectDir, 'scripts');
  fs.mkdirSync(path.join(projectDir, 'normalized'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'narrative-bible'), { recursive: true });
  fs.mkdirSync(path.join(scriptsDir, 'tts-input'), { recursive: true });
  const projectsDbFile = path.join(projectsRoot, 'projects.json');
  const project = {
    projectId,
    name: 'Livro contextual',
    status: 'scripting',
    productionMode: 'audiodrama',
    intensity: 0.65,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(projectsDbFile, JSON.stringify([project], null, 2));
  const text = options?.twoPending
    ? 'Capítulo 1\n— Quem está aí?\nMara abriu a porta.\n— Sou eu.'
    : 'Capítulo 1\nMara abriu a porta.\n— Quem está aí?\n— Sou eu — respondeu Mara.';
  const chapters = [{ chapterId: 'chapter_001', order: 1, title: 'Um', translatedText: text }];
  fs.writeFileSync(path.join(projectDir, 'normalized', 'chapters.json'), JSON.stringify(chapters, null, 2));
  const characters = [
    { characterId: 'char_narrator', canonicalName: 'Narrador', aliases: [], role: 'narrator' },
    { characterId: 'char_mara', canonicalName: 'Mara', aliases: ['Dra. Mara'], role: 'main' },
    { characterId: 'char_ivo', canonicalName: 'Ivo', aliases: [], role: 'supporting' },
  ];
  fs.writeFileSync(path.join(projectDir, 'narrative-bible', 'characters.json'), JSON.stringify(characters, null, 2));
  fs.writeFileSync(path.join(projectDir, 'narrative-bible', 'sightings.json'), JSON.stringify([
    { characterId: 'char_mara', chapterId: 'chapter_001', evidenceText: 'Mara abriu a porta.' },
  ], null, 2));
  const units = sliceTextIntoSourceUnits(text, 'chapter_001');
  fs.writeFileSync(path.join(scriptsDir, 'source-units.jsonl'), `${units.map(unit => JSON.stringify(unit)).join('\n')}\n`);
  const segments = units.map((unit, index) => {
    const isDialogue = unit.type === 'fala';
    const unresolved = isDialogue && (options?.twoPending || index === 2);
    const segmentId = `seg_${index + 1}`;
    fs.writeFileSync(path.join(scriptsDir, 'tts-input', `${segmentId}.txt`), unit.sourceText);
    return {
      segmentId,
      projectId,
      chapterId: unit.chapterId,
      sourceUnitId: unit.sourceUnitId,
      order: index + 1,
      type: unit.type,
      speakerId: unresolved ? 'unresolved' : isDialogue ? 'char_mara' : 'char_narrator',
      originalText: unit.sourceText,
      spokenText: unit.sourceText,
      direction: { emotion: isDialogue ? 'tenso' : 'informativo', intensity: .6, pace: 'normal', pauseAfterMs: 300 },
      status: 'pending',
      locked: Boolean(options?.locked && unresolved),
    };
  });
  fs.writeFileSync(path.join(scriptsDir, 'segments.json'), JSON.stringify(segments, null, 2));
  fs.writeFileSync(path.join(scriptsDir, 'segments.jsonl'), `${segments.map(segment => JSON.stringify(segment)).join('\n')}\n`);
  fs.writeFileSync(path.join(scriptsDir, 'generation-job.json'), JSON.stringify({
    version: 1,
    jobId: 'script_job_fixture',
    projectId,
    status: 'completed',
    sourceHash: 'fixture',
    forceFresh: false,
    totalBatches: 1,
    completedBatchIds: ['batch'],
    fallbackBatchIds: [],
    progress: 100,
    attempts: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2));
  return {
    projectId,
    projectDir,
    scriptsDir,
    characters,
    segments,
    storage: { projectsRoot, projectsDbFile } satisfies ScriptContextReviewStorage,
  };
}

function appFor(storage: ScriptContextReviewStorage, dependencies: ScriptContextReviewDependencies) {
  const app = express();
  app.use(express.json());
  registerScriptContextReviewRoutes(app, () => storage, dependencies);
  return app;
}

function dependencies(generator: (args: any) => Promise<any>) {
  return {
    generateContent: vi.fn(generator),
    hasTextAi: () => true,
    editorialModel: () => 'gpt-5.6-terra',
    auditModel: () => 'gpt-5.6-sol',
  } satisfies ScriptContextReviewDependencies;
}

function wait(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForStatus(app: express.Express, projectId: string, slug: string, expected: string, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await request(app).get(`/api/projects/${projectId}/script-review/${slug}/status`);
    if (response.status === 200 && response.body.job?.status === expected) return response.body;
    await wait(15);
  }
  throw new Error(`Job ${slug} não alcançou ${expected}.`);
}

function targetIdFromPrompt(prompt: string) {
  const marker = '\nALVO:\n';
  const endMarker = '\n\nResponda em JSON estrito:';
  const start = prompt.indexOf(marker);
  const end = prompt.indexOf(endMarker, start + marker.length);
  return JSON.parse(prompt.slice(start + marker.length, end))[0].segmentId;
}

function targetIdsFromAuditPrompt(prompt: string) {
  const marker = '\nALVOS:\n';
  const endMarker = '\n\nResponda em JSON estrito:';
  const start = prompt.indexOf(marker);
  const end = prompt.indexOf(endMarker, start + marker.length);
  return JSON.parse(prompt.slice(start + marker.length, end)).map((item: any) => item.segmentId);
}

afterEach(() => {
  resetScriptContextReviewRuntimeForTests();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('reanálise seletiva de locutores', () => {
  it('responde imediatamente, usa Terra e cria sugestão sem alterar o roteiro', async () => {
    const { projectId, scriptsDir, storage } = fixture();
    const deps = dependencies(async (args: any) => {
      expect(args.model).toBe('gpt-5.6-terra');
      expect(args.config.reasoningEffort).toBe('medium');
      const segmentId = targetIdFromPrompt(String(args.contents[0].text));
      return { text: JSON.stringify({ suggestions: [{ segmentId, suggestedSpeakerId: 'char_mara', confidence: .96, reason: 'Mara responde à fala anterior.', evidence: ['Mara abriu a porta.'] }] }) };
    });
    const app = appFor(storage, deps);

    const started = await request(app).post(`/api/projects/${projectId}/script-review/pending-speakers/start`).send({});
    expect(started.status).toBe(202);
    const completed = await waitForStatus(app, projectId, 'pending-speakers', 'completed');

    expect(completed.job.summary).toMatchObject({ suggestions: 1, highConfidence: 1 });
    expect(completed.result.suggestions[0]).toMatchObject({ status: 'pending', mode: 'pending_speakers', suggested: { speakerId: 'char_mara' } });
    const unchanged = JSON.parse(fs.readFileSync(path.join(scriptsDir, 'segments.json'), 'utf8'));
    expect(unchanged.find((segment: any) => segment.segmentId === completed.result.suggestions[0].segmentId).speakerId).toBe('unresolved');
  });

  it('aplica a sugestão, invalida somente o áudio do trecho e libera a etapa de áudio', async () => {
    const { projectId, projectDir, scriptsDir, storage } = fixture();
    const deps = dependencies(async (args: any) => {
      const segmentId = targetIdFromPrompt(String(args.contents[0].text));
      return { text: JSON.stringify({ suggestions: [{ segmentId, suggestedSpeakerId: 'char_mara', confidence: .97, reason: 'Contexto direto.', evidence: ['fala anterior'] }] }) };
    });
    const app = appFor(storage, deps);
    await request(app).post(`/api/projects/${projectId}/script-review/pending-speakers/start`).send({}).expect(202);
    const completed = await waitForStatus(app, projectId, 'pending-speakers', 'completed');
    const suggestion = completed.result.suggestions[0];
    const segments = JSON.parse(fs.readFileSync(path.join(scriptsDir, 'segments.json'), 'utf8'));
    const segment = segments.find((item: any) => item.segmentId === suggestion.segmentId);
    const audioDir = path.join(projectDir, 'audio', 'segments');
    fs.mkdirSync(audioDir, { recursive: true });
    fs.writeFileSync(path.join(audioDir, 'old.wav'), 'audio');
    segment.audioPath = '/api/audio/old.wav';
    segment.status = 'ready';
    fs.writeFileSync(path.join(scriptsDir, 'segments.json'), JSON.stringify(segments, null, 2));

    const applied = await request(app).post(`/api/projects/${projectId}/script-review/suggestions/${suggestion.suggestionId}/apply`).expect(200);
    expect(applied.body.segment).toMatchObject({ speakerId: 'char_mara', status: 'pending', manuallyReviewed: true });
    expect(applied.body.scriptReport).toMatchObject({ totalUnresolved: 0, scriptComplete: true, status: 'PASS' });
    expect(applied.body.project.status).toBe('generating_audio');
    expect(fs.existsSync(path.join(audioDir, 'old.wav'))).toBe(false);
  });

  it('não altera segmento travado', async () => {
    const { projectId, storage } = fixture({ locked: true });
    const deps = dependencies(async () => { throw new Error('não deveria chamar'); });
    const app = appFor(storage, deps);
    const started = await request(app).post(`/api/projects/${projectId}/script-review/pending-speakers/start`).send({});
    expect(started.status).toBe(200);
    expect(started.body.job).toMatchObject({ status: 'completed', totalItems: 0 });
    expect(deps.generateContent).not.toHaveBeenCalled();
  });
});

describe('auditoria contextual final', () => {
  it('usa Sol, cria recomendações revisáveis e não aplica automaticamente', async () => {
    const { projectId, scriptsDir, storage } = fixture();
    const deps = dependencies(async (args: any) => {
      expect(args.model).toBe('gpt-5.6-sol');
      expect(args.config.reasoningEffort).toBe('high');
      const ids = targetIdsFromAuditPrompt(String(args.contents[0].text));
      const segmentId = ids[ids.length - 1];
      return { text: JSON.stringify({ issues: [{ segmentId, category: 'direction_consistency', suggestedDirection: { emotion: 'alívio', intensity: .4, pace: 'slow', pauseAfterMs: 420 }, confidence: .91, reason: 'A resposta encerra a tensão.', evidence: ['continuidade da cena'] }] }) };
    });
    const app = appFor(storage, deps);
    await request(app).post(`/api/projects/${projectId}/script-review/final-audit/start`).send({}).expect(202);
    const completed = await waitForStatus(app, projectId, 'final-audit', 'completed');

    const suggestion = completed.result.suggestions.find((item: any) => item.mode === 'final_audit');
    expect(suggestion).toMatchObject({ status: 'pending', category: 'direction_consistency' });
    expect(completed.result.finalReport.status).toBe('FAIL');
    const segments = JSON.parse(fs.readFileSync(path.join(scriptsDir, 'segments.json'), 'utf8'));
    expect(segments.find((item: any) => item.segmentId === suggestion.segmentId).direction.emotion).not.toBe('alívio');
  });

  it('rejeitar a última sugestão final remove o bloqueio editorial quando não há falhas estruturais', async () => {
    const { projectId, scriptsDir, storage } = fixture();
    const initial = JSON.parse(fs.readFileSync(path.join(scriptsDir, 'segments.json'), 'utf8'));
    initial.forEach((segment: any) => { if (segment.speakerId === 'unresolved') segment.speakerId = 'char_mara'; });
    fs.writeFileSync(path.join(scriptsDir, 'segments.json'), JSON.stringify(initial, null, 2));
    const deps = dependencies(async (args: any) => {
      const segmentId = targetIdsFromAuditPrompt(String(args.contents[0].text))[0];
      return { text: JSON.stringify({ issues: [{ segmentId, category: 'scene_continuity', suggestedDirection: { pauseAfterMs: 500 }, confidence: .75, reason: 'Pausa sugerida.', evidence: ['mudança de cena'] }] }) };
    });
    const app = appFor(storage, deps);
    await request(app).post(`/api/projects/${projectId}/script-review/final-audit/start`).send({}).expect(202);
    const completed = await waitForStatus(app, projectId, 'final-audit', 'completed');
    const suggestion = completed.result.suggestions.find((item: any) => item.status === 'pending');
    expect(completed.result.finalReport.status).toBe('REVIEW');

    const rejected = await request(app).post(`/api/projects/${projectId}/script-review/suggestions/${suggestion.suggestionId}/reject`).expect(200);
    expect(rejected.body.finalReport.status).toBe('PASS');
    expect(rejected.body.project.status).toBe('generating_audio');
  });

  it('recusa sugestão obsoleta quando o trecho mudou depois da análise', async () => {
    const { projectId, scriptsDir, storage } = fixture();
    const deps = dependencies(async (args: any) => {
      const segmentId = targetIdFromPrompt(String(args.contents[0].text));
      return { text: JSON.stringify({ suggestions: [{ segmentId, suggestedSpeakerId: 'char_mara', confidence: .95, reason: 'Contexto.', evidence: [] }] }) };
    });
    const app = appFor(storage, deps);
    await request(app).post(`/api/projects/${projectId}/script-review/pending-speakers/start`).send({}).expect(202);
    const completed = await waitForStatus(app, projectId, 'pending-speakers', 'completed');
    const suggestion = completed.result.suggestions[0];
    const segments = JSON.parse(fs.readFileSync(path.join(scriptsDir, 'segments.json'), 'utf8'));
    segments.find((item: any) => item.segmentId === suggestion.segmentId).spokenText += ' Alterado.';
    fs.writeFileSync(path.join(scriptsDir, 'segments.json'), JSON.stringify(segments, null, 2));

    await request(app).post(`/api/projects/${projectId}/script-review/suggestions/${suggestion.suggestionId}/apply`).expect(409);
    const state = await request(app).get(`/api/projects/${projectId}/script-review`).expect(200);
    expect(state.body.suggestions.find((item: any) => item.suggestionId === suggestion.suggestionId).status).toBe('stale');
  });
});

describe('retomada persistente', () => {
  it('retoma apenas o locutor ainda não analisado depois de falha', async () => {
    const { projectId, storage } = fixture({ twoPending: true });
    let calls = 0;
    const firstDeps = dependencies(async (args: any) => {
      calls += 1;
      const segmentId = targetIdFromPrompt(String(args.contents[0].text));
      if (calls === 2) { const error: any = new Error('queda simulada'); error.retryable = false; throw error; }
      return { text: JSON.stringify({ suggestions: [{ segmentId, suggestedSpeakerId: 'char_mara', confidence: .9, reason: 'Primeiro.', evidence: [] }] }) };
    });
    const firstApp = appFor(storage, firstDeps);
    await request(firstApp).post(`/api/projects/${projectId}/script-review/pending-speakers/start`).send({}).expect(202);
    await waitForStatus(firstApp, projectId, 'pending-speakers', 'failed');
    expect(readScriptContextReviewJob(storage, projectId, 'pending_speakers')?.completedWorkItemIds).toHaveLength(1);

    resetScriptContextReviewRuntimeForTests();
    let resumedCalls = 0;
    const resumedDeps = dependencies(async (args: any) => {
      resumedCalls += 1;
      const segmentId = targetIdFromPrompt(String(args.contents[0].text));
      return { text: JSON.stringify({ suggestions: [{ segmentId, suggestedSpeakerId: 'char_ivo', confidence: .8, reason: 'Segundo.', evidence: [] }] }) };
    });
    const resumedApp = appFor(storage, resumedDeps);
    await request(resumedApp).post(`/api/projects/${projectId}/script-review/pending-speakers/start`).send({}).expect(202);
    const completed = await waitForStatus(resumedApp, projectId, 'pending-speakers', 'completed');
    expect(resumedCalls).toBe(1);
    expect(completed.job.completedWorkItemIds).toHaveLength(2);
  });
});
