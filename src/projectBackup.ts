import type { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import AdmZip from 'adm-zip';

export const PROJECT_BACKUP_FORMAT = 'voxlibro-project-backup';
export const PROJECT_BACKUP_VERSION = 1;
export const PROJECT_BACKUP_MANIFEST = 'voxlibro-backup.json';

const MAX_BACKUP_UPLOAD_BYTES = 150 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 350 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;

const PROJECT_DIRS = [
  'source',
  'extracted',
  'normalized',
  'translation',
  'narrative-bible',
  'scripts',
  'audio/segments',
  'audio/chapters',
  'exports',
  'logs',
  'integrity',
];

const BACKUP_ROOTS = new Set([
  'source',
  'extracted',
  'normalized',
  'translation',
  'narrative-bible',
  'scripts',
  'integrity',
  'audio',
]);

export type ProjectBackupManifest = {
  format: typeof PROJECT_BACKUP_FORMAT;
  version: number;
  createdAt: string;
  originalProjectId: string;
  containsAudio: false;
  resumeStep: 'source' | 'translation' | 'bible' | 'casting' | 'script' | 'audio';
  project: Record<string, any>;
  files: Array<{ path: string; size: number; sha256: string }>;
};

export type ProjectStorage = {
  projectsRoot: string;
  projectsDbFile: string;
};

export type RestoreResult = {
  project: Record<string, any>;
  resumeStep: ProjectBackupManifest['resumeStep'];
  restoredFiles: number;
};

function ensureDirectory(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureProjectDirectories(projectDir: string) {
  for (const relative of PROJECT_DIRS) ensureDirectory(path.join(projectDir, relative));
}

function readProjects(projectsDbFile: string): any[] {
  if (!fs.existsSync(projectsDbFile)) return [];
  const parsed = JSON.parse(fs.readFileSync(projectsDbFile, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('Banco de projetos inválido.');
  return parsed;
}

function writeProjects(projectsDbFile: string, projects: any[]) {
  ensureDirectory(path.dirname(projectsDbFile));
  const temporary = `${projectsDbFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(projects, null, 2));
  fs.renameSync(temporary, projectsDbFile);
}

function sha256(buffer: Buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sanitizeFileName(value: string) {
  const cleaned = (value || 'projeto')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return cleaned || 'projeto';
}

function redactSensitiveProjectFields(value: any): any {
  if (Array.isArray(value)) return value.map(redactSensitiveProjectFields);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(api.?key|token|secret|password|credential|authorization)/i.test(key)) continue;
    result[key] = redactSensitiveProjectFields(item);
  }
  return result;
}

function normalizeArchivePath(entryName: string) {
  const normalized = path.posix.normalize(entryName.replace(/\\/g, '/'));
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.includes('\0')
  ) {
    throw new Error(`Entrada insegura no pacote: ${entryName}`);
  }
  return normalized.replace(/^\.\//, '');
}

function isIncludedInBackup(relativePath: string) {
  const normalized = normalizeArchivePath(relativePath);
  if (!normalized || normalized.endsWith('/')) return false;
  if (normalized === 'projects.json') return false;
  if (normalized.startsWith('audio/segments/') || normalized.startsWith('audio/chapters/')) return false;
  if (normalized.startsWith('exports/') || normalized.startsWith('logs/')) return false;
  if (normalized.startsWith('audio/') && normalized !== 'audio/context-sounds.json') return false;
  return BACKUP_ROOTS.has(normalized.split('/')[0]);
}

function collectFiles(rootDir: string, currentDir = rootDir): string[] {
  if (!fs.existsSync(currentDir)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const absolute = path.join(currentDir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) result.push(...collectFiles(rootDir, absolute));
    if (entry.isFile()) {
      const relative = path.relative(rootDir, absolute).split(path.sep).join('/');
      if (isIncludedInBackup(relative)) result.push(relative);
    }
  }
  return result.sort();
}

function inferResumeStep(projectDir: string): ProjectBackupManifest['resumeStep'] {
  const segmentsPath = path.join(projectDir, 'scripts', 'segments.json');
  if (fs.existsSync(segmentsPath)) {
    try {
      const segments = JSON.parse(fs.readFileSync(segmentsPath, 'utf8'));
      if (Array.isArray(segments) && segments.length > 0) return 'audio';
    } catch {
      // Validation during restore will provide the actionable error.
    }
  }
  if (fs.existsSync(path.join(projectDir, 'narrative-bible', 'characters.json'))) return 'script';
  if (fs.existsSync(path.join(projectDir, 'translation', 'report.json'))) return 'bible';
  if (fs.existsSync(path.join(projectDir, 'normalized', 'chapters.json'))) return 'bible';
  return 'source';
}

export function createProjectBackupBuffer(projectId: string, storage: ProjectStorage) {
  const projects = readProjects(storage.projectsDbFile);
  const project = projects.find(item => item.projectId === projectId);
  if (!project) throw new Error('Projeto não encontrado.');

  const projectDir = path.join(storage.projectsRoot, projectId);
  if (!fs.existsSync(projectDir)) throw new Error('Pasta do projeto não encontrada.');

  const zip = new AdmZip();
  const files = collectFiles(projectDir);
  const fileManifest: ProjectBackupManifest['files'] = [];

  for (const relative of files) {
    const content = fs.readFileSync(path.join(projectDir, relative));
    zip.addFile(`project/${relative}`, content);
    fileManifest.push({ path: relative, size: content.length, sha256: sha256(content) });
  }

  const manifest: ProjectBackupManifest = {
    format: PROJECT_BACKUP_FORMAT,
    version: PROJECT_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    originalProjectId: projectId,
    containsAudio: false,
    resumeStep: inferResumeStep(projectDir),
    project: redactSensitiveProjectFields(project),
    files: fileManifest,
  };

  zip.addFile(PROJECT_BACKUP_MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  return {
    buffer: zip.toBuffer(),
    manifest,
    fileName: `${sanitizeFileName(project.name || project.userTitle || projectId)}.voxlibro.zip`,
  };
}

function validateBackup(zip: AdmZip): ProjectBackupManifest {
  const entries = zip.getEntries();
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('O pacote contém arquivos demais.');

  let totalUncompressed = 0;
  for (const entry of entries) {
    normalizeArchivePath(entry.entryName);
    totalUncompressed += Number(entry.header?.size || 0);
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error('O conteúdo descompactado excede o limite de segurança.');
  }

  const manifestEntry = zip.getEntry(PROJECT_BACKUP_MANIFEST);
  if (!manifestEntry) throw new Error('Este arquivo não é um pacote de projeto VoxLibro válido.');

  let manifest: ProjectBackupManifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch {
    throw new Error('O manifesto do projeto está corrompido.');
  }

  if (manifest.format !== PROJECT_BACKUP_FORMAT || manifest.version !== PROJECT_BACKUP_VERSION) {
    throw new Error('Versão de pacote VoxLibro não suportada.');
  }
  if (!manifest.project || !manifest.originalProjectId || !Array.isArray(manifest.files)) {
    throw new Error('Manifesto de projeto incompleto.');
  }

  const expected = new Map(manifest.files.map(file => [normalizeArchivePath(file.path), file]));
  for (const entry of entries) {
    const name = normalizeArchivePath(entry.entryName);
    if (entry.isDirectory || name === PROJECT_BACKUP_MANIFEST) continue;
    if (!name.startsWith('project/')) throw new Error(`Entrada não permitida no pacote: ${name}`);
    const relative = name.slice('project/'.length);
    if (!isIncludedInBackup(relative)) throw new Error(`Arquivo não permitido no pacote: ${relative}`);
    const record = expected.get(relative);
    if (!record) throw new Error(`Arquivo não declarado no manifesto: ${relative}`);
    const content = entry.getData();
    if (content.length !== record.size || sha256(content) !== record.sha256) {
      throw new Error(`Falha de integridade no arquivo: ${relative}`);
    }
  }

  return manifest;
}

function rewriteReferences(value: any, originalProjectId: string, newProjectId: string, newProjectDir: string): any {
  if (Array.isArray(value)) return value.map(item => rewriteReferences(item, originalProjectId, newProjectId, newProjectDir));
  if (value && typeof value === 'object') {
    const result: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) result[key] = rewriteReferences(item, originalProjectId, newProjectId, newProjectDir);
    return result;
  }
  if (typeof value !== 'string') return value;

  let rewritten = value
    .replaceAll(`/projects/${originalProjectId}`, `/projects/${newProjectId}`)
    .replaceAll(`\\projects\\${originalProjectId}`, `\\projects\\${newProjectId}`);

  if (path.isAbsolute(rewritten) && rewritten.includes(originalProjectId)) {
    const suffix = rewritten.split(originalProjectId)[1] || '';
    rewritten = path.join(newProjectDir, suffix.replace(/^[/\\]+/, ''));
  } else {
    rewritten = rewritten.replaceAll(originalProjectId, newProjectId);
  }
  return rewritten;
}

function rewriteJsonFiles(projectDir: string, originalProjectId: string, newProjectId: string) {
  for (const relative of collectFiles(projectDir)) {
    if (!relative.endsWith('.json')) continue;
    const absolute = path.join(projectDir, relative);
    try {
      const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
      const rewritten = rewriteReferences(parsed, originalProjectId, newProjectId, projectDir);
      fs.writeFileSync(absolute, JSON.stringify(rewritten, null, 2));
    } catch (error: any) {
      throw new Error(`JSON inválido no pacote (${relative}): ${error.message}`);
    }
  }
}

function resetSegmentsForAudio(projectDir: string) {
  const segmentsPath = path.join(projectDir, 'scripts', 'segments.json');
  if (!fs.existsSync(segmentsPath)) return 0;
  const segments = JSON.parse(fs.readFileSync(segmentsPath, 'utf8'));
  if (!Array.isArray(segments)) throw new Error('O roteiro restaurado não contém uma lista válida de segmentos.');

  for (const segment of segments) {
    segment.status = 'pending';
    delete segment.audioPath;
    delete segment.contextualAudioPath;
    delete segment.audioSize;
    delete segment.durationMs;
    delete segment.checksum;
    delete segment.lastError;
  }
  fs.writeFileSync(segmentsPath, JSON.stringify(segments, null, 2));
  return segments.length;
}

function appendRestoreLog(projectDir: string, projectId: string, originalProjectId: string, restoredFiles: number) {
  const logsDir = path.join(projectDir, 'logs');
  ensureDirectory(logsDir);
  const logsPath = path.join(logsDir, 'processing.json');
  let logs: any[] = [];
  if (fs.existsSync(logsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(logsPath, 'utf8'));
      if (Array.isArray(parsed)) logs = parsed;
    } catch {
      logs = [];
    }
  }
  logs.push({
    logId: `log_restore_${Date.now()}`,
    projectId,
    operation: 'restore_project_backup',
    status: 'success',
    restoredFromProjectId: originalProjectId,
    restoredFiles,
    timestamp: new Date().toISOString(),
  });
  fs.writeFileSync(logsPath, JSON.stringify(logs, null, 2));
}

function createRestoredProject(manifest: ProjectBackupManifest, newProjectId: string, segmentCount: number) {
  const now = new Date().toISOString();
  const original = redactSensitiveProjectFields(manifest.project || {});
  const status = segmentCount > 0 ? 'generating_audio' : original.status || 'awaiting_configuration';
  const restored = {
    ...original,
    projectId: newProjectId,
    ownerId: original.ownerId || 'local-owner',
    name: original.name || original.userTitle || 'Projeto restaurado',
    userTitle: original.userTitle || original.name || 'Projeto restaurado',
    status,
    createdAt: now,
    updatedAt: now,
    restoredAt: now,
    restoredFromProjectId: manifest.originalProjectId,
  };
  delete restored.lastError;
  return restored;
}

export function restoreProjectBackupBuffer(buffer: Buffer, storage: ProjectStorage): RestoreResult {
  if (!buffer?.length) throw new Error('Pacote de projeto vazio.');
  const zip = new AdmZip(buffer);
  const manifest = validateBackup(zip);
  const newProjectId = `proj_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const projectDir = path.join(storage.projectsRoot, newProjectId);

  ensureDirectory(storage.projectsRoot);
  if (fs.existsSync(projectDir)) throw new Error('Não foi possível reservar um identificador para o projeto restaurado.');
  ensureProjectDirectories(projectDir);

  let restoredFiles = 0;
  try {
    for (const entry of zip.getEntries()) {
      const name = normalizeArchivePath(entry.entryName);
      if (entry.isDirectory || name === PROJECT_BACKUP_MANIFEST) continue;
      const relative = name.slice('project/'.length);
      const absolute = path.resolve(projectDir, relative.split('/').join(path.sep));
      const safeRoot = `${path.resolve(projectDir)}${path.sep}`;
      if (!absolute.startsWith(safeRoot)) throw new Error(`Destino inseguro no pacote: ${relative}`);
      ensureDirectory(path.dirname(absolute));
      fs.writeFileSync(absolute, entry.getData());
      restoredFiles++;
    }

    rewriteJsonFiles(projectDir, manifest.originalProjectId, newProjectId);
    const segmentCount = resetSegmentsForAudio(projectDir);
    const project = createRestoredProject(manifest, newProjectId, segmentCount);
    const projects = readProjects(storage.projectsDbFile);
    projects.push(project);
    writeProjects(storage.projectsDbFile, projects);
    appendRestoreLog(projectDir, newProjectId, manifest.originalProjectId, restoredFiles);

    return {
      project,
      resumeStep: segmentCount > 0 ? 'audio' : inferResumeStep(projectDir),
      restoredFiles,
    };
  } catch (error) {
    fs.rmSync(projectDir, { recursive: true, force: true });
    throw error;
  }
}

function sendRouteError(res: Response, error: any) {
  const message = error?.message || 'Falha ao processar o pacote do projeto.';
  res.status(400).json({ error: { code: 'PROJECT_BACKUP_ERROR', message } });
}

export function registerProjectBackupRoutes(
  app: Express,
  storageProvider: () => ProjectStorage,
) {
  const backupUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BACKUP_UPLOAD_BYTES, files: 1 },
  });

  app.post('/api/projects/:projectId/backup', (req: Request, res: Response) => {
    try {
      const result = createProjectBackupBuffer(req.params.projectId, storageProvider());
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(result.buffer.length));
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`);
      res.setHeader('X-VoxLibro-Backup-Version', String(PROJECT_BACKUP_VERSION));
      res.send(result.buffer);
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  app.post('/api/projects/restore', backupUpload.single('file'), (req: Request, res: Response) => {
    try {
      if (!req.file) throw new Error('Selecione um pacote .voxlibro.zip para restaurar.');
      const lowerName = req.file.originalname.toLowerCase();
      if (!lowerName.endsWith('.zip') && !lowerName.endsWith('.voxlibro')) {
        throw new Error('Formato inválido. Use um pacote .voxlibro.zip gerado pelo VoxLibro.');
      }
      const result = restoreProjectBackupBuffer(req.file.buffer, storageProvider());
      res.status(201).json(result);
    } catch (error) {
      sendRouteError(res, error);
    }
  });
}
