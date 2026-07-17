import type { Express, Request, Response } from 'express';
import AdmZip from 'adm-zip';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type TranslatedBookStorage = {
  projectsRoot: string;
  projectsDbFile: string;
};

export type CanonicalUnitStatus =
  | 'translated'
  | 'source_language'
  | 'missing_translation'
  | 'untranslated_copy'
  | 'translation_extra';

export type CanonicalBookUnit = {
  unitId: string;
  chapterId: string;
  chapterOrder: number;
  unitOrder: number;
  type: 'paragraph' | 'separator' | 'translation_extra';
  sourceText: string;
  translatedText: string;
  exportText: string;
  sourceHash: string;
  translatedHash: string;
  status: CanonicalUnitStatus;
  excludedFromExport: boolean;
  exclusionReason?: string;
};

export type CanonicalBookChapter = {
  chapterId: string;
  order: number;
  title: string;
  sourceText: string;
  translatedText: string;
  exportText: string;
  sourceHash: string;
  translatedHash: string;
  status: 'ready' | 'missing_translation' | 'untranslated_copy';
  units: CanonicalBookUnit[];
  structuralAlignment: {
    sourceUnits: number;
    translatedUnits: number;
    alignedUnits: number;
    percent: number;
  };
};

export type TranslatedBookIssue = {
  severity: 'blocking' | 'warning' | 'info';
  code: string;
  chapterId?: string;
  unitId?: string;
  message: string;
};

export type TranslatedBookReport = {
  version: 1;
  projectId: string;
  generatedAt: string;
  exportReady: boolean;
  translationRequired: boolean;
  summary: {
    chapters: number;
    readyChapters: number;
    missingChapters: number;
    untranslatedCopyChapters: number;
    sourceUnits: number;
    translatedUnits: number;
    excludedUnits: number;
    chapterCoveragePercent: number;
    structuralAlignmentPercent: number;
    blockingIssues: number;
    warnings: number;
  };
  hashes: {
    sourceSha256: string;
    translatedSha256: string;
    canonicalSha256: string;
  };
  issues: TranslatedBookIssue[];
};

export type CanonicalTranslatedBook = {
  schema: 'voxlibro.translated-book';
  schemaVersion: 1;
  bookId: string;
  projectId: string;
  title: string;
  author?: string;
  sourceLanguage: string;
  targetLanguage: string;
  translationRequired: boolean;
  generatedAt: string;
  chapters: CanonicalBookChapter[];
  report: TranslatedBookReport;
};

export type TranslatedBookBuildResult = {
  book: CanonicalTranslatedBook;
  report: TranslatedBookReport;
  paths: {
    canonicalJson: string;
    reportJson: string;
    txt?: string;
    tts?: string;
    docx?: string;
    bundle?: string;
  };
};

const PROMOTIONAL_LINE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\s*(?:https?:\/\/)?(?:www\.)?oceanofpdf\.com\/?\s*$/i, reason: 'Marca externa de distribuição isolada' },
  { pattern: /^\s*oceanofpdf(?:\.com)?\s*$/i, reason: 'Marca externa de distribuição isolada' },
  { pattern: /^\s*(?:download(?:ed)?\s+(?:this\s+)?(?:book|ebook)\s+(?:from|at)|visit\s+us\s+at)\s+https?:\/\/\S+\s*$/i, reason: 'Linha promocional externa isolada' },
];

