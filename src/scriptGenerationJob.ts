import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  applyModeConstraints,
  sliceTextIntoSourceUnits,
  validateBatchResponse,
  type ScriptSegment,
  type SourceUnit,
} from './lib/losslessScript';

export type ScriptGenerationStorage = {
  projectsRoot: string;
  projectsDbFile: string;
};

export type ScriptGenerationDependencies = {
  generateContent: (args: any) => Promise<any>;
  hasTextAi: () => boolean;
  editorialModel: () => string;
};

type ScriptJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

type ScriptBatch = {
  batchId: string;
  index: number;
  units: SourceUnit[];
  hash: string;
};

type ScriptBatchCheckpoint = {
  version: 1;
  batchId: string;
  batchIndex: number;
  hash: string;
  source: 'ai' | 'deterministic' | 'locked';
  warning?: string;
  segments: ScriptSegment[];
  completedAt: string;
};

export type ScriptGenerationJob = {
  version: 1;
  jobId: string;
  projectId: string;
  status: ScriptJobStatus;
  sourceHash: string;
  forceFresh: boolean;
  totalBatches: number;
  completedBatchIds: string[];
  fallbackBatchIds: string[];
  currentBatchId?: string;
  currentBatchIndex?: number;
  progress: number;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: { code: string; message: string; retryable: boolean; at: string };
  summary?: {
    totalSourceUnits: number;
    totalSegments: number;
    totalUnresolved: number;
    coverage: number;
    usedDeterministicDraft: boolean;
    scriptComplete: boolean;
  };
};

const activeProjects = new Set<string>();
const BATCH_SIZE = 10;
const MAX_RETRIES = 3;

function now() {
  return new Date().toISOString();
}

