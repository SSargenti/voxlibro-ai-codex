import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enforceAudiobookNarrationPolicy,
  registerAudiobookNarrationPolicy,
  withAudiobookContextReviewPolicy,
  type AudiobookNarrationStorage,
} from './src/audiobookNarrationPolicy';
import { registerAudiobookNarrationPolicyRoutes } from './src/audiobookNarrationPolicyRoutes';

const tempDirs: string[] = [];

function fixture(mode = 'audiobook') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxlibro-audiobook-policy-'));
  tempDirs.push(root);
  const projectsRoot = path.join(root, 'projects');
  const projectId = 'proj_audiobook_policy';
  const projectDir = path.join(projectsRoot, projectId);
  fs.mkdirSync(path.join(projectDir, 'normalized'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'narrative-bible'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'scripts', 'tts-input'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'audio', 'segments'), { recursive: true });
  const projectsDbFile = path.join(projectsRoot, 'projects.json');
  fs.writeFileSync(projectsDbFile, JSON.stringify([{
    projectId,
    name: 'Livro de teste',
    status: 'scripting',
    productionMode: mode,
    updatedAt: new Date().toISOString(),
  }], null, 2));
  fs.writeFileSync(path.join(projectDir, 'normalized', 'chapters.json'), JSON.stringify([{
    chapterId: 'chapter_001',
    title: 'Capítulo 1',
    originalText: 'Capítulo 1\n— Pare agora!\nA porta se fechou.',
  }], null, 2));
  fs.writeFileSync(path.join(projectDir, 'narrative-bible', 'characters.json'), JSON.stringify([
    { characterId: 'char_narrator', canonicalName: 'Narrador', role: 'narrator', voiceAssignmentId: 'gcp:pt-BR-Wavenet-B' },
    { characterId: 'char_mara', canonicalName: 'Mara', role: 'main', voiceAssignmentId: 'gcp:pt-BR-Wavenet-A' },
  ], null, 2));
  const units = [
    { sourceUnitId: 'su_chapter_001_1', chapterId: 'chapter_001', order: 1, sourceText: 'Capítulo 1', offsets: { start: 0, end: 10 }, type: 'título' },
    { sourceUnitId: 'su_chapter_001_2', chapterId: 'chapter_001', order: 2, sourceText: '— Pare agora!', offsets: { start: 11, end: 24 }, type: 'fala' },
    { sourceUnitId: 'su_chapter_001_3', chapterId: 'chapter_001', order: 3, sourceText: 'A porta se fechou.', offsets: { start: 25, end: 43 }, type: 'parágrafo' },
  ];
  fs.writeFileSync(path.join(projectDir, 'scripts', 'source-units.jsonl'), `${units.map(unit => JSON.stringify(unit)).join('\n')}\n`);
  const segments = [
    { segmentId: 'seg_1', projectId, chapterId: 'chapter_001', sourceUnitId: units[0].sourceUnitId, order: 1, type: 'título', speakerId: 'char_narrator', originalText: units[0].sourceText, spokenText: units[0].sourceText, direction: { emotion: 'solene', intensity: 0.4, pace: 'slow', pauseAfterMs: 500 }, status: 'pending' },
    { segmentId: 'seg_2', projectId, chapterId: 'chapter_001', sourceUnitId: units[1].sourceUnitId, order: 2, type: 'fala', speakerId: 'char_mara', originalText: units[1].sourceText, spokenText: 'Pare agora!', direction: { emotion: 'urgente', intensity: 0.9, pace: 'fast', pauseAfterMs: 180 }, status: 'ready', audioPath: '/api/audio/seg_2.wav' },
    { segmentId: 'seg_3', projectId, chapterId: 'chapter_001', sourceUnitId: units[2].sourceUnitId, order: 3, type: 'parágrafo', speakerId: 'unresolved', originalText: units[2].sourceText, spokenText: units[2].sourceText, direction: { emotion: 'tenso', intensity: 0.6, pace: 'normal', pauseAfterMs: 320 }, status: 'pending' },
  ];
  fs.writeFileSync(path.join(projectDir, 'scripts', 'segments.json'), JSON.stringify(segments, null, 2));
  fs.writeFileSync(path.join(projectDir, 'scripts', 'segments.jsonl'), `${segments.map(segment => JSON.stringify(segment)).join('\n')}\n`);
  fs.writeFileSync(path.join(projectDir, 'audio', 'segments', 'seg_2.wav'), Buffer.from('fake-audio'));
  fs.writeFileSync(path.join(projectDir, 'scripts', 'review-suggestions.json'), JSON.stringify([
    {
      suggestionId: 'pending-speaker', mode: 'pending_speakers', status: 'pending', segmentId: 'seg_3',
      suggested: { speakerId: 'char_mara' }, reason: 'Sugestão antiga.',
    },
    {
      suggestionId: 'audit-direction', mode: 'final_audit', status: 'pending', segmentId: 'seg_2',
      suggested: { speakerId: 'char_mara', direction: { emotion: 'furioso', intensity: 1 } }, reason: 'A cena exige mais tensão.',
    },
    {
      suggestionId: 'audit-speaker-only', mode: 'final_audit', status: 'pending', segmentId: 'seg_2',
      suggested: { speakerId: 'char_mara' }, reason: 'Trocar voz.',
    },
  ], null, 2));
  return {
    projectId,
    projectDir,
    storage: { projectsRoot, projectsDbFile } satisfies AudiobookNarrationStorage,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('política de narrador único para audiolivro', () => {
  it('converte todos os trechos para o narrador, preserva direção e invalida somente áudio incompatível', () => {
    const { projectId, projectDir, storage } = fixture();
    const result = enforceAudiobookNarrationPolicy(storage, projectId);

    expect(result.audiobook).toBe(true);
    expect(result.changedSegmentIds).toEqual(expect.arrayContaining(['seg_2', 'seg_3']));
    expect(result.segments?.every(segment => segment.speakerId === 'char_narrator')).toBe(true);
    const dialogue = result.segments?.find(segment => segment.segmentId === 'seg_2');
    expect(dialogue.direction).toEqual({ emotion: 'urgente', intensity: 0.9, pace: 'fast', pauseAfterMs: 180 });
    expect(dialogue.portrayedSpeakerId).toBe('char_mara');
    expect(dialogue.performanceContext).toMatchObject({ mode: 'single_narrator', delivery: 'character_dialogue', portrayedSpeakerId: 'char_mara' });
    expect(dialogue.status).toBe('pending');
    expect(fs.existsSync(path.join(projectDir, 'audio', 'segments', 'seg_2.wav'))).toBe(false);
    expect(result.scriptReport).toMatchObject({ coverage: 100, totalUnresolved: 0, scriptComplete: true, status: 'PASS' });
    expect(result.finalReport).toMatchObject({ status: 'REVIEW', narrationMode: 'single_narrator', pendingFinalAuditSuggestions: 1 });
    expect(result.project?.status).toBe('scripting');
  });

  it('remove sugestões de troca de voz e mantém ajustes de interpretação', () => {
    const { projectId, projectDir, storage } = fixture();
    const result = enforceAudiobookNarrationPolicy(storage, projectId);
    expect(result.sanitizedSuggestions).toBeGreaterThanOrEqual(3);
    const suggestions = JSON.parse(fs.readFileSync(path.join(projectDir, 'scripts', 'review-suggestions.json'), 'utf8'));
    expect(suggestions.find((item: any) => item.suggestionId === 'pending-speaker').status).toBe('superseded');
    expect(suggestions.find((item: any) => item.suggestionId === 'audit-speaker-only').status).toBe('superseded');
    const direction = suggestions.find((item: any) => item.suggestionId === 'audit-direction');
    expect(direction.status).toBe('pending');
    expect(direction.suggested.speakerId).toBeUndefined();
    expect(direction.suggested.direction).toEqual({ emotion: 'furioso', intensity: 1 });
  });

  it('não altera projetos de audionovela', () => {
    const { projectId, storage } = fixture('audiodrama');
    const result = enforceAudiobookNarrationPolicy(storage, projectId);
    expect(result.audiobook).toBe(false);
    const segments = JSON.parse(fs.readFileSync(path.join(storage.projectsRoot, projectId, 'scripts', 'segments.json'), 'utf8'));
    expect(segments.find((segment: any) => segment.segmentId === 'seg_2').speakerId).toBe('char_mara');
  });

  it('reforça a regra depois de uma rota tentar trocar o locutor', async () => {
    const { projectId, storage } = fixture();
    const app = express();
    app.use(express.json());
    registerAudiobookNarrationPolicy(app, () => storage);
    app.post('/api/projects/:projectId/script-generation/mock-edit', (req, res) => {
      const filePath = path.join(storage.projectsRoot, req.params.projectId, 'scripts', 'segments.json');
      const segments = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      segments[0].speakerId = 'char_mara';
      fs.writeFileSync(filePath, JSON.stringify(segments, null, 2));
      res.json({ segments });
    });

    const response = await request(app).post(`/api/projects/${projectId}/script-generation/mock-edit`).send({}).expect(200);
    expect(response.body.segments.every((segment: any) => segment.speakerId === 'char_narrator')).toBe(true);
  });

  it('expõe uma rota explícita para corrigir edições feitas por rotas legadas', async () => {
    const { projectId, storage } = fixture();
    const app = express();
    registerAudiobookNarrationPolicyRoutes(app, () => storage);
    const response = await request(app).post(`/api/projects/${projectId}/audiobook-narration-policy/enforce`).expect(200);
    expect(response.body.audiobook).toBe(true);
    expect(response.body.segments.every((segment: any) => segment.speakerId === 'char_narrator')).toBe(true);
  });
});

describe('auditoria contextual do audiolivro', () => {
  it('instrui o Sol a manter a voz e elimina propostas de troca de locutor', async () => {
    const base = vi.fn(async (args: any) => ({
      text: JSON.stringify({
        issues: [
          { segmentId: 'seg_1', category: 'speaker_continuity', suggestedSpeakerId: 'char_mara', confidence: 0.98, reason: 'Trocar voz.' },
          { segmentId: 'seg_2', category: 'direction_consistency', suggestedSpeakerId: 'char_mara', suggestedDirection: { emotion: 'urgente', intensity: 0.9 }, confidence: 0.95, reason: 'Ajustar interpretação.' },
        ],
      }),
    }));
    const wrapped = withAudiobookContextReviewPolicy(base);
    const response = await wrapped({
      contents: [{ text: 'AUDITORIA CONTEXTUAL FINAL DO ROTEIRO\nCONTEXTO: [{"segmentId":"seg_1","speakerId":"char_narrator"},{"segmentId":"seg_2","speakerId":"char_narrator"}]' }],
    });

    const sentPrompt = JSON.stringify(base.mock.calls[0][0].contents);
    expect(sentPrompt).toContain('MODO AUDIOLIVRO COM NARRADOR ÚNICO');
    const parsed = JSON.parse(response.text);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].suggestedSpeakerId).toBeUndefined();
    expect(parsed.issues[0].suggestedDirection).toEqual({ emotion: 'urgente', intensity: 0.9 });
  });
});
