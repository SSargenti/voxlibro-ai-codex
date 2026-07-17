import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import {
  createProjectBackupBuffer,
  PROJECT_BACKUP_MANIFEST,
  restoreProjectBackupBuffer,
} from './src/projectBackup';

const temporaryRoots: string[] = [];

function makeStorage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxlibro-backup-'));
  temporaryRoots.push(root);
  const projectsRoot = path.join(root, 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
  const projectsDbFile = path.join(projectsRoot, 'projects.json');
  fs.writeFileSync(projectsDbFile, '[]');
  return { projectsRoot, projectsDbFile };
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('backup e restauração de projetos VoxLibro', () => {
  it('preserva obra, elenco e roteiro, mas restaura os áudios como pendentes', () => {
    const storage = makeStorage();
    const originalId = 'proj_original';
    const projectDir = path.join(storage.projectsRoot, originalId);

    writeJson(storage.projectsDbFile, [{
      projectId: originalId,
      ownerId: 'local-owner',
      name: 'Aurora',
      userTitle: 'Aurora',
      status: 'reviewing',
      productionMode: 'audiodrama',
      selectedProductionMode: 'audiodrama',
      sourceLanguage: 'en',
      targetLanguage: 'pt-BR',
      translationEnabled: true,
      wordCount: 1234,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }]);

    fs.mkdirSync(path.join(projectDir, 'source'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'source', 'book.epub'), Buffer.from('PK\u0003\u0004source'));
    writeJson(path.join(projectDir, 'normalized', 'chapters.json'), [{
      chapterId: 'ch_1', order: 1, title: 'Capítulo 1', originalText: 'Original', translatedText: 'Traduzido', status: 'translated',
    }]);
    writeJson(path.join(projectDir, 'narrative-bible', 'characters.json'), [{
      characterId: 'char_1', canonicalName: 'Lia', voiceAssignmentId: 'gcp:pt-BR-Wavenet-A',
    }]);
    writeJson(path.join(projectDir, 'scripts', 'segments.json'), [{
      segmentId: 'seg_1', order: 1, chapterId: 'ch_1', speakerId: 'char_1', spokenText: 'Texto aprovado',
      status: 'ready', audioPath: `/projects/${originalId}/audio/segments/seg_1.wav`, durationMs: 900, audioSize: 2000,
    }]);
    fs.mkdirSync(path.join(projectDir, 'audio', 'segments'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'audio', 'segments', 'seg_1.wav'), Buffer.alloc(2048));

    const backup = createProjectBackupBuffer(originalId, storage);
    const archive = new AdmZip(backup.buffer);

    expect(archive.getEntry(PROJECT_BACKUP_MANIFEST)).toBeTruthy();
    expect(archive.getEntry('project/scripts/segments.json')).toBeTruthy();
    expect(archive.getEntry('project/audio/segments/seg_1.wav')).toBeNull();
    expect(backup.manifest.resumeStep).toBe('audio');

    const restored = restoreProjectBackupBuffer(backup.buffer, storage);
    const restoredDir = path.join(storage.projectsRoot, restored.project.projectId);
    const segments = JSON.parse(fs.readFileSync(path.join(restoredDir, 'scripts', 'segments.json'), 'utf8'));
    const characters = JSON.parse(fs.readFileSync(path.join(restoredDir, 'narrative-bible', 'characters.json'), 'utf8'));

    expect(restored.resumeStep).toBe('audio');
    expect(restored.project.status).toBe('generating_audio');
    expect(restored.project.name).toBe('Aurora');
    expect(restored.project.wordCount).toBe(1234);
    expect(restored.project.projectId).not.toBe(originalId);
    expect(restored.project.restoredFromProjectId).toBe(originalId);
    expect(segments).toHaveLength(1);
    expect(segments[0].spokenText).toBe('Texto aprovado');
    expect(segments[0].speakerId).toBe('char_1');
    expect(segments[0].status).toBe('pending');
    expect(segments[0].audioPath).toBeUndefined();
    expect(segments[0].durationMs).toBeUndefined();
    expect(characters[0].voiceAssignmentId).toBe('gcp:pt-BR-Wavenet-A');
    expect(fs.existsSync(path.join(restoredDir, 'source', 'book.epub'))).toBe(true);

    const projects = JSON.parse(fs.readFileSync(storage.projectsDbFile, 'utf8'));
    expect(projects.some((project: any) => project.projectId === restored.project.projectId)).toBe(true);
  });

  it('rejeita pacote adulterado pelo checksum', () => {
    const storage = makeStorage();
    const originalId = 'proj_checksum';
    const projectDir = path.join(storage.projectsRoot, originalId);
    writeJson(storage.projectsDbFile, [{ projectId: originalId, name: 'Checksum', status: 'generating_audio' }]);
    writeJson(path.join(projectDir, 'scripts', 'segments.json'), [{ segmentId: 'seg_1', spokenText: 'Texto', status: 'pending' }]);

    const backup = createProjectBackupBuffer(originalId, storage);
    const archive = new AdmZip(backup.buffer);
    archive.updateFile('project/scripts/segments.json', Buffer.from('[{"segmentId":"alterado"}]'));

    expect(() => restoreProjectBackupBuffer(archive.toBuffer(), storage)).toThrow(/integridade/i);
  });
});
