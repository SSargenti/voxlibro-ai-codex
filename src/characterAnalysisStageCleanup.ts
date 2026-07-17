import fs from 'fs';
import path from 'path';

export type CharacterStageCleanupStorage = {
  projectsRoot: string;
  projectsDbFile: string;
};

function atomicWrite(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

export function cleanupStaleCharacterAnalysisStages(storage: CharacterStageCleanupStorage) {
  if (!fs.existsSync(storage.projectsDbFile)) return { removed: 0 };
  const parsed = JSON.parse(fs.readFileSync(storage.projectsDbFile, 'utf8'));
  const projects = Array.isArray(parsed) ? parsed : [];
  const stale = projects.filter(project => project?.internalTemporary === true && String(project?.projectId || '').startsWith('bible_stage_'));
  if (!stale.length) return { removed: 0 };

  for (const project of stale) {
    const stageId = String(project.projectId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (stageId) fs.rmSync(path.join(storage.projectsRoot, stageId), { recursive: true, force: true });
  }
  atomicWrite(storage.projectsDbFile, projects.filter(project => !stale.includes(project)));
  return { removed: stale.length };
}