function sha256(value: string | Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeProjectId(value: string) {
  const clean = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean || clean !== value) throw new Error('ID de projeto inválido.');
  return clean;
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function atomicWrite(filePath: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

function atomicWriteJson(filePath: string, value: unknown) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function projectDir(storage: ScriptGenerationStorage, projectId: string) {
  return path.join(storage.projectsRoot, projectId);
}

function scriptsDir(storage: ScriptGenerationStorage, projectId: string) {
  return path.join(projectDir(storage, projectId), 'scripts');
}

function jobPath(storage: ScriptGenerationStorage, projectId: string) {
  return path.join(scriptsDir(storage, projectId), 'generation-job.json');
}

function checkpointsDir(storage: ScriptGenerationStorage, projectId: string) {
  return path.join(scriptsDir(storage, projectId), 'generation-batches');
}

function checkpointPath(storage: ScriptGenerationStorage, projectId: string, batchId: string) {
  return path.join(checkpointsDir(storage, projectId), `${batchId}.json`);
}

function chaptersPath(storage: ScriptGenerationStorage, projectId: string) {
  return path.join(projectDir(storage, projectId), 'normalized', 'chapters.json');
}

function charactersPath(storage: ScriptGenerationStorage, projectId: string) {
  return path.join(projectDir(storage, projectId), 'narrative-bible', 'characters.json');
}

function segmentsPath(storage: ScriptGenerationStorage, projectId: string) {
  return path.join(scriptsDir(storage, projectId), 'segments.json');
}

function sourceUnitsPath(storage: ScriptGenerationStorage, projectId: string) {
  return path.join(scriptsDir(storage, projectId), 'source-units.jsonl');
}

function reportPath(storage: ScriptGenerationStorage, projectId: string) {
  return path.join(scriptsDir(storage, projectId), 'script-report.json');
}

function readProjects(storage: ScriptGenerationStorage) {
  const projects = readJson<any[]>(storage.projectsDbFile, []);
  return Array.isArray(projects) ? projects : [];
}

function writeProjects(storage: ScriptGenerationStorage, projects: any[]) {
  atomicWriteJson(storage.projectsDbFile, projects);
}

function getProject(storage: ScriptGenerationStorage, projectId: string) {
  return readProjects(storage).find(project => project.projectId === projectId);
}

function updateProject(storage: ScriptGenerationStorage, projectId: string, patch: Record<string, any>) {
  const projects = readProjects(storage);
  const project = projects.find(item => item.projectId === projectId);
  if (!project) throw new Error('Projeto não encontrado.');
  Object.assign(project, patch, { updatedAt: now() });
  writeProjects(storage, projects);
  return project;
}

function normalizeToken(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[_/|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeClassification(value: unknown): SourceUnit['type'] {
  const token = normalizeToken(value);
  if (/title|titulo|heading|cabecalho/.test(token)) return 'título';
  if (/dialog|fala|speech|utterance/.test(token)) return 'fala';
  if (/quote|citacao/.test(token)) return 'citação';
  if (/list|lista|item/.test(token)) return 'lista';
  if (/note|nota|footnote|rodape/.test(token)) return 'nota';
  if (/formula|equation|equacao/.test(token)) return 'fórmula';
  return 'parágrafo';
}

function normalizePace(value: unknown): 'slow' | 'normal' | 'fast' {
  const token = normalizeToken(value);
  if (/slow|lento|devagar|pausad/.test(token)) return 'slow';
  if (/fast|rapid|acelerad|quick/.test(token)) return 'fast';
  return 'normal';
}

function clamp(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function stripJsonFence(text: string) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

export function normalizeScriptGenerationResponseObject(value: any) {
  const root = Array.isArray(value) ? { segments: value } : (value && typeof value === 'object' ? value : {});
  const rawSegments = Array.isArray(root.segments)
    ? root.segments
    : Array.isArray(root.results)
      ? root.results
      : Array.isArray(root.items)
        ? root.items
        : [];

  return {
    ...root,
    segments: rawSegments.map((item: any) => {
      const source = item && typeof item === 'object' ? item : {};
      const directionSource = source.direction && typeof source.direction === 'object'
        ? source.direction
        : source.voiceDirection && typeof source.voiceDirection === 'object'
          ? source.voiceDirection
          : {};
      return {
        sourceUnitId: String(
          source.sourceUnitId ?? source.source_unit_id ?? source.unitId ?? source.unit_id ?? source.id ?? '',
        ).trim(),
        classificação: normalizeClassification(
          source.classificação ?? source.classificacao ?? source.classification ?? source.type ?? source.tipo,
        ),
        speakerId: String(
          source.speakerId ?? source.speaker_id ?? source.characterId ?? source.character_id ?? source.speaker ?? 'unresolved',
        ).trim() || 'unresolved',
        spokenText: String(
          source.spokenText ?? source.spoken_text ?? source.text ?? source.dialogue ?? source.content ?? '',
        ),
        direction: {
          emotion: String(directionSource.emotion ?? directionSource.emocao ?? source.emotion ?? 'neutral').trim() || 'neutral',
          intensity: clamp(directionSource.intensity ?? directionSource.intensidade ?? source.intensity, 0, 1, 0.5),
          pace: normalizePace(directionSource.pace ?? directionSource.ritmo ?? source.pace),
          pauseAfterMs: Math.round(clamp(
            directionSource.pauseAfterMs ?? directionSource.pause_after_ms ?? directionSource.pause ?? source.pauseAfterMs,
            0,
            10_000,
            300,
          )),
        },
      };
    }),
  };
}

export function parseAndNormalizeScriptGenerationResponse(text: string) {
  const parsed = JSON.parse(stripJsonFence(text));
  return normalizeScriptGenerationResponseObject(parsed);
}

function stableSegmentId(sourceUnitId: string) {
  return `seg_${sha256(sourceUnitId).slice(0, 24)}`;
}

function prepareUnits(chapters: any[]) {
  const units: SourceUnit[] = [];
  for (const chapter of chapters) {
    const text = String(chapter.translatedText || chapter.originalText || '');
    if (!text.trim()) continue;
    units.push(...sliceTextIntoSourceUnits(text, String(chapter.chapterId)));
  }
  return units;
}

function prepareBatches(units: SourceUnit[]) {
  const batches: ScriptBatch[] = [];
  for (let index = 0; index < units.length; index += BATCH_SIZE) {
    const batchUnits = units.slice(index, index + BATCH_SIZE);
    const hash = sha256(batchUnits.map(unit => `${unit.sourceUnitId}:${sha256(unit.sourceText)}`).join('|'));
    batches.push({
      batchId: `script_batch_${hash.slice(0, 20)}`,
      index: batches.length,
      units: batchUnits,
      hash,
    });
  }
  return batches;
}

function calculateSourceHash(project: any, units: SourceUnit[], characters: any[]) {
  const characterSnapshot = characters.map(character => ({
    characterId: character.characterId,
    canonicalName: character.canonicalName,
    aliases: character.aliases,
    role: character.role,
  }));
  return sha256(JSON.stringify({
    mode: project.productionMode || 'audiobook',
    intensity: project.intensity ?? 0.5,
    units: units.map(unit => ({ id: unit.sourceUnitId, text: unit.sourceText, type: unit.type })),
    characters: characterSnapshot,
  }));
}

function progressFor(job: ScriptGenerationJob) {
  if (job.status === 'completed') return 100;
  if (!job.totalBatches) return 0;
  return Math.min(99, Math.round((job.completedBatchIds.length / job.totalBatches) * 100));
}

function persistJob(storage: ScriptGenerationStorage, job: ScriptGenerationJob) {
  job.progress = progressFor(job);
  job.updatedAt = now();
  atomicWriteJson(jobPath(storage, job.projectId), job);
  return job;
}

export function readScriptGenerationJob(storage: ScriptGenerationStorage, projectIdInput: string) {
  const projectId = safeProjectId(projectIdInput);
  return readJson<ScriptGenerationJob | null>(jobPath(storage, projectId), null);
}

function readLockedSegments(storage: ScriptGenerationStorage, projectId: string) {
  const existing = readJson<any[]>(segmentsPath(storage, projectId), []);
  const locked = new Map<string, any>();
  for (const segment of existing) {
    if (segment?.locked && segment?.sourceUnitId) locked.set(segment.sourceUnitId, segment);
  }
  return locked;
}

function speakerAliases(characters: any[]) {
  return characters
    .filter(character => character.characterId !== 'char_narrator')
    .flatMap(character => [character.canonicalName, ...(Array.isArray(character.aliases) ? character.aliases : [])]
      .filter(Boolean)
      .map(name => ({ characterId: character.characterId, name: String(name), normalized: normalizeToken(name) })))
    .sort((a, b) => b.normalized.length - a.normalized.length);
}

function inferSpeaker(unit: SourceUnit, characters: any[]) {
  if (unit.type !== 'fala') return 'char_narrator';
  const text = normalizeToken(unit.sourceText);
  const aliases = speakerAliases(characters);
  const prefix = normalizeToken(unit.sourceText.split(':', 1)[0]);
  const prefixMatch = aliases.find(alias => prefix && alias.normalized === prefix);
  if (prefixMatch) return prefixMatch.characterId;

  const speechTag = text.match(/\b(?:disse|perguntou|respondeu|gritou|sussurrou|afirmou|murmurou|continuou)\s+([\p{L}'-]+(?:\s+[\p{L}'-]+)?)/u)?.[1];
  if (speechTag) {
    const tag = normalizeToken(speechTag);
    const tagMatch = aliases.find(alias => alias.normalized === tag || tag.includes(alias.normalized));
    if (tagMatch) return tagMatch.characterId;
  }

  const mention = aliases.find(alias => alias.normalized.length > 2 && text.includes(alias.normalized));
  return mention?.characterId || 'unresolved';
}

function deterministicSegments(
  batch: ScriptBatch,
  project: any,
  characters: any[],
  locked: Map<string, any>,
) {
  return batch.units.map(unit => {
    const preserved = locked.get(unit.sourceUnitId);
    if (preserved) return preserved;
    const segment: ScriptSegment & { draftSource?: string } = {
      segmentId: stableSegmentId(unit.sourceUnitId),
      projectId: project.projectId,
      chapterId: unit.chapterId,
      sourceUnitId: unit.sourceUnitId,
      order: unit.order,
      type: unit.type,
      speakerId: inferSpeaker(unit, characters),
      originalText: unit.sourceText,
      spokenText: unit.type === 'fala'
        ? unit.sourceText.replace(/^["'“”‘’—–\-\s]*/, '').replace(/["'“”‘’—–\-\s]*$/, '')
        : unit.sourceText,
      direction: {
        emotion: unit.type === 'fala' ? 'expressivo' : 'informativo',
        intensity: project.intensity ?? 0.5,
        pace: 'normal',
        pauseAfterMs: 300,
      },
      status: 'pending',
      draftSource: 'deterministic_review',
    };
    return applyModeConstraints(segment, project.productionMode || 'audiobook', project.intensity);
  });
}

function buildPrompt(batch: ScriptBatch, characters: any[]) {
  return `Você é um fatiador e rotulador de roteiro altamente preciso para audiolivros e audiodramas.
Retorne JSON sem markdown. Deve haver exatamente um segmento para cada sourceUnitId, na mesma ordem, sem omitir nem inventar IDs.

Personagens disponíveis:
${JSON.stringify(characters.map(character => ({
  characterId: character.characterId,
  name: character.canonicalName,
  aliases: character.aliases || [],
  role: character.role,
})))}

Regras:
1. classificação: título, parágrafo, fala, citação, lista, nota ou fórmula.
2. speakerId deve ser um characterId listado, char_narrator ou unresolved.
3. Para fala ambígua, use unresolved; nunca invente personagem.
4. spokenText preserva todo o conteúdo sem resumir, apenas remove marcas tipográficas externas de diálogo quando apropriado.
5. direction contém emotion, intensity de 0 a 1, pace slow|normal|fast e pauseAfterMs.
6. Responda como {"segments":[...]}.

sourceUnits:
${JSON.stringify(batch.units.map(unit => ({
  sourceUnitId: unit.sourceUnitId,
  chapterId: unit.chapterId,
  type: unit.type,
  sourceText: unit.sourceText,
})))}`;
}

async function generateWithRetry(
  dependencies: ScriptGenerationDependencies,
  args: any,
) {
  let lastError: any;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await dependencies.generateContent(args);
    } catch (error: any) {
      lastError = error;
      if (error?.retryable === false || attempt === MAX_RETRIES) break;
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError || new Error('Falha ao gerar o lote do roteiro.');
}

async function processBatch(
  dependencies: ScriptGenerationDependencies,
  batch: ScriptBatch,
  project: any,
  characters: any[],
  locked: Map<string, any>,
): Promise<ScriptBatchCheckpoint> {
  const allLocked = batch.units.every(unit => locked.has(unit.sourceUnitId));
  if (allLocked) {
    return {
      version: 1,
      batchId: batch.batchId,
      batchIndex: batch.index,
      hash: batch.hash,
      source: 'locked',
      segments: batch.units.map(unit => locked.get(unit.sourceUnitId)),
      completedAt: now(),
    };
  }

  if (dependencies.hasTextAi()) {
    try {
      const response = await generateWithRetry(dependencies, {
        model: dependencies.editorialModel(),
        contents: [{ text: buildPrompt(batch, characters) }],
        config: { responseMimeType: 'application/json' },
      });
      const normalized = parseAndNormalizeScriptGenerationResponse(String(response?.text || ''));
      const characterIds = characters.map(character => character.characterId);
      const validated = validateBatchResponse(normalized, batch.units, characterIds).map(segment => {
        const preserved = locked.get(segment.sourceUnitId);
        if (preserved) return preserved;
        const next = {
          ...segment,
          segmentId: stableSegmentId(segment.sourceUnitId),
          projectId: project.projectId,
          status: 'pending' as const,
          draftSource: 'ai',
        };
        return applyModeConstraints(next, project.productionMode || 'audiobook', project.intensity);
      });
      return {
        version: 1,
        batchId: batch.batchId,
        batchIndex: batch.index,
        hash: batch.hash,
        source: 'ai',
        segments: validated,
        completedAt: now(),
      };
    } catch (error: any) {
      return {
        version: 1,
        batchId: batch.batchId,
        batchIndex: batch.index,
        hash: batch.hash,
        source: 'deterministic',
        warning: error?.message || String(error),
        segments: deterministicSegments(batch, project, characters, locked),
        completedAt: now(),
      };
    }
  }

  return {
    version: 1,
    batchId: batch.batchId,
    batchIndex: batch.index,
    hash: batch.hash,
    source: 'deterministic',
    warning: 'OPENAI_API_KEY não configurada; rascunho determinístico gerado.',
    segments: deterministicSegments(batch, project, characters, locked),
    completedAt: now(),
  };
}

function readSourceUnits(storage: ScriptGenerationStorage, projectId: string) {
  if (!fs.existsSync(sourceUnitsPath(storage, projectId))) return [] as SourceUnit[];
  return fs.readFileSync(sourceUnitsPath(storage, projectId), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as SourceUnit);
}

export function buildScriptReport(
  projectId: string,
  chapters: any[],
  units: SourceUnit[],
  segments: any[],
  fallbackBatchIds: string[] = [],
) {
  const expectedIds = new Set(units.map(unit => unit.sourceUnitId));
  const counts = new Map<string, number>();
  for (const segment of segments) {
    const id = String(segment?.sourceUnitId || '');
    if (expectedIds.has(id)) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const missingUnitIds = units.filter(unit => !counts.has(unit.sourceUnitId)).map(unit => unit.sourceUnitId);
  const duplicatedUnitIds = Array.from(counts.entries()).filter(([, count]) => count > 1).map(([id]) => id);
  const mappedCount = expectedIds.size - missingUnitIds.length;
  const coverage = expectedIds.size ? Math.round((mappedCount / expectedIds.size) * 100) : 100;
  const unresolvedSpeakers = segments
    .filter(segment => segment.speakerId === 'unresolved')
    .map(segment => ({
      segmentId: segment.segmentId,
      sourceUnitId: segment.sourceUnitId,
      chapterId: segment.chapterId,
      originalText: segment.originalText,
      suggestedSpeaker: 'unresolved',
    }));
  const scriptComplete = coverage === 100 && !missingUnitIds.length && !duplicatedUnitIds.length && !unresolvedSpeakers.length;
  const chaptersSummary = chapters.map(chapter => ({
    chapterId: chapter.chapterId,
    title: chapter.title,
    sourceUnitsCount: units.filter(unit => unit.chapterId === chapter.chapterId).length,
    segmentsCount: segments.filter(segment => segment.chapterId === chapter.chapterId).length,
  }));
  const ledgerNonNarrated = missingUnitIds.map(sourceUnitId => ({
    sourceUnitId,
    reason: 'Unidade ainda não mapeada no roteiro.',
    userDecision: 'pending',
  }));
  return {
    projectId,
    status: scriptComplete ? 'PASS' : 'FAIL',
    coverage,
    totalSourceUnits: units.length,
    totalSegments: segments.length,
    totalBatches: Math.ceil(units.length / BATCH_SIZE),
    totalUnresolved: unresolvedSpeakers.length,
    scriptComplete,
    unresolvedSpeakers,
    chaptersSummary,
    ledgerNonNarrated,
    missingUnitIds,
    duplicatedUnitIds,
    fallbackBatchIds,
    usedDeterministicDraft: fallbackBatchIds.length > 0,
    qualityWarnings: [
      ...(fallbackBatchIds.length ? [`${fallbackBatchIds.length} lote(s) usaram rascunho determinístico e devem ser revisados.`] : []),
      ...(unresolvedSpeakers.length ? [`${unresolvedSpeakers.length} fala(s) aguardam definição de locutor.`] : []),
    ],
    generatedAt: now(),
  };
}

function publishScript(
  storage: ScriptGenerationStorage,
  project: any,
  chapters: any[],
  units: SourceUnit[],
  batches: ScriptBatch[],
  job: ScriptGenerationJob,
) {
  const checkpoints = batches.map(batch => {
    const checkpoint = readJson<ScriptBatchCheckpoint | null>(checkpointPath(storage, project.projectId, batch.batchId), null);
    if (!checkpoint || checkpoint.hash !== batch.hash) throw new Error(`Checkpoint ausente ou incompatível: ${batch.batchId}`);
    return checkpoint;
  });
  const bySourceUnit = new Map<string, any>();
  for (const checkpoint of checkpoints) {
    for (const segment of checkpoint.segments) {
      if (bySourceUnit.has(segment.sourceUnitId)) throw new Error(`Segmento duplicado para ${segment.sourceUnitId}`);
      bySourceUnit.set(segment.sourceUnitId, segment);
    }
  }
  const segments = units.map((unit, index) => {
    const segment = bySourceUnit.get(unit.sourceUnitId);
    if (!segment) throw new Error(`Segmento ausente para ${unit.sourceUnitId}`);
    return { ...segment, order: index + 1 };
  });

  const dir = scriptsDir(storage, project.projectId);
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(sourceUnitsPath(storage, project.projectId), `${units.map(unit => JSON.stringify(unit)).join('\n')}\n`);
  atomicWrite(path.join(dir, 'segments.jsonl'), `${segments.map(segment => JSON.stringify(segment)).join('\n')}\n`);
  atomicWriteJson(segmentsPath(storage, project.projectId), segments);

  const ttsDir = path.join(dir, 'tts-input');
  fs.rmSync(ttsDir, { recursive: true, force: true });
  fs.mkdirSync(ttsDir, { recursive: true });
  for (const segment of segments) {
    atomicWrite(path.join(ttsDir, `${segment.segmentId}.txt`), String(segment.spokenText || ''));
  }

  const report = buildScriptReport(project.projectId, chapters, units, segments, job.fallbackBatchIds);
  atomicWriteJson(reportPath(storage, project.projectId), report);
  atomicWriteJson(path.join(dir, 'ledger-non-narrated.json'), report.ledgerNonNarrated);
  const updatedProject = updateProject(storage, project.projectId, {
    status: report.scriptComplete ? 'generating_audio' : 'scripting',
    lastError: undefined,
  });
  return { project: updatedProject, segments, report };
}

async function processJob(
  storage: ScriptGenerationStorage,
  dependencies: ScriptGenerationDependencies,
  projectId: string,
) {
  if (activeProjects.has(projectId)) return;
  activeProjects.add(projectId);
  let job = readScriptGenerationJob(storage, projectId);
  try {
    if (!job || ['completed', 'cancelled'].includes(job.status)) return;
    const project = getProject(storage, projectId);
    if (!project) throw new Error('Projeto não encontrado.');
    const chapters = readJson<any[]>(chaptersPath(storage, projectId), []);
    const characters = readJson<any[]>(charactersPath(storage, projectId), []);
    if (!chapters.length) throw new Error('Faltam capítulos estruturados para o roteiro.');
    if (!characters.length) throw new Error('Falta Bíblia de personagens para o roteiro.');
    const units = prepareUnits(chapters);
    if (!units.length) throw new Error('Nenhuma unidade textual foi encontrada para o roteiro.');
    const batches = prepareBatches(units);
    const expectedSourceHash = calculateSourceHash(project, units, characters);
    if (job.sourceHash !== expectedSourceHash) throw new Error('A obra ou o elenco mudou. Inicie novamente a geração do roteiro.');

    job.status = 'processing';
    job.startedAt ||= now();
    job.attempts += 1;
    job.lastError = undefined;
    persistJob(storage, job);
    updateProject(storage, projectId, { status: 'scripting', lastError: undefined });

    const locked = readLockedSegments(storage, projectId);
    const completed = new Set(job.completedBatchIds);
    const fallbacks = new Set(job.fallbackBatchIds);

    for (const batch of batches) {
      job = readScriptGenerationJob(storage, projectId) || job;
      if (job.status === 'cancelled') return;
      if (completed.has(batch.batchId)) {
        const checkpoint = readJson<ScriptBatchCheckpoint | null>(checkpointPath(storage, projectId, batch.batchId), null);
        if (checkpoint?.hash === batch.hash) continue;
        completed.delete(batch.batchId);
      }

      job.currentBatchId = batch.batchId;
      job.currentBatchIndex = batch.index + 1;
      persistJob(storage, job);
      const checkpoint = await processBatch(dependencies, batch, project, characters, locked);
      atomicWriteJson(checkpointPath(storage, projectId, batch.batchId), checkpoint);
      completed.add(batch.batchId);
      if (checkpoint.source === 'deterministic') fallbacks.add(batch.batchId);
      else fallbacks.delete(batch.batchId);
      job.completedBatchIds = Array.from(completed);
      job.fallbackBatchIds = Array.from(fallbacks);
      job.currentBatchId = undefined;
      job.currentBatchIndex = undefined;
      persistJob(storage, job);
    }

    const result = publishScript(storage, project, chapters, units, batches, job);
    job.status = 'completed';
    job.progress = 100;
    job.currentBatchId = undefined;
    job.currentBatchIndex = undefined;
    job.completedAt = now();
    job.summary = {
      totalSourceUnits: result.report.totalSourceUnits,
      totalSegments: result.report.totalSegments,
      totalUnresolved: result.report.totalUnresolved,
      coverage: result.report.coverage,
      usedDeterministicDraft: result.report.usedDeterministicDraft,
      scriptComplete: result.report.scriptComplete,
    };
    persistJob(storage, job);
  } catch (error: any) {
    job = readScriptGenerationJob(storage, projectId) || job;
    if (job) {
      job.status = 'failed';
      job.currentBatchId = undefined;
      job.currentBatchIndex = undefined;
      job.lastError = {
        code: 'SCRIPT_GENERATION_INTERRUPTED',
        message: error?.message || String(error),
        retryable: true,
        at: now(),
      };
      persistJob(storage, job);
      try {
        updateProject(storage, projectId, { status: 'scripting', lastError: job.lastError });
      } catch {
        // O job continua recuperável pelo arquivo persistido.
      }
    }
  } finally {
    activeProjects.delete(projectId);
  }
}

function launch(
  storage: ScriptGenerationStorage,
  dependencies: ScriptGenerationDependencies,
  projectId: string,
) {
  if (activeProjects.has(projectId)) return;
  setTimeout(() => void processJob(storage, dependencies, projectId), 0);
}

function loadResult(storage: ScriptGenerationStorage, projectId: string) {
  return {
    project: getProject(storage, projectId),
    segments: readJson<any[]>(segmentsPath(storage, projectId), []),
    report: readJson<any>(reportPath(storage, projectId), null),
  };
}

function publicStatus(storage: ScriptGenerationStorage, job: ScriptGenerationJob) {
  const payload: any = { job };
  if (job.status === 'completed') payload.result = loadResult(storage, job.projectId);
  return payload;
}

function createJob(projectId: string, sourceHash: string, totalBatches: number, forceFresh: boolean): ScriptGenerationJob {
  const timestamp = now();
  return {
    version: 1,
    jobId: `script_job_${crypto.randomUUID()}`,
    projectId,
    status: 'queued',
    sourceHash,
    forceFresh,
    totalBatches,
    completedBatchIds: [],
    fallbackBatchIds: [],
    progress: 0,
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function invalidateAudio(storage: ScriptGenerationStorage, projectId: string, segment: any) {
  const candidates = [
    segment.audioPath ? path.join(projectDir(storage, projectId), 'audio', 'segments', path.basename(segment.audioPath)) : '',
    segment.contextualAudioPath ? path.join(projectDir(storage, projectId), 'audio', 'contextualized', path.basename(segment.contextualAudioPath)) : '',
  ].filter(Boolean);
  for (const candidate of candidates) fs.rmSync(candidate, { force: true });
}

function refreshReportAfterEdit(storage: ScriptGenerationStorage, projectId: string) {
  const chapters = readJson<any[]>(chaptersPath(storage, projectId), []);
  const units = readSourceUnits(storage, projectId);
  const segments = readJson<any[]>(segmentsPath(storage, projectId), []);
  const job = readScriptGenerationJob(storage, projectId);
  const report = buildScriptReport(projectId, chapters, units, segments, job?.fallbackBatchIds || []);
  atomicWriteJson(reportPath(storage, projectId), report);
  const project = updateProject(storage, projectId, {
    status: report.scriptComplete ? 'generating_audio' : 'scripting',
    lastError: undefined,
  });
  if (job?.status === 'completed') {
    job.summary = {
      totalSourceUnits: report.totalSourceUnits,
      totalSegments: report.totalSegments,
      totalUnresolved: report.totalUnresolved,
      coverage: report.coverage,
      usedDeterministicDraft: report.usedDeterministicDraft,
      scriptComplete: report.scriptComplete,
    };
    persistJob(storage, job);
  }
  return { project, report };
}

export function registerScriptGenerationJobRoutes(
  app: Express,
  storageProvider: () => ScriptGenerationStorage,
  dependencies: ScriptGenerationDependencies,
) {
  app.post('/api/projects/:projectId/script-generation/start', (req: Request, res: Response) => {
    try {
      const storage = storageProvider();
      const projectId = safeProjectId(req.params.projectId);
      const project = getProject(storage, projectId);
      if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Projeto não encontrado.' } });
      const chapters = readJson<any[]>(chaptersPath(storage, projectId), []);
      const characters = readJson<any[]>(charactersPath(storage, projectId), []);
      const units = prepareUnits(chapters);
      if (!units.length) return res.status(409).json({ error: { code: 'SCRIPT_SOURCE_EMPTY', message: 'A obra não possui texto para o roteiro.' } });
      if (!characters.length) return res.status(409).json({ error: { code: 'SCRIPT_CHARACTERS_EMPTY', message: 'Conclua a Bíblia e o elenco antes do roteiro.' } });
      const batches = prepareBatches(units);
      const currentSourceHash = calculateSourceHash(project, units, characters);
      const forceFresh = req.body?.forceFresh === true;
      let job = readScriptGenerationJob(storage, projectId);
      const canResume = job && ['queued', 'processing', 'failed'].includes(job.status) && job.sourceHash === currentSourceHash && !forceFresh;
      if (!canResume) {
        fs.rmSync(checkpointsDir(storage, projectId), { recursive: true, force: true });
        job = createJob(projectId, currentSourceHash, batches.length, forceFresh || job?.status === 'completed');
      } else {
        job!.status = 'queued';
        job!.lastError = undefined;
        job!.totalBatches = batches.length;
      }
      persistJob(storage, job!);
      updateProject(storage, projectId, { status: 'scripting', lastError: undefined });
      launch(storage, dependencies, projectId);
      return res.status(202).json(publicStatus(storage, job!));
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'SCRIPT_GENERATION_START_FAILED', message: error?.message || 'Não foi possível iniciar o roteiro.' } });
    }
  });

  app.get('/api/projects/:projectId/script-generation/status', (req: Request, res: Response) => {
    try {
      const storage = storageProvider();
      const projectId = safeProjectId(req.params.projectId);
      const job = readScriptGenerationJob(storage, projectId);
      if (!job) return res.status(404).json({ error: { code: 'SCRIPT_GENERATION_JOB_NOT_FOUND', message: 'Nenhuma geração de roteiro foi iniciada.' } });
      if (['queued', 'processing'].includes(job.status)) launch(storage, dependencies, projectId);
      res.setHeader('Cache-Control', 'no-store');
      return res.json(publicStatus(storage, job));
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'SCRIPT_GENERATION_STATUS_FAILED', message: error?.message || 'Não foi possível consultar o roteiro.' } });
    }
  });

  app.post('/api/projects/:projectId/script-generation/cancel', (req: Request, res: Response) => {
    try {
      const storage = storageProvider();
      const projectId = safeProjectId(req.params.projectId);
      const job = readScriptGenerationJob(storage, projectId);
      if (!job) return res.status(404).json({ error: { code: 'SCRIPT_GENERATION_JOB_NOT_FOUND', message: 'Nenhuma geração de roteiro foi iniciada.' } });
      job.status = 'cancelled';
      job.currentBatchId = undefined;
      job.currentBatchIndex = undefined;
      persistJob(storage, job);
      return res.json(publicStatus(storage, job));
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'SCRIPT_GENERATION_CANCEL_FAILED', message: error?.message || 'Não foi possível cancelar o roteiro.' } });
    }
  });

  app.put('/api/projects/:projectId/script-generation/segments/:segmentId', (req: Request, res: Response) => {
    try {
      const storage = storageProvider();
      const projectId = safeProjectId(req.params.projectId);
      const segmentId = String(req.params.segmentId || '');
      const segments = readJson<any[]>(segmentsPath(storage, projectId), []);
      const segment = segments.find(item => item.segmentId === segmentId);
      if (!segment) return res.status(404).json({ error: { code: 'SCRIPT_SEGMENT_NOT_FOUND', message: 'Trecho do roteiro não encontrado.' } });
      const characters = readJson<any[]>(charactersPath(storage, projectId), []);
      const allowedSpeakers = new Set(['char_narrator', 'unresolved', ...characters.map(character => character.characterId)]);
      const speakerId = req.body?.speakerId === undefined ? segment.speakerId : String(req.body.speakerId);
      if (!allowedSpeakers.has(speakerId)) return res.status(409).json({ error: { code: 'SCRIPT_SPEAKER_INVALID', message: 'O locutor selecionado não pertence à Bíblia.' } });
      const spokenText = req.body?.spokenText === undefined ? segment.spokenText : String(req.body.spokenText);
      if (!spokenText.trim()) return res.status(409).json({ error: { code: 'SCRIPT_TEXT_EMPTY', message: 'O texto falado não pode ficar vazio.' } });
      invalidateAudio(storage, projectId, segment);
      Object.assign(segment, {
        spokenText,
        speakerId,
        direction: { ...segment.direction, ...(req.body?.direction || {}) },
        status: 'pending',
        audioPath: undefined,
        contextualAudioPath: undefined,
        durationMs: undefined,
        checksum: undefined,
        lastError: undefined,
        manuallyReviewed: true,
      });
      atomicWriteJson(segmentsPath(storage, projectId), segments);
      atomicWrite(path.join(scriptsDir(storage, projectId), 'segments.jsonl'), `${segments.map(item => JSON.stringify(item)).join('\n')}\n`);
      atomicWrite(path.join(scriptsDir(storage, projectId), 'tts-input', `${segment.segmentId}.txt`), segment.spokenText);
      const refreshed = refreshReportAfterEdit(storage, projectId);
      return res.json({ success: true, segment, ...refreshed });
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'SCRIPT_SEGMENT_UPDATE_FAILED', message: error?.message || 'Não foi possível atualizar o trecho.' } });
    }
  });

  setTimeout(() => {
    const storage = storageProvider();
    for (const project of readProjects(storage)) {
      const job = readScriptGenerationJob(storage, String(project.projectId || ''));
      if (job && ['queued', 'processing'].includes(job.status)) launch(storage, dependencies, job.projectId);
    }
  }, 0);
}

export function resetScriptGenerationRuntimeForTests() {
  activeProjects.clear();
}
