import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type TranslationMemoryStorage = {
  projectsRoot: string;
  projectsDbFile: string;
};

export type GlossaryEntry = {
  glossaryId: string;
  sourceTerm: string;
  preferredTranslation: string;
  notes?: string;
  locked: boolean;
  occurrences?: number;
  createdAt: string;
  updatedAt: string;
};

export type GlossaryAuditIssue = {
  severity: 'warning' | 'info';
  code: string;
  glossaryId: string;
  sourceTerm: string;
  preferredTranslation: string;
  chapterId: string;
  chapterTitle: string;
  message: string;
};

const COMMON_SENTENCE_WORDS = new Set([
  'A', 'An', 'And', 'As', 'At', 'But', 'By', 'Chapter', 'For', 'From', 'He', 'Her', 'His', 'I', 'If', 'In', 'Into',
  'It', 'Its', 'No', 'Not', 'Of', 'On', 'One', 'Or', 'Our', 'She', 'So', 'That', 'The', 'Their', 'Then', 'There',
  'They', 'This', 'To', 'We', 'When', 'Where', 'While', 'With', 'You', 'Your',
]);

function normalizeText(value: unknown) {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function termKey(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('pt-BR');
}

function safeProjectId(value: string) {
  const sanitized = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sanitized || sanitized !== value) throw new Error('ID de projeto inválido.');
  return sanitized;
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function atomicWrite(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function glossaryPath(storage: TranslationMemoryStorage, projectId: string) {
  return path.join(storage.projectsRoot, projectId, 'translation', 'glossary.json');
}

function auditPath(storage: TranslationMemoryStorage, projectId: string) {
  return path.join(storage.projectsRoot, projectId, 'translation', 'glossary-audit.json');
}

function chaptersPath(storage: TranslationMemoryStorage, projectId: string) {
  return path.join(storage.projectsRoot, projectId, 'normalized', 'chapters.json');
}

function readProjects(storage: TranslationMemoryStorage) {
  const projects = readJson<any[]>(storage.projectsDbFile, []);
  return Array.isArray(projects) ? projects : [];
}

function getProject(storage: TranslationMemoryStorage, projectId: string) {
  return readProjects(storage).find(project => project.projectId === projectId);
}

function projectExists(storage: TranslationMemoryStorage, projectId: string) {
  return Boolean(getProject(storage, projectId));
}

export function readGlossary(storage: TranslationMemoryStorage, projectIdInput: string): GlossaryEntry[] {
  const projectId = safeProjectId(projectIdInput);
  if (!projectExists(storage, projectId)) throw new Error('Projeto não encontrado.');
  const entries = readJson<GlossaryEntry[]>(glossaryPath(storage, projectId), []);
  return Array.isArray(entries) ? entries : [];
}

export function normalizeGlossaryEntries(rawEntries: unknown, existingEntries: GlossaryEntry[] = []): GlossaryEntry[] {
  if (!Array.isArray(rawEntries)) throw new Error('O glossário precisa ser uma lista.');
  const existingById = new Map(existingEntries.map(entry => [entry.glossaryId, entry]));
  const existingByTerm = new Map(existingEntries.map(entry => [termKey(entry.sourceTerm), entry]));
  const now = new Date().toISOString();
  const normalized: GlossaryEntry[] = [];
  const seenTerms = new Set<string>();

  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object') continue;
    const sourceTerm = normalizeText((raw as any).sourceTerm || (raw as any).term || (raw as any).source);
    const preferredTranslation = normalizeText((raw as any).preferredTranslation || (raw as any).translation || (raw as any).target);
    if (!sourceTerm || !preferredTranslation) continue;
    if (sourceTerm.length > 160 || preferredTranslation.length > 240) continue;
    const key = termKey(sourceTerm);
    if (seenTerms.has(key)) continue;
    seenTerms.add(key);

    const previous = existingById.get(String((raw as any).glossaryId || '')) || existingByTerm.get(key);
    normalized.push({
      glossaryId: previous?.glossaryId || `glossary_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
      sourceTerm,
      preferredTranslation,
      notes: normalizeText((raw as any).notes || previous?.notes || '') || undefined,
      // O glossário do VoxLibro é uma memória obrigatória: qualquer termo salvo
      // precisa ser respeitado por todos os blocos e verificado na auditoria final.
      locked: true,
      occurrences: Number.isFinite(Number((raw as any).occurrences)) ? Math.max(0, Number((raw as any).occurrences)) : previous?.occurrences,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    });
  }

  return normalized.sort((a, b) => a.sourceTerm.localeCompare(b.sourceTerm, 'pt-BR'));
}

export function saveGlossary(
  storage: TranslationMemoryStorage,
  projectIdInput: string,
  rawEntries: unknown,
): GlossaryEntry[] {
  const projectId = safeProjectId(projectIdInput);
  const existing = readGlossary(storage, projectId);
  const entries = normalizeGlossaryEntries(rawEntries, existing);
  atomicWrite(glossaryPath(storage, projectId), entries);
  return entries;
}

export function suggestGlossaryEntries(
  storage: TranslationMemoryStorage,
  projectIdInput: string,
): Array<{ sourceTerm: string; occurrences: number; reason: string }> {
  const projectId = safeProjectId(projectIdInput);
  if (!projectExists(storage, projectId)) throw new Error('Projeto não encontrado.');
  const filePath = chaptersPath(storage, projectId);
  if (!fs.existsSync(filePath)) throw new Error('A obra ainda não possui capítulos normalizados.');
  const chapters = readJson<any[]>(filePath, []);
  const counts = new Map<string, { sourceTerm: string; occurrences: number }>();

  for (const chapter of chapters) {
    const text = normalizeText(chapter?.originalText || '');
    const matches = text.match(/\b(?:[A-ZÀ-Ý][\p{L}'’-]{2,})(?:\s+(?:[A-ZÀ-Ý][\p{L}'’-]{2,})){0,3}\b/gu) || [];
    for (const match of matches) {
      const sourceTerm = match.trim();
      const firstWord = sourceTerm.split(/\s+/)[0];
      if (COMMON_SENTENCE_WORDS.has(sourceTerm) || COMMON_SENTENCE_WORDS.has(firstWord) && !sourceTerm.includes(' ')) continue;
      if (/^(?:CHAPTER|PART|BOOK|PROLOGUE|EPILOGUE)$/i.test(sourceTerm)) continue;
      const key = termKey(sourceTerm);
      const current = counts.get(key) || { sourceTerm, occurrences: 0 };
      current.occurrences += 1;
      if (sourceTerm.length > current.sourceTerm.length) current.sourceTerm = sourceTerm;
      counts.set(key, current);
    }
  }

  const existingKeys = new Set(readGlossary(storage, projectId).map(entry => termKey(entry.sourceTerm)));
  return Array.from(counts.entries())
    .filter(([key, value]) => value.occurrences >= 2 && !existingKeys.has(key))
    .map(([, value]) => ({ ...value, reason: 'Nome próprio ou termo recorrente detectado na obra' }))
    .sort((a, b) => b.occurrences - a.occurrences || a.sourceTerm.localeCompare(b.sourceTerm, 'pt-BR'))
    .slice(0, 120);
}

export function auditGlossaryConsistency(
  storage: TranslationMemoryStorage,
  projectIdInput: string,
) {
  const projectId = safeProjectId(projectIdInput);
  const entries = readGlossary(storage, projectId);
  const filePath = chaptersPath(storage, projectId);
  if (!fs.existsSync(filePath)) throw new Error('A obra ainda não possui capítulos normalizados.');
  const chapters = readJson<any[]>(filePath, []);
  const issues: GlossaryAuditIssue[] = [];

  for (const chapter of chapters) {
    const sourceText = normalizeText(chapter?.originalText || '');
    const translatedText = normalizeText(chapter?.translatedText || '');
    if (!sourceText || !translatedText) continue;
    const sourceFolded = sourceText.toLocaleLowerCase('pt-BR');
    const translatedFolded = translatedText.toLocaleLowerCase('pt-BR');

    for (const entry of entries) {
      if (!sourceFolded.includes(entry.sourceTerm.toLocaleLowerCase('pt-BR'))) continue;
      if (translatedFolded.includes(entry.preferredTranslation.toLocaleLowerCase('pt-BR'))) continue;
      issues.push({
        severity: 'warning',
        code: 'LOCKED_TERM_NOT_FOUND',
        glossaryId: entry.glossaryId,
        sourceTerm: entry.sourceTerm,
        preferredTranslation: entry.preferredTranslation,
        chapterId: String(chapter?.chapterId || ''),
        chapterTitle: String(chapter?.title || chapter?.chapterId || 'Capítulo'),
        message: `“${entry.sourceTerm}” aparece na fonte, mas “${entry.preferredTranslation}” não foi encontrado na tradução deste capítulo.`,
      });
    }
  }

  const report = {
    version: 1,
    projectId,
    generatedAt: new Date().toISOString(),
    lockedEntries: entries.length,
    chapters: chapters.length,
    issues,
    status: issues.length === 0 ? 'PASS' : 'REVIEW',
  };
  atomicWrite(auditPath(storage, projectId), report);
  return report;
}

export function toTranslationJobGlossary(entries: GlossaryEntry[]) {
  return entries.map(entry => ({
    term: entry.sourceTerm,
    translation: entry.preferredTranslation,
    sourceTerm: entry.sourceTerm,
    preferredTranslation: entry.preferredTranslation,
    locked: true,
  }));
}

export function registerTranslationMemoryRoutes(
  app: Express,
  storageProvider: () => TranslationMemoryStorage,
  dependencies: {
    startProjectJob: (projectId: string, operation: 'translation', options?: any) => any;
  },
) {
  app.get('/api/projects/:projectId/translation/glossary', (req: Request, res: Response) => {
    try {
      const entries = readGlossary(storageProvider(), req.params.projectId);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ projectId: req.params.projectId, entries });
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'GLOSSARY_UNAVAILABLE', message: error?.message || 'Não foi possível carregar o glossário.' } });
    }
  });

  app.put('/api/projects/:projectId/translation/glossary', (req: Request, res: Response) => {
    try {
      const entries = saveGlossary(storageProvider(), req.params.projectId, req.body?.entries || []);
      return res.json({ projectId: req.params.projectId, entries });
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'GLOSSARY_SAVE_FAILED', message: error?.message || 'Não foi possível salvar o glossário.' } });
    }
  });

  app.post('/api/projects/:projectId/translation/glossary/suggest', (req: Request, res: Response) => {
    try {
      const suggestions = suggestGlossaryEntries(storageProvider(), req.params.projectId);
      return res.json({ projectId: req.params.projectId, suggestions });
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'GLOSSARY_SUGGESTION_FAILED', message: error?.message || 'Não foi possível sugerir termos.' } });
    }
  });

  app.post('/api/projects/:projectId/translation/glossary/audit', (req: Request, res: Response) => {
    try {
      const report = auditGlossaryConsistency(storageProvider(), req.params.projectId);
      return res.json({ report });
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'GLOSSARY_AUDIT_FAILED', message: error?.message || 'Não foi possível auditar o glossário.' } });
    }
  });

  app.post('/api/projects/:projectId/translation/automated', (req: Request, res: Response) => {
    try {
      const storage = storageProvider();
      const projectId = safeProjectId(req.params.projectId);
      const projects = readProjects(storage);
      const project = projects.find(item => item.projectId === projectId);
      if (!project) {
        return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Projeto não encontrado.' } });
      }
      if (project.translationEnabled === false) {
        return res.status(409).json({
          error: {
            code: 'TRANSLATION_DISABLED',
            message: 'A tradução está desativada para este projeto. Ative-a na etapa Obra antes de iniciar o processamento.',
          },
        });
      }
      const chapterFile = chaptersPath(storage, projectId);
      if (!fs.existsSync(chapterFile)) {
        return res.status(409).json({ error: { code: 'CHAPTERS_NOT_FOUND', message: 'Nenhum capítulo normalizado está disponível para tradução.' } });
      }
      const chapters = readJson<any[]>(chapterFile, []);
      if (!chapters.length) {
        return res.status(409).json({ error: { code: 'CHAPTERS_EMPTY', message: 'A obra não possui capítulos traduzíveis.' } });
      }

      const entries = readGlossary(storage, projectId);
      const job = dependencies.startProjectJob(projectId, 'translation', {
        style: req.body?.style || 'literário',
        forceFresh: req.body?.forceFresh === true,
        glossaryEntries: toTranslationJobGlossary(entries),
        glossaryVersion: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
      });

      project.status = job.status === 'completed' ? 'analyzing_characters' : 'translating';
      project.lastError = undefined;
      project.updatedAt = new Date().toISOString();
      atomicWrite(storage.projectsDbFile, projects);

      return res.json({ project, chapters, job, glossaryEntries: entries.length });
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'AUTOMATED_TRANSLATION_START_FAILED', message: error?.message || 'Não foi possível iniciar a tradução automatizada.' } });
    }
  });
}
