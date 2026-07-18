import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerVoiceScriptPersistenceRoutes,
  saveScriptSegment,
  saveVoiceAssignments,
  type VoiceScriptStorage,
} from './src/voiceScriptPersistence';

const tempDirs: string[] = [];

function fixture(mode = 'audiodrama') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxlibro-voice-script-'));
  tempDirs.push(root);
  const projectsRoot = path.join(root, 'projects');
  const projectId = 'proj_voice_script';
  const projectDir = path.join(projectsRoot, projectId);
  fs.mkdirSync(path.join(projectDir, 'normalized'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'narrative-bible'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'scripts', 'tts-input'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'audio', 'segments'), { recursive: true });
  const projectsDbFile = path.join(projectsRoot, 'projects.json');
  fs.writeFileSync(projectsDbFile, JSON.stringify([{
    projectId,
    name: 'Livro de teste',
    status: 'generating_audio',
    productionMode: mode,
    updatedAt: new Date().toISOString(),
  }], null, 2));
  const chapters = [{ chapterId: 'chapter_001', title: 'Capítulo 1', originalText: 'Capítulo 1\n— Olá.\nA noite caiu.' }];
  fs.writeFileSync(path.join(projectDir, 'normalized', 'chapters.json'), JSON.stringify(chapters, null, 2));
  const characters = [
    {
      characterId: 'char_narrator', canonicalName: 'Narrador', role: 'narrator', aliases: ['Voz'], description: 'Descrição preservada',
      voiceAssignmentId: 'gcp:pt-BR-Wavenet-B', voiceAssignment: { providerId: 'gcp', voiceName: 'pt-BR-Wavenet-B' },
    },
    {
      characterId: 'char_mara', canonicalName: 'Mara', role: 'main', aliases: ['Dra. Mara'], description: 'Médica da estação',
      voiceAssignmentId: 'gcp:pt-BR-Wavenet-A', voiceAssignment: { providerId: 'gcp', voiceName: 'pt-BR-Wavenet-A' },
    },
  ];
  fs.writeFileSync(path.join(projectDir, 'narrative-bible', 'characters.json'), JSON.stringify(characters, null, 2));
  const units = [
    { sourceUnitId: 'su_chapter_001_1', chapterId: 'chapter_001', order: 1, sourceText: 'Capítulo 1', offsets: { start: 0, end: 10 }, type: 'título' },
    { sourceUnitId: 'su_chapter_001_2', chapterId: 'chapter_001', order: 2, sourceText: '— Olá.', offsets: { start: 11, end: 18 }, type: 'fala' },
    { sourceUnitId: 'su_chapter_001_3', chapterId: 'chapter_001', order: 3, sourceText: 'A noite caiu.', offsets: { start: 19, end: 32 }, type: 'parágrafo' },
  ];
  fs.writeFileSync(path.join(projectDir, 'scripts', 'source-units.jsonl'), `${units.map(unit => JSON.stringify(unit)).join('\n')}\n`);
  const segments = [
    { segmentId: 'seg_1', projectId, chapterId: 'chapter_001', sourceUnitId: units[0].sourceUnitId, order: 1, type: 'título', speakerId: 'char_narrator', originalText: units[0].sourceText, spokenText: units[0].sourceText, direction: { emotion: 'solene', intensity: .4, pace: 'slow', pauseAfterMs: 500 }, status: 'ready', audioPath: `/projects/${projectId}/audio/segments/seg_1.wav` },
    { segmentId: 'seg_2', projectId, chapterId: 'chapter_001', sourceUnitId: units[1].sourceUnitId, order: 2, type: 'fala', speakerId: mode === 'audiobook' ? 'char_narrator' : 'char_mara', originalText: units[1].sourceText, spokenText: 'Olá.', direction: { emotion: 'calma', intensity: .5, pace: 'normal', pauseAfterMs: 250 }, status: 'ready', audioPath: `/projects/${projectId}/audio/segments/seg_2.wav` },
    { segmentId: 'seg_3', projectId, chapterId: 'chapter_001', sourceUnitId: units[2].sourceUnitId, order: 3, type: 'parágrafo', speakerId: 'char_narrator', originalText: units[2].sourceText, spokenText: units[2].sourceText, direction: { emotion: 'tensa', intensity: .6, pace: 'normal', pauseAfterMs: 300 }, status: 'ready', audioPath: `/projects/${projectId}/audio/segments/seg_3.wav` },
  ];
  fs.writeFileSync(path.join(projectDir, 'scripts', 'segments.json'), JSON.stringify(segments, null, 2));
  fs.writeFileSync(path.join(projectDir, 'scripts', 'segments.jsonl'), `${segments.map(segment => JSON.stringify(segment)).join('\n')}\n`);
  for (const segment of segments) fs.writeFileSync(path.join(projectDir, 'audio', 'segments', `${segment.segmentId}.wav`), Buffer.from('fake'));
  fs.writeFileSync(path.join(projectDir, 'scripts', 'review-suggestions.json'), JSON.stringify([{
    suggestionId: 'suggestion_seg_2', segmentId: 'seg_2', mode: 'final_audit', status: 'pending', reason: 'Ajustar interpretação.', suggested: { direction: { emotion: 'feliz' } },
  }], null, 2));
  return {
    projectId,
    projectDir,
    storage: { projectsRoot, projectsDbFile } satisfies VoiceScriptStorage,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('persistência de atribuição de voz', () => {
  it('salva somente a voz, preserva a Bíblia e invalida apenas os trechos do personagem', () => {
    const { projectId, projectDir, storage } = fixture();
    const result = saveVoiceAssignments(storage, projectId, {
      assignments: [{ characterId: 'char_mara', voiceAssignmentId: 'gemini:Kore' }],
    });

    const mara = result.characters.find((character: any) => character.characterId === 'char_mara');
    expect(mara).toMatchObject({
      canonicalName: 'Mara', aliases: ['Dra. Mara'], description: 'Médica da estação',
      voiceAssignmentId: 'gemini:Kore', voiceAssignment: { providerId: 'gemini', voiceName: 'Kore' },
    });
    expect(result.affectedSegmentIds).toEqual(['seg_2']);
    expect(fs.existsSync(path.join(projectDir, 'audio', 'segments', 'seg_1.wav'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'audio', 'segments', 'seg_2.wav'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'audio', 'segments', 'seg_3.wav'))).toBe(true);
    const segments = JSON.parse(fs.readFileSync(path.join(projectDir, 'scripts', 'segments.json'), 'utf8'));
    const changed = segments.find((segment: any) => segment.segmentId === 'seg_2');
    expect(changed.status).toBe('pending');
    expect(Object.prototype.hasOwnProperty.call(changed, 'audioPath')).toBe(false);
  });

  it('no audiolivro, uma mudança da voz do narrador invalida todos os trechos', () => {
    const { projectId, projectDir, storage } = fixture('audiobook');
    const result = saveVoiceAssignments(storage, projectId, {
      assignments: [{ characterId: 'char_narrator', voiceAssignmentId: 'gcp:pt-BR-Neural2-B' }],
    });
    expect(result.affectedSegmentIds).toEqual(['seg_1', 'seg_2', 'seg_3']);
    expect(fs.readdirSync(path.join(projectDir, 'audio', 'segments'))).toHaveLength(0);
  });
});

describe('persistência da correção do roteiro', () => {
  it('salva texto e locutor em todos os artefatos e invalida somente o áudio do trecho', () => {
    const { projectId, projectDir, storage } = fixture();
    const result = saveScriptSegment(storage, projectId, 'seg_2', {
      spokenText: 'Olá, comandante.', speakerId: 'char_narrator', direction: { emotion: 'firme', intensity: .8 },
    });

    expect(result.segment).toMatchObject({ spokenText: 'Olá, comandante.', speakerId: 'char_narrator', status: 'pending', manuallyReviewed: true });
    expect(result.segment.direction).toMatchObject({ emotion: 'firme', intensity: .8, pace: 'normal' });
    expect(fs.readFileSync(path.join(projectDir, 'scripts', 'tts-input', 'seg_2.txt'), 'utf8')).toBe('Olá, comandante.');
    expect(fs.existsSync(path.join(projectDir, 'audio', 'segments', 'seg_2.wav'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, 'audio', 'segments', 'seg_1.wav'))).toBe(true);
    const jsonl = fs.readFileSync(path.join(projectDir, 'scripts', 'segments.jsonl'), 'utf8');
    expect(jsonl).toContain('Olá, comandante.');
    const suggestions = JSON.parse(fs.readFileSync(path.join(projectDir, 'scripts', 'review-suggestions.json'), 'utf8'));
    expect(suggestions[0].status).toBe('stale');
  });

  it('mantém narrador único no audiolivro, mas registra o personagem interpretado', () => {
    const { projectId, storage } = fixture('audiobook');
    const result = saveScriptSegment(storage, projectId, 'seg_2', { speakerId: 'char_mara' });
    expect(result.segment.speakerId).toBe('char_narrator');
    expect(result.segment.portrayedSpeakerId).toBe('char_mara');
    expect(result.segment.performanceContext).toMatchObject({ mode: 'single_narrator', portrayedSpeakerId: 'char_mara' });
  });
});

describe('rotas compatíveis', () => {
  it('expõe salvamento persistente por HTTP', async () => {
    const { projectId, storage } = fixture();
    const app = express();
    app.use(express.json());
    registerVoiceScriptPersistenceRoutes(app, () => storage);

    const voice = await request(app).put(`/api/projects/${projectId}/voice-assignments`).send({ assignments: [{ characterId: 'char_mara', voiceAssignmentId: 'gemini:Puck' }] }).expect(200);
    expect(voice.body.characters.find((character: any) => character.characterId === 'char_mara').voiceAssignmentId).toBe('gemini:Puck');

    const segment = await request(app).put(`/api/projects/${projectId}/script-segments/seg_2`).send({ spokenText: 'Texto corrigido.' }).expect(200);
    expect(segment.body.segment.spokenText).toBe('Texto corrigido.');
  });
});
