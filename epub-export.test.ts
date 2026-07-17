import AdmZip from 'adm-zip';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createEpub3, inspectFirstLocalZipEntry, registerEpubExportRoutes, validateEpub3 } from './src/epubExport';
import { buildTranslatedBookArtifacts, registerTranslatedBookRoutes, type TranslatedBookStorage } from './src/translatedBookExport';

const tempDirs: string[] = [];

function binaryParser(res: any, callback: (error: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
  res.on('error', (error: Error) => callback(error));
}

function fixture(complete = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxlibro-epub-'));
  tempDirs.push(root);
  const projectsRoot = path.join(root, 'projects');
  const projectId = 'proj_epub_test';
  const projectDir = path.join(projectsRoot, projectId);
  fs.mkdirSync(path.join(projectDir, 'normalized'), { recursive: true });
  const projectsDbFile = path.join(projectsRoot, 'projects.json');
  fs.writeFileSync(projectsDbFile, JSON.stringify([{
    projectId,
    name: 'A Última Estação',
    author: 'Autora de Teste',
    sourceLanguage: 'en',
    targetLanguage: 'pt-BR',
    translationEnabled: true,
  }], null, 2));
  fs.writeFileSync(path.join(projectDir, 'normalized', 'chapters.json'), JSON.stringify([
    {
      chapterId: 'chapter_001',
      order: 1,
      title: 'Capítulo 1',
      originalText: 'The station was silent.\n\nOceanofPDF.com\n\nMara opened the door.',
      translatedText: complete ? 'A estação estava silenciosa.\n\nOceanofPDF.com\n\nMara abriu a porta.' : '',
    },
    {
      chapterId: 'chapter_002',
      order: 2,
      title: 'Capítulo 2',
      originalText: 'The alarm crossed the valley.',
      translatedText: complete ? 'O alarme atravessou o vale.' : '',
    },
  ], null, 2));
  return {
    projectId,
    storage: { projectsRoot, projectsDbFile } satisfies TranslatedBookStorage,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('exportação EPUB 3', () => {
  it('gera pacote EPUB 3 com mimetype sem compressão, OPF, navegação e um XHTML por capítulo', () => {
    const { projectId, storage } = fixture();
    const result = buildTranslatedBookArtifacts(projectId, storage);
    const buffer = createEpub3(result.book);

    expect(validateEpub3(buffer, 2)).toBe(true);
    const firstEntry = inspectFirstLocalZipEntry(buffer);
    expect(firstEntry.fileName).toBe('mimetype');
    expect(firstEntry.method).toBe(0);
    expect(firstEntry.data.toString('utf8')).toBe('application/epub+zip');

    const zip = new AdmZip(buffer);
    expect(zip.readAsText('META-INF/container.xml')).toContain('OEBPS/package.opf');
    expect(zip.readAsText('OEBPS/package.opf')).toContain('version="3.0"');
    expect(zip.readAsText('OEBPS/package.opf')).toContain('<dc:language>pt-BR</dc:language>');
    expect(zip.readAsText('OEBPS/nav.xhtml')).toContain('Capítulo 2');
    expect(zip.readAsText('OEBPS/text/chapter-0001.xhtml')).toContain('A estação estava silenciosa.');
    expect(zip.readAsText('OEBPS/text/chapter-0001.xhtml')).not.toContain('OceanofPDF.com');
  });

  it('anuncia EPUB no status e entrega arquivo com MIME correto', async () => {
    const { projectId, storage } = fixture();
    const app = express();
    registerEpubExportRoutes(app, () => storage);
    registerTranslatedBookRoutes(app, () => storage);

    const status = await request(app).get(`/api/projects/${projectId}/translated-book/status`).expect(200);
    expect(status.body.formats).toContain('epub');

    const response = await request(app)
      .get(`/api/projects/${projectId}/translated-book/download?format=epub`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    expect(response.headers['content-type']).toContain('application/epub+zip');
    expect(response.headers['content-disposition']).toContain('.pt-BR.epub');
    expect(validateEpub3(response.body as Buffer, 2)).toBe(true);
  });

  it('inclui o EPUB dentro do pacote completo', async () => {
    const { projectId, storage } = fixture();
    const app = express();
    registerEpubExportRoutes(app, () => storage);
    registerTranslatedBookRoutes(app, () => storage);

    const response = await request(app)
      .get(`/api/projects/${projectId}/translated-book/download?format=zip`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200);
    const bundle = new AdmZip(response.body as Buffer);
    const epub = bundle.getEntry('livro-traduzido.epub');
    expect(epub).toBeTruthy();
    expect(validateEpub3(epub!.getData(), 2)).toBe(true);
    expect(bundle.getEntry('livro-traduzido.docx')).toBeTruthy();
    expect(bundle.getEntry('translated-book.json')).toBeTruthy();
  });

  it('não libera EPUB quando a tradução está incompleta', async () => {
    const { projectId, storage } = fixture(false);
    const app = express();
    registerEpubExportRoutes(app, () => storage);
    registerTranslatedBookRoutes(app, () => storage);

    const status = await request(app).get(`/api/projects/${projectId}/translated-book/status`).expect(200);
    expect(status.body.formats).not.toContain('epub');
    await request(app)
      .get(`/api/projects/${projectId}/translated-book/download?format=epub`)
      .expect(409);
  });
});
