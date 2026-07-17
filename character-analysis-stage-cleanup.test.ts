import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupStaleCharacterAnalysisStages } from './src/characterAnalysisStageCleanup';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('limpeza de estágios temporários da Bíblia', () => {
  it('remove somente estágios internos órfãos e preserva o projeto principal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voxlibro-stage-cleanup-'));
    roots.push(root);
    const projectsRoot = path.join(root, 'projects');
    const projectsDbFile = path.join(projectsRoot, 'projects.json');
    const mainId = 'proj_main';
    const stageId = 'bible_stage_1234567890abcdef';
    fs.mkdirSync(path.join(projectsRoot, mainId), { recursive: true });
    fs.mkdirSync(path.join(projectsRoot, stageId), { recursive: true });
    fs.writeFileSync(projectsDbFile, JSON.stringify([
      { projectId: mainId, name: 'Principal' },
      { projectId: stageId, internalTemporary: true, parentProjectId: mainId },
      { projectId: 'outro_temporario', internalTemporary: true },
    ], null, 2));

    const result = cleanupStaleCharacterAnalysisStages({ projectsRoot, projectsDbFile });
    const projects = JSON.parse(fs.readFileSync(projectsDbFile, 'utf8'));

    expect(result.removed).toBe(1);
    expect(fs.existsSync(path.join(projectsRoot, stageId))).toBe(false);
    expect(fs.existsSync(path.join(projectsRoot, mainId))).toBe(true);
    expect(projects.map((project: any) => project.projectId)).toEqual([mainId, 'outro_temporario']);
  });
});
