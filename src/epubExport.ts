import type { Express, NextFunction, Request, Response } from 'express';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import {
  buildTranslatedBookArtifacts,
  type CanonicalTranslatedBook,
  type TranslatedBookBuildResult,
  type TranslatedBookStorage,
} from './translatedBookExport';

const MIMETYPE_PLACEHOLDER = '00000000';
const EPUB_MIMETYPE = 'application/epub+zip';

function xmlEscape(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xhtmlText(value: string) {
  return xmlEscape(value).replace(/\n/g, '<br />');
}

function safeFileStem(value: string) {
  const clean = String(value || 'livro-traduzido')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return clean || 'livro-traduzido';
}

function chapterFileName(index: number) {
  return `chapter-${String(index + 1).padStart(4, '0')}.xhtml`;
}

function renderChapterXhtml(book: CanonicalTranslatedBook, chapterIndex: number) {
  const chapter = book.chapters[chapterIndex];
  const blocks = chapter.units
    .filter(unit => !unit.excludedFromExport && unit.exportText)
    .map(unit => unit.type === 'separator'
      ? `<div class="separator" aria-hidden="true">${xhtmlText(unit.exportText)}</div>`
      : `<p>${xhtmlText(unit.exportText)}</p>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="pt-BR" lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>${xmlEscape(chapter.title || `Capítulo ${chapter.order}`)}</title>
    <link rel="stylesheet" type="text/css" href="../styles/book.css" />
  </head>
  <body epub:type="bodymatter" xmlns:epub="http://www.idpf.org/2007/ops">
    <section epub:type="chapter" id="${xmlEscape(chapter.chapterId)}">
      <h1>${xmlEscape(chapter.title || `Capítulo ${chapter.order}`)}</h1>
      ${blocks}
    </section>
  </body>
</html>`;
}

function renderTitlePage(book: CanonicalTranslatedBook) {
  const author = book.author ? `<p class="author">${xmlEscape(book.author)}</p>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="pt-BR" lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>${xmlEscape(book.title)}</title>
    <link rel="stylesheet" type="text/css" href="styles/book.css" />
  </head>
  <body epub:type="frontmatter" xmlns:epub="http://www.idpf.org/2007/ops">
    <section class="title-page" epub:type="titlepage">
      <h1>${xmlEscape(book.title)}</h1>
      ${author}
      <p class="edition">Edição em português do Brasil preparada pelo VoxLibro AI</p>
    </section>
  </body>
</html>`;
}

function renderNavigation(book: CanonicalTranslatedBook) {
  const items = book.chapters.map((chapter, index) =>
    `<li><a href="text/${chapterFileName(index)}">${xmlEscape(chapter.title || `Capítulo ${chapter.order}`)}</a></li>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="pt-BR" lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>Sumário</title>
    <link rel="stylesheet" type="text/css" href="styles/book.css" />
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Sumário</h1>
      <ol>
        ${items}
      </ol>
    </nav>
    <nav epub:type="landmarks" hidden="hidden">
      <ol>
        <li><a epub:type="titlepage" href="title.xhtml">Página de título</a></li>
        <li><a epub:type="bodymatter" href="text/${chapterFileName(0)}">Início da obra</a></li>
      </ol>
    </nav>
  </body>
</html>`;
}

function renderPackageDocument(book: CanonicalTranslatedBook) {
  const modified = new Date(book.generatedAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const manifestChapters = book.chapters.map((_, index) =>
    `<item id="chapter-${index + 1}" href="text/${chapterFileName(index)}" media-type="application/xhtml+xml"/>`)
    .join('\n    ');
  const spineChapters = book.chapters.map((_, index) => `<itemref idref="chapter-${index + 1}"/>`).join('\n    ');
  const creator = book.author || 'Autor não informado';

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="pt-BR">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:voxlibro:${xmlEscape(book.bookId)}</dc:identifier>
    <dc:title>${xmlEscape(book.title)}</dc:title>
    <dc:creator>${xmlEscape(creator)}</dc:creator>
    <dc:language>pt-BR</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles/book.css" media-type="text/css"/>
    <item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
    ${manifestChapters}
  </manifest>
  <spine>
    <itemref idref="title"/>
    ${spineChapters}
  </spine>
</package>`;
}

const BOOK_CSS = `body {
  margin: 5%;
  font-family: serif;
  line-height: 1.5;
  text-align: justify;
}
h1 {
  margin: 1.5em 0 1em;
  text-align: center;
  page-break-before: always;
}
p {
  margin: 0 0 .85em;
  text-indent: 1.25em;
}
.title-page {
  margin-top: 25%;
  text-align: center;
}
.title-page h1 {
  page-break-before: avoid;
}
.author, .edition {
  text-indent: 0;
  text-align: center;
}
.edition {
  margin-top: 3em;
  font-size: .85em;
}
.separator {
  margin: 1.2em 0;
  text-align: center;
}
nav ol {
  padding-left: 1.5em;
}
nav li {
  margin-bottom: .5em;
}`;

function replaceZipEntryName(buffer: Buffer, previousName: string, nextName: string) {
  const previous = Buffer.from(previousName, 'utf8');
  const next = Buffer.from(nextName, 'utf8');
  if (previous.length !== next.length) throw new Error('Os nomes ZIP substituídos precisam ter o mesmo tamanho.');
  const patched = Buffer.from(buffer);
  let offset = 0;
  let replacements = 0;
  while (offset < patched.length) {
    const index = patched.indexOf(previous, offset);
    if (index < 0) break;
    next.copy(patched, index);
    replacements += 1;
    offset = index + next.length;
  }
  if (replacements < 2) throw new Error('Não foi possível registrar o mimetype nos cabeçalhos ZIP do EPUB.');
  return patched;
}

export function inspectFirstLocalZipEntry(buffer: Buffer) {
  if (buffer.length < 30 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('Arquivo ZIP inválido: cabeçalho local inicial ausente.');
  }
  const method = buffer.readUInt16LE(8);
  const compressedSize = buffer.readUInt32LE(18);
  const fileNameLength = buffer.readUInt16LE(26);
  const extraLength = buffer.readUInt16LE(28);
  const nameStart = 30;
  const dataStart = nameStart + fileNameLength + extraLength;
  const fileName = buffer.subarray(nameStart, nameStart + fileNameLength).toString('utf8');
  return {
    fileName,
    method,
    data: buffer.subarray(dataStart, dataStart + compressedSize),
  };
}

export function createEpub3(book: CanonicalTranslatedBook) {
  if (!book.chapters.length) throw new Error('O EPUB precisa conter ao menos um capítulo.');
  const zip = new AdmZip();

  // adm-zip ordena as entradas na serialização. O marcador alfanumérico fica
  // fisicamente em primeiro lugar e é substituído por "mimetype" mantendo o
  // mesmo tamanho, tanto no cabeçalho local quanto no diretório central.
  zip.addFile(MIMETYPE_PLACEHOLDER, Buffer.from(EPUB_MIMETYPE, 'utf8'));
  const mimetype = zip.getEntry(MIMETYPE_PLACEHOLDER);
  if (!mimetype) throw new Error('Não foi possível criar o arquivo mimetype do EPUB.');
  mimetype.header.method = 0;

  zip.addFile('META-INF/container.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`, 'utf8'));
  zip.addFile('OEBPS/package.opf', Buffer.from(renderPackageDocument(book), 'utf8'));
  zip.addFile('OEBPS/nav.xhtml', Buffer.from(renderNavigation(book), 'utf8'));
  zip.addFile('OEBPS/title.xhtml', Buffer.from(renderTitlePage(book), 'utf8'));
  zip.addFile('OEBPS/styles/book.css', Buffer.from(BOOK_CSS, 'utf8'));
  book.chapters.forEach((_, index) => {
    zip.addFile(`OEBPS/text/${chapterFileName(index)}`, Buffer.from(renderChapterXhtml(book, index), 'utf8'));
  });

  const buffer = replaceZipEntryName(zip.toBuffer(), MIMETYPE_PLACEHOLDER, 'mimetype');
  validateEpub3(buffer, book.chapters.length);
  return buffer;
}

export function validateEpub3(buffer: Buffer, expectedChapters: number) {
  const firstEntry = inspectFirstLocalZipEntry(buffer);
  if (firstEntry.fileName !== 'mimetype') throw new Error('EPUB inválido: mimetype precisa ser a primeira entrada física.');
  if (firstEntry.method !== 0) throw new Error('EPUB inválido: mimetype precisa estar sem compressão.');
  if (firstEntry.data.toString('utf8') !== EPUB_MIMETYPE) throw new Error('EPUB inválido: conteúdo mimetype incorreto.');

  const zip = new AdmZip(buffer);
  const required = ['mimetype', 'META-INF/container.xml', 'OEBPS/package.opf', 'OEBPS/nav.xhtml', 'OEBPS/title.xhtml', 'OEBPS/styles/book.css'];
  for (const file of required) {
    if (!zip.getEntry(file)) throw new Error(`EPUB inválido: arquivo obrigatório ausente (${file}).`);
  }
  const packageDocument = zip.readAsText('OEBPS/package.opf');
  if (!packageDocument.includes('version="3.0"') || !packageDocument.includes('properties="nav"')) {
    throw new Error('EPUB inválido: pacote EPUB 3 ou navegação não declarados corretamente.');
  }
  for (let index = 0; index < expectedChapters; index++) {
    if (!zip.getEntry(`OEBPS/text/${chapterFileName(index)}`)) {
      throw new Error(`EPUB inválido: capítulo ${index + 1} ausente.`);
    }
  }
  return true;
}

function ensureEpubArtifact(result: TranslatedBookBuildResult, storage: TranslatedBookStorage) {
  if (!result.report.exportReady) return undefined;
  const projectDir = path.join(storage.projectsRoot, result.book.projectId);
  const exportsDir = path.join(projectDir, 'translation', 'exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  const filePath = path.join(exportsDir, `${safeFileStem(result.book.title)}.pt-BR.epub`);
  const buffer = createEpub3(result.book);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function enhancedBundle(result: TranslatedBookBuildResult, epubPath: string) {
  const zip = result.paths.bundle && fs.existsSync(result.paths.bundle)
    ? new AdmZip(result.paths.bundle)
    : new AdmZip();
  zip.addLocalFile(epubPath, '', 'livro-traduzido.epub');
  return zip.toBuffer();
}

function appendEpubFormat(body: any) {
  if (!body?.ready || !Array.isArray(body.formats) || body.formats.includes('epub')) return body;
  const formats = [...body.formats];
  const zipIndex = formats.indexOf('zip');
  if (zipIndex >= 0) formats.splice(zipIndex, 0, 'epub');
  else formats.push('epub');
  return { ...body, formats };
}

export function registerEpubExportRoutes(
  app: Express,
  storageProvider: () => TranslatedBookStorage,
) {
  app.use('/api/projects/:projectId/translated-book', (req: Request, res: Response, next: NextFunction) => {
    const statusRequest = req.method === 'GET' && req.path === '/status';
    const rebuildRequest = req.method === 'POST' && req.path === '/rebuild';
    if (statusRequest || rebuildRequest) {
      const originalJson = res.json.bind(res);
      res.json = ((body: any) => originalJson(appendEpubFormat(body))) as Response['json'];
      return next();
    }

    if (req.method !== 'GET' || req.path !== '/download') return next();
    const format = String(req.query.format || '').toLowerCase();
    if (!['epub', 'zip'].includes(format)) return next();

    try {
      const storage = storageProvider();
      const result = buildTranslatedBookArtifacts(req.params.projectId, storage);
      if (!result.report.exportReady) {
        return res.status(409).json({
          error: {
            code: 'TRANSLATION_NOT_COMPLETE',
            message: 'A tradução ainda possui problemas bloqueantes. Consulte o relatório de qualidade.',
            report: result.report,
          },
        });
      }
      const epubPath = ensureEpubArtifact(result, storage);
      if (!epubPath) throw new Error('O EPUB não foi gerado.');
      const stem = safeFileStem(result.book.title);
      res.setHeader('Cache-Control', 'no-store');

      if (format === 'epub') {
        res.setHeader('Content-Type', 'application/epub+zip');
        return res.download(epubPath, `${stem}.pt-BR.epub`);
      }

      res.setHeader('Content-Type', 'application/zip');
      res.attachment(`${stem}.traducao-voxlibro.zip`);
      return res.send(enhancedBundle(result, epubPath));
    } catch (error: any) {
      return res.status(400).json({
        error: {
          code: 'EPUB_EXPORT_FAILED',
          message: error?.message || 'Não foi possível gerar o EPUB.',
        },
      });
    }
  });
}