function sha256(value: string | Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeText(value: unknown) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function comparisonText(value: unknown) {
  return normalizeText(value)
    .normalize('NFKC')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

function isPortuguese(language?: string) {
  const normalized = String(language || '').toLocaleLowerCase('pt-BR').trim();
  return normalized.startsWith('pt') || normalized.includes('portug') || normalized.includes('brazil');
}

function isSeparator(value: string) {
  const clean = value.trim();
  return clean.length <= 20 && /^(?:[\-*•·—–_=~#]\s*){3,}$/.test(clean);
}

function splitStructuralUnits(text: string) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  return normalized
    .split(/\n\s*\n/g)
    .map(block => block.trim())
    .filter(Boolean);
}

function classifyPromotionalBlock(block: string) {
  const lines = normalizeText(block).split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) return null;
  for (const rule of PROMOTIONAL_LINE_PATTERNS) {
    if (rule.pattern.test(lines[0])) return rule.reason;
  }
  return null;
}

function looksLikeUntranslatedCopy(source: string, translated: string) {
  const sourceComparison = comparisonText(source);
  const translatedComparison = comparisonText(translated);
  if (!sourceComparison || !translatedComparison) return false;
  if (sourceComparison.length < 24) return false;
  return sourceComparison === translatedComparison;
}

function safeProjectId(value: string) {
  const sanitized = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sanitized || sanitized !== value) throw new Error('ID de projeto inválido.');
  return sanitized;
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

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function readProjects(projectsDbFile: string): any[] {
  if (!fs.existsSync(projectsDbFile)) return [];
  const projects = readJson<any[]>(projectsDbFile);
  if (!Array.isArray(projects)) throw new Error('Banco de projetos inválido.');
  return projects;
}

function atomicWrite(filePath: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

function xmlEscape(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function docxParagraph(text: string, style?: 'Title' | 'Heading1' | 'Normal' | 'Separator') {
  const clean = normalizeText(text);
  if (!clean) return '';
  const styleXml = style && style !== 'Normal' ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  const lines = clean.split('\n');
  const runs = lines.map((line, index) => {
    const breakXml = index > 0 ? '<w:br/>' : '';
    return `<w:r>${breakXml}<w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r>`;
  }).join('');
  return `<w:p>${styleXml}${runs}</w:p>`;
}

function createDocx(book: CanonicalTranslatedBook) {
  const zip = new AdmZip();
  const paragraphs: string[] = [docxParagraph(book.title, 'Title')];
  if (book.author) paragraphs.push(docxParagraph(book.author, 'Normal'));

  for (const chapter of book.chapters) {
    paragraphs.push(docxParagraph(chapter.title || `Capítulo ${chapter.order}`, 'Heading1'));
    for (const unit of chapter.units) {
      if (unit.excludedFromExport || !unit.exportText) continue;
      paragraphs.push(docxParagraph(unit.exportText, unit.type === 'separator' ? 'Separator' : 'Normal'));
    }
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphs.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="pt-BR"/></w:rPr><w:pPr><w:spacing w:after="160" w:line="300" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr><w:pPr><w:spacing w:after="360"/><w:jc w:val="center"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:pPr><w:pageBreakBefore/><w:spacing w:before="240" w:after="240"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Separator"><w:name w:val="Separator"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="160" w:after="160"/></w:pPr></w:style>
</w:styles>`;
  const created = new Date().toISOString();
  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(book.title)}</dc:title><dc:creator>VoxLibro AI</dc:creator><dc:language>pt-BR</dc:language><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified></cp:coreProperties>`;

  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`));
  zip.addFile('word/document.xml', Buffer.from(documentXml));
  zip.addFile('word/styles.xml', Buffer.from(stylesXml));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`));
  zip.addFile('docProps/core.xml', Buffer.from(coreXml));
  zip.addFile('docProps/app.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>VoxLibro AI</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><Company>VoxLibro</Company><AppVersion>1.0</AppVersion></Properties>`));
  return zip.toBuffer();
}

function renderBookText(book: CanonicalTranslatedBook, forTts = false) {
  const sections: string[] = [book.title];
  if (!forTts && book.author) sections.push(book.author);
  for (const chapter of book.chapters) {
    const parts: string[] = [chapter.title || `Capítulo ${chapter.order}`];
    for (const unit of chapter.units) {
      if (unit.excludedFromExport || !unit.exportText) continue;
      let text = unit.exportText;
      if (forTts) {
        text = text
          .replace(/https?:\/\/\S+/gi, '')
          .replace(/^\s*(?:copyright|isbn|all rights reserved).*$/gim, '')
          .replace(/[ \t]+/g, ' ')
          .trim();
      }
      if (text) parts.push(text);
    }
    sections.push(parts.join('\n\n'));
  }
  return `${sections.filter(Boolean).join('\n\n')}\n`;
}

function buildChapter(
  chapter: any,
  chapterIndex: number,
  translationRequired: boolean,
  issues: TranslatedBookIssue[],
): CanonicalBookChapter {
  const chapterId = String(chapter?.chapterId || `chapter_${chapterIndex + 1}`);
  const order = Number(chapter?.order || chapterIndex + 1);
  const title = String(chapter?.title || `Capítulo ${order}`).trim();
  const sourceText = normalizeText(chapter?.originalText || '');
  const rawTranslatedText = translationRequired
    ? normalizeText(chapter?.translatedText || '')
    : normalizeText(chapter?.translatedText || sourceText);

  let status: CanonicalBookChapter['status'] = 'ready';
  if (!rawTranslatedText) {
    status = 'missing_translation';
    issues.push({ severity: 'blocking', code: 'MISSING_CHAPTER_TRANSLATION', chapterId, message: `O capítulo “${title}” não possui tradução.` });
  } else if (translationRequired && looksLikeUntranslatedCopy(sourceText, rawTranslatedText)) {
    status = 'untranslated_copy';
    issues.push({ severity: 'blocking', code: 'UNTRANSLATED_CHAPTER_COPY', chapterId, message: `O capítulo “${title}” parece ter sido copiado sem tradução.` });
  }

  const sourceBlocks = splitStructuralUnits(sourceText);
  const translatedBlocks = splitStructuralUnits(rawTranslatedText);
  const maxUnits = Math.max(sourceBlocks.length, translatedBlocks.length);
  const units: CanonicalBookUnit[] = [];

  for (let index = 0; index < maxUnits; index++) {
    const sourceBlock = sourceBlocks[index] || '';
    const translatedBlock = translatedBlocks[index] || '';
    const exclusionReason = classifyPromotionalBlock(sourceBlock) || classifyPromotionalBlock(translatedBlock);
    let unitStatus: CanonicalUnitStatus = translationRequired ? 'translated' : 'source_language';
    if (!sourceBlock && translatedBlock) unitStatus = 'translation_extra';
    else if (sourceBlock && !translatedBlock) unitStatus = 'missing_translation';
    else if (translationRequired && looksLikeUntranslatedCopy(sourceBlock, translatedBlock)) unitStatus = 'untranslated_copy';

    const identitySource = sourceBlock || translatedBlock || `${chapterId}:${index}`;
    const unitId = `unit_${sha256(`${chapterId}|${index}|${identitySource}`).slice(0, 18)}`;
    const type: CanonicalBookUnit['type'] = !sourceBlock && translatedBlock
      ? 'translation_extra'
      : isSeparator(sourceBlock || translatedBlock) ? 'separator' : 'paragraph';

    units.push({
      unitId,
      chapterId,
      chapterOrder: order,
      unitOrder: index + 1,
      type,
      sourceText: sourceBlock,
      translatedText: translatedBlock,
      exportText: exclusionReason ? '' : translatedBlock,
      sourceHash: sha256(sourceBlock),
      translatedHash: sha256(translatedBlock),
      status: unitStatus,
      excludedFromExport: Boolean(exclusionReason),
      exclusionReason: exclusionReason || undefined,
    });
  }

  if (sourceBlocks.length !== translatedBlocks.length && rawTranslatedText) {
    issues.push({
      severity: 'warning',
      code: 'STRUCTURAL_UNIT_COUNT_CHANGED',
      chapterId,
      message: `O capítulo “${title}” possui ${sourceBlocks.length} blocos na fonte e ${translatedBlocks.length} na tradução. O texto foi preservado, mas convém revisar a divisão de parágrafos.`,
    });
  }

  for (const unit of units) {
    if (unit.status === 'missing_translation' && rawTranslatedText) {
      issues.push({ severity: 'warning', code: 'UNIT_ALIGNMENT_GAP', chapterId, unitId: unit.unitId, message: 'Uma unidade da fonte não encontrou correspondência posicional direta na tradução.' });
    }
    if (unit.status === 'untranslated_copy' && status === 'ready') {
      issues.push({ severity: 'warning', code: 'POSSIBLE_UNTRANSLATED_UNIT', chapterId, unitId: unit.unitId, message: 'Uma unidade parece idêntica à fonte. Pode ser nome próprio, citação ou trecho não traduzido.' });
    }
  }

  const exportText = units.filter(unit => !unit.excludedFromExport).map(unit => unit.exportText).filter(Boolean).join('\n\n');
  const alignedUnits = Math.min(sourceBlocks.length, translatedBlocks.length);
  const alignmentPercent = Math.max(sourceBlocks.length, translatedBlocks.length) === 0
    ? 100
    : Math.round((alignedUnits / Math.max(sourceBlocks.length, translatedBlocks.length)) * 10_000) / 100;

  return {
    chapterId,
    order,
    title,
    sourceText,
    translatedText: rawTranslatedText,
    exportText,
    sourceHash: sha256(sourceText),
    translatedHash: sha256(rawTranslatedText),
    status,
    units,
    structuralAlignment: {
      sourceUnits: sourceBlocks.length,
      translatedUnits: translatedBlocks.length,
      alignedUnits,
      percent: alignmentPercent,
    },
  };
}

function buildBundle(result: TranslatedBookBuildResult) {
  const zip = new AdmZip();
  const files: Array<[string, string | undefined]> = [
    ['translated-book.json', result.paths.canonicalJson],
    ['translation-quality-report.json', result.paths.reportJson],
    ['livro-traduzido.txt', result.paths.txt],
    ['tts-clean.txt', result.paths.tts],
    ['livro-traduzido.docx', result.paths.docx],
  ];
  for (const [name, filePath] of files) {
    if (filePath && fs.existsSync(filePath)) zip.addLocalFile(filePath, '', name);
  }
  return zip.toBuffer();
}

export function buildTranslatedBookArtifacts(
  projectIdInput: string,
  storage: TranslatedBookStorage,
): TranslatedBookBuildResult {
  const projectId = safeProjectId(projectIdInput);
  const projects = readProjects(storage.projectsDbFile);
  const project = projects.find(item => item.projectId === projectId);
  if (!project) throw new Error('Projeto não encontrado.');

  const projectDir = path.join(storage.projectsRoot, projectId);
  const chaptersPath = path.join(projectDir, 'normalized', 'chapters.json');
  if (!fs.existsSync(chaptersPath)) throw new Error('A obra ainda não possui capítulos normalizados.');
  const rawChapters = readJson<any[]>(chaptersPath);
  if (!Array.isArray(rawChapters) || rawChapters.length === 0) throw new Error('Nenhum capítulo foi encontrado para exportação.');

  const sourceLanguage = String(project.sourceLanguage || 'auto');
  const targetLanguage = String(project.targetLanguage || 'pt-BR');
  const translationRequired = project.translationEnabled !== false && !isPortuguese(sourceLanguage);
  const generatedAt = new Date().toISOString();
  const issues: TranslatedBookIssue[] = [];
  const chapters = rawChapters
    .map((chapter, index) => buildChapter(chapter, index, translationRequired, issues))
    .sort((a, b) => a.order - b.order);

  const translatedHashes = new Map<string, string>();
  for (const chapter of chapters) {
    if (!chapter.translatedText || chapter.translatedText.length < 120) continue;
    const previous = translatedHashes.get(chapter.translatedHash);
    if (previous && previous !== chapter.chapterId) {
      issues.push({ severity: 'warning', code: 'DUPLICATE_TRANSLATED_CHAPTER', chapterId: chapter.chapterId, message: 'Este capítulo possui o mesmo conteúdo traduzido de outro capítulo. Verifique possível duplicação.' });
    } else translatedHashes.set(chapter.translatedHash, chapter.chapterId);
  }

  const readyChapters = chapters.filter(chapter => chapter.status === 'ready').length;
  const missingChapters = chapters.filter(chapter => chapter.status === 'missing_translation').length;
  const untranslatedCopyChapters = chapters.filter(chapter => chapter.status === 'untranslated_copy').length;
  const sourceUnits = chapters.reduce((sum, chapter) => sum + chapter.structuralAlignment.sourceUnits, 0);
  const translatedUnits = chapters.reduce((sum, chapter) => sum + chapter.structuralAlignment.translatedUnits, 0);
  const alignedUnits = chapters.reduce((sum, chapter) => sum + chapter.structuralAlignment.alignedUnits, 0);
  const excludedUnits = chapters.reduce((sum, chapter) => sum + chapter.units.filter(unit => unit.excludedFromExport).length, 0);
  const chapterCoveragePercent = Math.round((readyChapters / chapters.length) * 10_000) / 100;
  const structuralAlignmentPercent = Math.max(sourceUnits, translatedUnits) === 0
    ? 100
    : Math.round((alignedUnits / Math.max(sourceUnits, translatedUnits)) * 10_000) / 100;

  if (excludedUnits > 0) {
    issues.push({ severity: 'info', code: 'PROMOTIONAL_UNITS_EXCLUDED', message: `${excludedUnits} unidade(s) promocional(is) isolada(s) foram omitidas apenas dos arquivos de leitura e TTS; o conteúdo original permanece no JSON canônico.` });
  }

  const sourceText = chapters.map(chapter => chapter.sourceText).join('\n\n');
  const translatedText = chapters.map(chapter => chapter.translatedText).join('\n\n');
  const reportBase = {
    version: 1 as const,
    projectId,
    generatedAt,
    exportReady: issues.every(issue => issue.severity !== 'blocking'),
    translationRequired,
    summary: {
      chapters: chapters.length,
      readyChapters,
      missingChapters,
      untranslatedCopyChapters,
      sourceUnits,
      translatedUnits,
      excludedUnits,
      chapterCoveragePercent,
      structuralAlignmentPercent,
      blockingIssues: issues.filter(issue => issue.severity === 'blocking').length,
      warnings: issues.filter(issue => issue.severity === 'warning').length,
    },
    hashes: {
      sourceSha256: sha256(sourceText),
      translatedSha256: sha256(translatedText),
      canonicalSha256: '',
    },
    issues,
  } satisfies TranslatedBookReport;

  const bookWithoutFinalHash = {
    schema: 'voxlibro.translated-book' as const,
    schemaVersion: 1 as const,
    bookId: `book_${sha256(`${projectId}|${reportBase.hashes.sourceSha256}`).slice(0, 20)}`,
    projectId,
    title: String(project.name || project.detectedTitle || 'Livro traduzido'),
    author: project.author || project.detectedAuthor || undefined,
    sourceLanguage,
    targetLanguage,
    translationRequired,
    generatedAt,
    chapters,
    report: reportBase,
  };
  const canonicalSha256 = sha256(JSON.stringify(bookWithoutFinalHash));
  const report: TranslatedBookReport = {
    ...reportBase,
    hashes: { ...reportBase.hashes, canonicalSha256 },
  };
  const book: CanonicalTranslatedBook = { ...bookWithoutFinalHash, report };

  const translationDir = path.join(projectDir, 'translation');
  const exportsDir = path.join(translationDir, 'exports');
  fs.mkdirSync(exportsDir, { recursive: true });
  const stem = safeFileStem(book.title);
  const canonicalJson = path.join(translationDir, 'translated-book.json');
  const reportJson = path.join(translationDir, 'translation-quality-report.json');
  atomicWrite(canonicalJson, `${JSON.stringify(book, null, 2)}\n`);
  atomicWrite(reportJson, `${JSON.stringify(report, null, 2)}\n`);

  const result: TranslatedBookBuildResult = {
    book,
    report,
    paths: { canonicalJson, reportJson },
  };

  if (report.exportReady) {
    result.paths.txt = path.join(exportsDir, `${stem}.pt-BR.txt`);
    result.paths.tts = path.join(exportsDir, `${stem}.tts-clean.txt`);
    result.paths.docx = path.join(exportsDir, `${stem}.pt-BR.docx`);
    result.paths.bundle = path.join(exportsDir, `${stem}.traducao-voxlibro.zip`);
    atomicWrite(result.paths.txt, renderBookText(book, false));
    atomicWrite(result.paths.tts, renderBookText(book, true));
    atomicWrite(result.paths.docx, createDocx(book));
    atomicWrite(result.paths.bundle, buildBundle(result));
  }

  return result;
}

function publicStatus(result: TranslatedBookBuildResult) {
  const formats = result.report.exportReady
    ? ['txt', 'tts', 'docx', 'json', 'report', 'zip']
    : ['json', 'report'];
  return {
    projectId: result.book.projectId,
    title: result.book.title,
    ready: result.report.exportReady,
    formats,
    report: result.report,
  };
}

function downloadInfo(result: TranslatedBookBuildResult, format: string) {
  const stem = safeFileStem(result.book.title);
  const map: Record<string, { filePath?: string; fileName: string; contentType: string }> = {
    txt: { filePath: result.paths.txt, fileName: `${stem}.pt-BR.txt`, contentType: 'text/plain; charset=utf-8' },
    tts: { filePath: result.paths.tts, fileName: `${stem}.tts-clean.txt`, contentType: 'text/plain; charset=utf-8' },
    docx: { filePath: result.paths.docx, fileName: `${stem}.pt-BR.docx`, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    json: { filePath: result.paths.canonicalJson, fileName: `${stem}.translated-book.json`, contentType: 'application/json; charset=utf-8' },
    report: { filePath: result.paths.reportJson, fileName: `${stem}.translation-quality-report.json`, contentType: 'application/json; charset=utf-8' },
    zip: { filePath: result.paths.bundle, fileName: `${stem}.traducao-voxlibro.zip`, contentType: 'application/zip' },
  };
  return map[format];
}

export function registerTranslatedBookRoutes(
  app: Express,
  storageProvider: () => TranslatedBookStorage,
) {
  const build = (projectId: string) => buildTranslatedBookArtifacts(projectId, storageProvider());

  app.get('/api/projects/:projectId/translated-book/status', (req: Request, res: Response) => {
    try {
      const result = build(req.params.projectId);
      res.setHeader('Cache-Control', 'no-store');
      return res.json(publicStatus(result));
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'TRANSLATED_BOOK_UNAVAILABLE', message: error?.message || 'Não foi possível preparar o livro traduzido.' } });
    }
  });

  app.post('/api/projects/:projectId/translated-book/rebuild', (req: Request, res: Response) => {
    try {
      const result = build(req.params.projectId);
      res.setHeader('Cache-Control', 'no-store');
      return res.json(publicStatus(result));
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'TRANSLATED_BOOK_REBUILD_FAILED', message: error?.message || 'Não foi possível reconstruir o livro traduzido.' } });
    }
  });

  app.get('/api/projects/:projectId/translated-book/download', (req: Request, res: Response) => {
    try {
      const format = String(req.query.format || 'txt').toLowerCase();
      const result = build(req.params.projectId);
      const info = downloadInfo(result, format);
      if (!info) return res.status(400).json({ error: { code: 'INVALID_EXPORT_FORMAT', message: 'Formato de exportação inválido.' } });
      if (!result.report.exportReady && !['json', 'report'].includes(format)) {
        return res.status(409).json({ error: { code: 'TRANSLATION_NOT_COMPLETE', message: 'A tradução ainda possui problemas bloqueantes. Consulte o relatório de qualidade.', report: result.report } });
      }
      if (!info.filePath || !fs.existsSync(info.filePath)) {
        return res.status(404).json({ error: { code: 'EXPORT_FILE_NOT_FOUND', message: 'O arquivo solicitado não foi gerado.' } });
      }
      res.setHeader('Content-Type', info.contentType);
      res.setHeader('Cache-Control', 'no-store');
      return res.download(info.filePath, info.fileName);
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'TRANSLATED_BOOK_DOWNLOAD_FAILED', message: error?.message || 'Não foi possível baixar o livro traduzido.' } });
    }
  });
}
