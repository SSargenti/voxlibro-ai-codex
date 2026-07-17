import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preserveCharacterEdits, withCharacterEditPreservation } from './src/characterAnalysisPreservation';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('preservação editorial da Bíblia', () => {
  it('mantém a voz escolhida mesmo quando a recomendação automática muda', () => {
    const preserved = preserveCharacterEdits([
      { characterId: 'char_mara', canonicalName: 'Mara', voiceAssignmentId: 'gcp:pt-BR-Wavenet-D', voiceAssignment: { providerId: 'gcp', voiceName: 'pt-BR-Wavenet-D' } },
    ], [
      { characterId: 'char_mara', canonicalName: 'Mara', voiceAssignmentId: 'gcp:pt-BR-Neural2-A', role: 'main' },
    ]);

    expect(preserved[0].voiceAssignmentId).toBe('gcp:pt-BR-Wavenet-D');
    expect(preserved[0].voiceAssignment.voiceName).toBe('pt-BR-Wavenet-D');
  });

  it('mantém integralmente nome, aliases, descrição e perfil quando o personagem está bloqueado', () => {
    const preserved = preserveCharacterEdits([
      {
        characterId: 'char_mara', canonicalName: 'Comandante Mara', aliases: ['Mara'], role: 'protagonist',
        description: 'Perfil revisado pelo usuário', personality: ['Resoluta'], speechStyle: { pace: 'slow', timbre: 'firm' },
        genderPresentation: 'female', estimatedAge: 'mature', locked: true, voiceAssignmentId: 'gcp:pt-BR-Wavenet-C',
      },
    ], [
      {
        characterId: 'char_mara', canonicalName: 'Mara', aliases: [], role: 'supporting', description: 'Gerado novamente',
        personality: ['Nova'], speechStyle: { pace: 'fast' }, locked: false, voiceAssignmentId: 'gcp:pt-BR-Neural2-A',
      },
    ]);

    expect(preserved[0]).toMatchObject({
      canonicalName: 'Comandante Mara', aliases: ['Mara'], role: 'protagonist', description: 'Perfil revisado pelo usuário',
      personality: ['Resoluta'], speechStyle: { pace: 'slow', timbre: 'firm' }, locked: true,
      voiceAssignmentId: 'gcp:pt-BR-Wavenet-C',
    });
  });

  it('aplica a proteção ao arquivo consolidado e atualiza o nome nos avistamentos', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxlibro-preservation-'));
    roots.push(root);
    const projectId = 'stage_project';
    const bibleDir = path.join(root, projectId, 'narrative-bible');
    fs.mkdirSync(bibleDir, { recursive: true });
    fs.writeFileSync(path.join(bibleDir, 'characters.json'), JSON.stringify([
      { characterId: 'char_mara', canonicalName: 'Mara Revisada', aliases: ['Mara'], locked: true, voiceAssignmentId: 'gcp:pt-BR-Wavenet-B' },
    ], null, 2));

    const analyzer = vi.fn().mockResolvedValue({
      characters: [{ characterId: 'char_mara', canonicalName: 'Mara', aliases: [], locked: false, voiceAssignmentId: 'gcp:pt-BR-Neural2-A' }],
      sightings: [{ characterId: 'char_mara', canonicalName: 'Mara', chapterId: 'chapter_1' }],
      mergeSuggestions: [],
    });
    const wrapped = withCharacterEditPreservation(() => ({ projectsRoot: root }), analyzer);
    const result = await wrapped(projectId, false, false);

    expect(result.characters[0].canonicalName).toBe('Mara Revisada');
    expect(result.characters[0].voiceAssignmentId).toBe('gcp:pt-BR-Wavenet-B');
    expect(result.sightings[0].canonicalName).toBe('Mara Revisada');
    expect(JSON.parse(fs.readFileSync(path.join(bibleDir, 'characters.json'), 'utf8'))[0].locked).toBe(true);
  });
});
