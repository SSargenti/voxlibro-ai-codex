import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  auditGlossaryConsistency,
  normalizeGlossaryEntries,
  readGlossary,
  registerTranslationMemoryRoutes,
  saveGlossary,
  suggestGlossaryEntries,
  type TranslationMemoryStorage,
} from './src/translationMemory';

const tempDirs: string[] = [];

function fixture(options?: { chapters?: any[]; project?: Record<string, any> }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxlibro-memory-'));
  tempDirs.push(root);
  const projectsRoot = path.join(root, 'projects');
  const projectId = 'proj_memory_test';
  const projectDir = path.join(projectsRoot, projectId);
  fs.mkdirSync(path.join(projectDir, 'normalized'), { recursive: true });
  const projectsDbFile = path.join(projectsRoot, 'projects.json');
  fs.writeFileSync(projectsDbFile, JSON.stringify([{
    projectId,
    name: 'Memory Test',
    sourceLanguage: 'en',
    targetLanguage: 'pt-BR',
    translationEnabled: true,
    ...options?.project,
  }], null, 2));
  fs.writeFileSync(path.join(projectDir, 'normalized', 'chapters.json'), JSON.stringify(options?.chapters || [
    {
      chapterId: 'chapter_001',
      title: 'One',
      originalText: 'Mara entered Aurora Station. Mara called Jonas. Aurora Station remained silent.',
      translatedText: 'Mara entrou na Estação Aurora. Mara chamou Jonas. A Estação Aurora permaneceu silenciosa.',
    },
    {
      chapterId: 'chapter_002',
      title: 'Two',
      originalText: 'Jonas returned to Aurora Station and found Mara.',
      translatedText: 'Jonas voltou à Estação Aurora e encontrou Mara.',
    },
  ], null, 2));
  const storage = { projectsRoot, projectsDbFile } satisfies TranslationMemoryStorage;
  return { root, projectsRoot, projectId, projectDir, storage };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('memória persistente da tradução', () => {
  it('normaliza aliases, remove duplicatas, preserva IDs e força termos obrigatórios', () => {
    const previous = normalizeGlossaryEntries([{ sourceTerm: 'Aurora Station', preferredTranslation: 'Estação Aurora', locked: true }]);
    const normalized = normalizeGlossaryEntries([
      { glossaryId: previous[0].glossaryId, term: 'Aurora Station', translation: 'Estação Aurora', locked: false },
      { source: 'aurora station', target: 'Outra tradução' },
      { sourceTerm: '', preferredTranslation: 'Inválido' },
    ], previous);

    expect(normalized).toHaveLength(1);
    expect(normalized[0].glossaryId).toBe(previous[0].glossaryId);
    expect(normalized[0].sourceTerm).toBe('Aurora Station');
    expect(normalized[0].preferredTranslation).toBe('Estação Aurora');
    expect(normalized[0].locked).toBe(true);
  });

  it('sugere nomes e locais recorrentes sem repetir termos já salvos', () => {
    const { projectId, storage } = fixture();
    saveGlossary(storage, projectId, [{ sourceTerm: 'Mara', preferredTranslation: 'Mara', locked: true }]);
    const suggestions = suggestGlossaryEntries(storage, projectId);

    expect(suggestions.some(item => item.sourceTerm === 'Aurora Station' && item.occurrences >= 3)).toBe(true);
    expect(suggestions.some(item => item.sourceTerm === 'Mara')).toBe(false);
  });

  it('persiste o glossário no projeto e o recupera sem perda', () => {
    const { projectId, projectDir, storage } = fixture();
    const saved = saveGlossary(storage, projectId, [
      { sourceTerm: 'Aurora Station', preferredTranslation: 'Estação Aurora', locked: true, notes: 'Local principal' },
      { sourceTerm: 'Mara', preferredTranslation: 'Mara', locked: true },
    ]);

    expect(saved).toHaveLength(2);
    expect(readGlossary(storage, projectId)).toEqual(saved);
    expect(fs.existsSync(path.join(projectDir, 'translation', 'glossary.json'))).toBe(true);
  });

  it('audita termos obrigatórios ausentes na tradução por capítulo', () => {
    const { projectId, storage } = fixture({ chapters: [
      {
        chapterId: 'chapter_001',
        title: 'One',
        originalText: 'Mara entered Aurora Station.',
        translatedText: 'Mara entrou na estação orbital.',
      },
    ] });
    saveGlossary(storage, projectId, [{ sourceTerm: 'Aurora Station', preferredTranslation: 'Estação Aurora', locked: true }]);
    const audit = auditGlossaryConsistency(storage, projectId);

    expect(audit.status).toBe('REVIEW');
    expect(audit.issues).toHaveLength(1);
    expect(audit.issues[0].code).toBe('LOCKED_TERM_NOT_FOUND');
  });

  it('inicia o job integral com o glossário persistente, sua versão e estado translating', async () => {
    const { projectId, storage } = fixture();
    saveGlossary(storage, projectId, [{ sourceTerm: 'Aurora Station', preferredTranslation: 'Estação Aurora', locked: true }]);
    const startProjectJob = vi.fn().mockReturnValue({ jobId: 'job_translation_1', status: 'queued', progress: 0, items: [] });
    const app = express();
    app.use(express.json());
    registerTranslationMemoryRoutes(app, () => storage, { startProjectJob });

    const response = await request(app)
      .post(`/api/projects/${projectId}/translation/automated`)
      .send({ style: 'literário' })
      .expect(200);

    expect(response.body.glossaryEntries).toBe(1);
    expect(response.body.project.status).toBe('translating');
    expect(startProjectJob).toHaveBeenCalledTimes(1);
    expect(startProjectJob).toHaveBeenCalledWith(projectId, 'translation', expect.objectContaining({
      style: 'literário',
      glossaryEntries: [expect.objectContaining({ term: 'Aurora Station', translation: 'Estação Aurora', locked: true })],
      glossaryVersion: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    const persistedProject = JSON.parse(fs.readFileSync(storage.projectsDbFile, 'utf8'))[0];
    expect(persistedProject.status).toBe('translating');
    expect(persistedProject.lastError).toBeUndefined();
  });

  it('não inicia tradução quando ela está desativada', async () => {
    const { projectId, storage } = fixture({ project: { translationEnabled: false } });
    const startProjectJob = vi.fn();
    const app = express();
    app.use(express.json());
    registerTranslationMemoryRoutes(app, () => storage, { startProjectJob });

    const response = await request(app)
      .post(`/api/projects/${projectId}/translation/automated`)
      .send({ style: 'literário' })
      .expect(409);

    expect(response.body.error.code).toBe('TRANSLATION_DISABLED');
    expect(startProjectJob).not.toHaveBeenCalled();
  });

  it('expõe CRUD, sugestões e auditoria por HTTP', async () => {
    const { projectId, storage } = fixture();
    const app = express();
    app.use(express.json());
    registerTranslationMemoryRoutes(app, () => storage, { startProjectJob: vi.fn() });

    await request(app)
      .put(`/api/projects/${projectId}/translation/glossary`)
      .send({ entries: [{ sourceTerm: 'Aurora Station', preferredTranslation: 'Estação Aurora', locked: true }] })
      .expect(200);

    const get = await request(app).get(`/api/projects/${projectId}/translation/glossary`).expect(200);
    expect(get.body.entries).toHaveLength(1);

    const suggestions = await request(app).post(`/api/projects/${projectId}/translation/glossary/suggest`).expect(200);
    expect(Array.isArray(suggestions.body.suggestions)).toBe(true);

    const audit = await request(app).post(`/api/projects/${projectId}/translation/glossary/audit`).expect(200);
    expect(audit.body.report.status).toBe('PASS');
  });
});
