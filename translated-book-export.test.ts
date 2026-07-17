import AdmZip from 'adm-zip';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTranslatedBookArtifacts,
  registerTranslatedBookRoutes,
  type TranslatedBookStorage,
} from './src/translatedBookExport';

const tempDirs: string[] = [];

function fixture(options?: {
  sourceLanguage?: string;
  translationEnabled?: boolean;
  chapters?: any[];
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxlibro-translated-book-'));
  tempDirs.push(root);
  const projectsRoot = path.join(root, 'projects');
  const projectId = 'proj_translation_test';
  const projectDir = path.join(projectsRoot, projectId);
  fs.mkdirSync(path.join(projectDir, 'normalized'), { recursive: true });
  const projectsDbFile = path.join(projectsRoot, 'projects.json');
  fs.writeFileSync(projectsDbFile, JSON.stringify([{
    projectId,
    name: 'The Last Station',
    author: 'Test Author',
    sourceLanguage: options?.sourceLanguage || 'en',
    targetLanguage: 'pt-BR',
    translationEnabled: options?.translationEnabled ?? true,
  }], null, 2));
  const chapters = options?.chapters || [
    {
      chapterId: 'chapter_001',
      order: 1,
      title: 'Capítulo 1',
      originalText: 'The station was silent.\n\nOceanofPDF.com\n\nMara opened the metal door.',
      translatedText: 'A estação estava silenciosa.\n\nOceanofPDF.com\n\nMara abriu a porta de metal.',
    },
    {
      chapterId: 'chapter_002',
      order: 2,
      title: 'Capítulo 2',
      originalText: 'A distant alarm crossed the frozen valley.',
      translatedText: 'Um alarme distante atravessou o vale congelado.',
    },
  ];
  fs.writeFileSync(path.join(projectDir, 'normalized', 'chapters.json'), JSON.stringify(chapters, null, 2));
  return { projectId, projectDir, storage: { projectsRoot, projectsDbFile } satisfies TranslatedBookStorage };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('pipeline do livro traduzido', () => {
  it('gera JSON canônico, TXT integral, TXT para TTS, DOCX e pacote ZIP', () => {
    const { projectId, storage } = fixture();
    const result = buildTranslatedBookArtifacts(projectId, storage);

    expect(result.report.exportReady).toBe(true);
    expect(result.report.summary.chapterCoveragePercent).toBe(100);
    expect(result.report.summary.chapters).toBe(2);
    expect(result.report.summary.excludedUnits).toBe(1);
    expect(result.paths.txt && fs.existsSync(result.paths.txt)).toBe(true);
    expect(result.paths.tts && fs.existsSync(result.paths.tts)).toBe(true);
    expect(result.paths.docx && fs.existsSync(result.paths.docx)).toBe(true);
    expect(result.paths.bundle && fs.existsSync(result.paths.bundle)).toBe(true);

    const text = fs.readFileSync(result.paths.txt!, 'utf8');
    expect(text).toContain('A estação estava silenciosa.');
    expect(text).toContain('Um alarme distante atravessou o vale congelado.');
    expect(text).not.toContain('OceanofPDF.com');

    const canonical = JSON.parse(fs.readFileSync(result.paths.canonicalJson, 'utf8'));
    const excluded = canonical.chapters.flatMap((chapter: any) => chapter.units).find((unit: any) => unit.excludedFromExport);
    expect(excluded.sourceText).toBe('OceanofPDF.com');
    expect(excluded.exclusionReason).toContain('distribuição');
  });

  it('produz um DOCX estruturalmente válido e legível como pacote OOXML', () => {
    const { projectId, storage } = fixture();
    const result = buildTranslatedBookArtifacts(projectId, storage);
    const zip = new AdmZip(result.paths.docx!);
    const entries = zip.getEntries().map(entry => entry.entryName);

    expect(entries).toContain('[Content_Types].xml');
    expect(entries).toContain('word/document.xml');
    expect(entries).toContain('word/styles.xml');
    const documentXml = zip.readAsText('word/document.xml');
    expect(documentXml).toContain('The Last Station');
    expect(documentXml).toContain('A estação estava silenciosa.');
    expect(documentXml).toContain('w:styleId="Heading1"');
  });

  it('bloqueia arquivos finais quando falta tradução de um capítulo', () => {
    const { projectId, storage } = fixture({
      chapters: [
        { chapterId: 'chapter_001', order: 1, title: 'Um', originalText: 'Original first chapter.', translatedText: 'Primeiro capítulo traduzido.' },
        { chapterId: 'chapter_002', order: 2, title: 'Dois', originalText: 'Original second chapter.', translatedText: '' },
      ],
    });
    const result = buildTranslatedBookArtifacts(projectId, storage);

    expect(result.report.exportReady).toBe(false);
    expect(result.report.summary.chapterCoveragePercent).toBe(50);
    expect(result.report.summary.blockingIssues).toBe(1);
    expect(result.paths.txt).toBeUndefined();
    expect(result.report.issues.some(issue => issue.code === 'MISSING_CHAPTER_TRANSLATION')).toBe(true);
  });

  it('bloqueia capítulo extenso copiado sem tradução', () => {
    const original = 'The station remained silent while the warning lights crossed the corridor and every door stayed locked.';
    const { projectId, storage } = fixture({
      chapters: [{ chapterId: 'chapter_001', order: 1, title: 'One', originalText: original, translatedText: original }],
    });
    const result = buildTranslatedBookArtifacts(projectId, storage);

    expect(result.report.exportReady).toBe(false);
    expect(result.report.summary.untranslatedCopyChapters).toBe(1);
    expect(result.report.issues.some(issue => issue.code === 'UNTRANSLATED_CHAPTER_COPY')).toBe(true);
  });

  it('usa o original como produto final quando a obra já está em português', () => {
    const source = 'A estação permaneceu silenciosa.\n\nMara abriu a porta.';
    const { projectId, storage } = fixture({
      sourceLanguage: 'pt-BR',
      chapters: [{ chapterId: 'chapter_001', order: 1, title: 'Capítulo 1', originalText: source }],
    });
    const result = buildTranslatedBookArtifacts(projectId, storage);

    expect(result.report.translationRequired).toBe(false);
    expect(result.report.exportReady).toBe(true);
    expect(fs.readFileSync(result.paths.txt!, 'utf8')).toContain('Mara abriu a porta.');
  });

  it('expõe status, relatório e downloads sem liberar DOCX incompleto', async () => {
    const { projectId, storage } = fixture({
      chapters: [{ chapterId: 'chapter_001', order: 1, title: 'One', originalText: 'A long untranslated source paragraph remains here for validation.', translatedText: '' }],
    });
    const app = express();
    registerTranslatedBookRoutes(app, () => storage);

    const status = await request(app).get(`/api/projects/${projectId}/translated-book/status`).expect(200);
    expect(status.body.ready).toBe(false);
    expect(status.body.formats).toEqual(['json', 'report']);

    await request(app).get(`/api/projects/${projectId}/translated-book/download?format=docx`).expect(409);
    const report = await request(app).get(`/api/projects/${projectId}/translated-book/download?format=report`).expect(200);
    expect(report.headers['content-type']).toContain('application/json');
  });
});
