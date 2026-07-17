import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { registerTranslatedBookEligibilityGuard } from './src/translatedBookEligibility';

const tempDirs: string[] = [];

function appWithProject(project: Record<string, any>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxlibro-eligibility-'));
  tempDirs.push(root);
  const projectsDbFile = path.join(root, 'projects.json');
  const projectId = 'proj_eligibility';
  fs.writeFileSync(projectsDbFile, JSON.stringify([{ projectId, ...project }], null, 2));
  const app = express();
  registerTranslatedBookEligibilityGuard(app, () => ({ projectsDbFile }));
  app.get('/api/projects/:projectId/translated-book/status', (_req, res) => res.json({ ready: true }));
  return { app, projectId };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('elegibilidade do livro traduzido', () => {
  it('bloqueia obra estrangeira com tradução desativada', async () => {
    const { app, projectId } = appWithProject({ sourceLanguage: 'en', translationEnabled: false });
    const response = await request(app).get(`/api/projects/${projectId}/translated-book/status`).expect(409);
    expect(response.body.error.code).toBe('TRANSLATION_DISABLED_FOR_FOREIGN_SOURCE');
  });

  it('permite obra estrangeira quando a tradução está ativada', async () => {
    const { app, projectId } = appWithProject({ sourceLanguage: 'en', translationEnabled: true });
    const response = await request(app).get(`/api/projects/${projectId}/translated-book/status`).expect(200);
    expect(response.body.ready).toBe(true);
  });

  it('permite exportação do original quando a obra já está em português', async () => {
    const { app, projectId } = appWithProject({ sourceLanguage: 'pt-BR', translationEnabled: false });
    const response = await request(app).get(`/api/projects/${projectId}/translated-book/status`).expect(200);
    expect(response.body.ready).toBe(true);
  });

  it('retorna 404 para projeto inexistente', async () => {
    const { app } = appWithProject({ sourceLanguage: 'en', translationEnabled: true });
    const response = await request(app).get('/api/projects/proj_missing/translated-book/status').expect(404);
    expect(response.body.error.code).toBe('PROJECT_NOT_FOUND');
  });
});
