import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { buildScriptReport, readScriptGenerationJob } from './scriptGenerationJob';
import type { SourceUnit } from './lib/losslessScript';

export type ScriptContextReviewStorage = {
  projectsRoot: string;
  projectsDbFile: string;
};

export type ScriptContextReviewDependencies = {
  generateContent: (args: any) => Promise<any>;
  hasTextAi: () => boolean;
  editorialModel: () => string;
  auditModel: () => string;
};

type ReviewMode = 'pending_speakers' | 'final_audit';
type ReviewJobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
type SuggestionStatus = 'pending' | 'applied' | 'rejected' | 'superseded' | 'stale';

type ReviewWorkItem = {
  workItemId: string;
  chapterId: string;
  targetSegmentIds: string[];
  contextSegmentIds: string[];
  hash: string;
};

type ReviewCheckpoint = {
  version: 1;
  mode: ReviewMode;
  workItemId: string;
  hash: string;
  suggestions: ScriptContextSuggestion[];
  completedAt: string;
};

export type ScriptContextSuggestion = {
  version: 1;
  suggestionId: string;
  projectId: string;
  mode: ReviewMode;
  segmentId: string;
  sourceUnitId: string;
  chapterId: string;
  category: 'pending_speaker' | 'speaker_continuity' | 'narration_role' | 'alias_identity' | 'direction_consistency' | 'text_fidelity' | 'scene_continuity';
  current: { speakerId: string; spokenText: string; direction: any };
  suggested: { speakerId?: string; spokenText?: string; direction?: any };
  confidence: number;
  reason: string;
  evidence: string[];
  status: SuggestionStatus;
  segmentHash: string;
  createdAt: string;
  appliedAt?: string;
  rejectedAt?: string;
  staleAt?: string;
};

export type ScriptContextReviewJob = {
  version: 1;
  jobId: string;
  projectId: string;
  mode: ReviewMode;
  status: ReviewJobStatus;
  sourceHash: string;
  totalItems: number;
  completedWorkItemIds: string[];
  currentWorkItemId?: string;
  currentChapterId?: string;
  progress: number;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: { code: string; message: string; retryable: boolean; at: string };
  summary?: { suggestions: number; highConfidence: number; unresolvedBefore: number; unresolvedAfter: number };
};

const activeJobs = new Set<string>();
const MAX_RETRIES = 3;
const AUDIT_WINDOW_SIZE = 28;
const AUDIT_OVERLAP = 6;

function now() { return new Date().toISOString(); }
function sha256(value: string | Buffer) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeProjectId(value: string) {
  const clean = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean || clean !== value) throw new Error('ID de projeto inválido.');
  return clean;
}
function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T; } catch { return fallback; }
}
function atomicWrite(filePath: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, filePath);
}
function atomicWriteJson(filePath: string, value: unknown) { atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`); }
function projectDir(storage: ScriptContextReviewStorage, projectId: string) { return path.join(storage.projectsRoot, projectId); }
function scriptsDir(storage: ScriptContextReviewStorage, projectId: string) { return path.join(projectDir(storage, projectId), 'scripts'); }
function chaptersPath(storage: ScriptContextReviewStorage, projectId: string) { return path.join(projectDir(storage, projectId), 'normalized', 'chapters.json'); }
function charactersPath(storage: ScriptContextReviewStorage, projectId: string) { return path.join(projectDir(storage, projectId), 'narrative-bible', 'characters.json'); }
function sightingsPath(storage: ScriptContextReviewStorage, projectId: string) { return path.join(projectDir(storage, projectId), 'narrative-bible', 'sightings.json'); }
function segmentsPath(storage: ScriptContextReviewStorage, projectId: string) { return path.join(scriptsDir(storage, projectId), 'segments.json'); }
function sourceUnitsPath(storage: ScriptContextReviewStorage, projectId: string) { return path.join(scriptsDir(storage, projectId), 'source-units.jsonl'); }
function scriptReportPath(storage: ScriptContextReviewStorage, projectId: string) { return path.join(scriptsDir(storage, projectId), 'script-report.json'); }
function suggestionsPath(storage: ScriptContextReviewStorage, projectId: string) { return path.join(scriptsDir(storage, projectId), 'review-suggestions.json'); }
function finalReportPath(storage: ScriptContextReviewStorage, projectId: string) { return path.join(scriptsDir(storage, projectId), 'final-review-report.json'); }
function jobPath(storage: ScriptContextReviewStorage, projectId: string, mode: ReviewMode) { return path.join(scriptsDir(storage, projectId), `${mode.replace('_', '-')}-job.json`); }
function checkpointsDir(storage: ScriptContextReviewStorage, projectId: string, mode: ReviewMode) { return path.join(scriptsDir(storage, projectId), 'review-checkpoints', mode); }
function checkpointPath(storage: ScriptContextReviewStorage, projectId: string, mode: ReviewMode, workItemId: string) { return path.join(checkpointsDir(storage, projectId, mode), `${workItemId}.json`); }
function readProjects(storage: ScriptContextReviewStorage) {
  const projects = readJson<any[]>(storage.projectsDbFile, []);
  return Array.isArray(projects) ? projects : [];
}
function writeProjects(storage: ScriptContextReviewStorage, projects: any[]) { atomicWriteJson(storage.projectsDbFile, projects); }
function getProject(storage: ScriptContextReviewStorage, projectId: string) { return readProjects(storage).find(project => project.projectId === projectId); }
function updateProject(storage: ScriptContextReviewStorage, projectId: string, patch: Record<string, any>) {
  const projects = readProjects(storage);
  const project = projects.find(item => item.projectId === projectId);
  if (!project) throw new Error('Projeto não encontrado.');
  Object.assign(project, patch, { updatedAt: now() });
  writeProjects(storage, projects);
  return project;
}
function readSourceUnits(storage: ScriptContextReviewStorage, projectId: string) {
  if (!fs.existsSync(sourceUnitsPath(storage, projectId))) return [] as SourceUnit[];
  return fs.readFileSync(sourceUnitsPath(storage, projectId), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as SourceUnit);
}
function segmentHash(segment: any) {
  return sha256(JSON.stringify({
    segmentId: segment.segmentId,
    sourceUnitId: segment.sourceUnitId,
    speakerId: segment.speakerId,
    spokenText: segment.spokenText,
    direction: segment.direction || {},
    locked: Boolean(segment.locked),
  }));
}
function normalizeToken(value: unknown) {
  return String(value ?? '').trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[_/|-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function clamp(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
function stripJsonFence(value: string) {
  const text = String(value || '').trim();
  return text.startsWith('```') ? text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim() : text;
}
function normalizeEvidence(value: unknown) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map(item => String(item || '').trim()).filter(Boolean).slice(0, 8);
}
function normalizeCategory(value: unknown, mode: ReviewMode): ScriptContextSuggestion['category'] {
  if (mode === 'pending_speakers') return 'pending_speaker';
  const token = normalizeToken(value);
  if (/speaker|locutor|continuidad.*fala|fala.*continuidad/.test(token)) return 'speaker_continuity';
  if (/narrat|narracao|narrador|role/.test(token)) return 'narration_role';
  if (/alias|identidade|homonim|personagem/.test(token)) return 'alias_identity';
  if (/direction|direcao|emoc|ritmo|intens|pause/.test(token)) return 'direction_consistency';
  if (/fidel|texto|omissao|resumo|spoken/.test(token)) return 'text_fidelity';
  return 'scene_continuity';
}
function normalizeDirection(value: any) {
  if (!value || typeof value !== 'object') return undefined;
  const direction: any = {};
  if (value.emotion !== undefined || value.emocao !== undefined) direction.emotion = String(value.emotion ?? value.emocao ?? '').trim();
  if (value.intensity !== undefined || value.intensidade !== undefined) direction.intensity = clamp(value.intensity ?? value.intensidade, 0, 1, 0.5);
  if (value.pace !== undefined || value.ritmo !== undefined) {
    const pace = normalizeToken(value.pace ?? value.ritmo);
    direction.pace = /slow|lento|pausad/.test(pace) ? 'slow' : /fast|rapid|acelerad/.test(pace) ? 'fast' : 'normal';
  }
  if (value.pauseAfterMs !== undefined || value.pause_after_ms !== undefined || value.pausaMs !== undefined) {
    direction.pauseAfterMs = Math.round(clamp(value.pauseAfterMs ?? value.pause_after_ms ?? value.pausaMs, 0, 10_000, 300));
  }
  return Object.keys(direction).length ? direction : undefined;
}
function contextSnapshot(segment: any) {
  return {
    segmentId: segment.segmentId,
    sourceUnitId: segment.sourceUnitId,
    chapterId: segment.chapterId,
    order: segment.order,
    type: segment.type,
    speakerId: segment.speakerId,
    originalText: segment.originalText,
    spokenText: segment.spokenText,
    direction: segment.direction,
    locked: Boolean(segment.locked),
  };
}
function characterSnapshot(characters: any[]) {
  return characters.map(character => ({
    characterId: character.characterId,
    canonicalName: character.canonicalName,
    aliases: Array.isArray(character.aliases) ? character.aliases : [],
    role: character.role,
    description: character.description,
    personality: character.personality,
    speechStyle: character.speechStyle,
  }));
}
function parseModelSuggestions(text: string, mode: ReviewMode, projectId: string, segmentsById: Map<string, any>, allowedSpeakers: Set<string>) {
  const parsed = JSON.parse(stripJsonFence(text));
  const root = Array.isArray(parsed) ? { suggestions: parsed } : (parsed && typeof parsed === 'object' ? parsed : {});
  const raw = Array.isArray(root.suggestions) ? root.suggestions : Array.isArray(root.issues) ? root.issues : Array.isArray(root.results) ? root.results : [];
  const suggestions: ScriptContextSuggestion[] = [];
  for (const item of raw) {
    const segmentId = String(item?.segmentId ?? item?.segment_id ?? item?.id ?? '').trim();
    const segment = segmentsById.get(segmentId);
    if (!segment || segment.locked) continue;
    const suggested: ScriptContextSuggestion['suggested'] = {};
    const speakerRaw = item?.suggestedSpeakerId ?? item?.suggested_speaker_id ?? item?.speakerId ?? item?.speaker_id;
    const speakerId = speakerRaw === undefined ? undefined : String(speakerRaw).trim();
    if (speakerId && allowedSpeakers.has(speakerId) && speakerId !== segment.speakerId) suggested.speakerId = speakerId;
    const textRaw = item?.suggestedSpokenText ?? item?.suggested_spoken_text ?? item?.spokenText ?? item?.spoken_text;
    const spokenText = textRaw === undefined ? undefined : String(textRaw);
    if (mode === 'final_audit' && spokenText !== undefined && spokenText.trim() && spokenText !== segment.spokenText) suggested.spokenText = spokenText;
    const direction = normalizeDirection(item?.suggestedDirection ?? item?.suggested_direction ?? item?.direction);
    if (mode === 'final_audit' && direction && JSON.stringify(direction) !== JSON.stringify(segment.direction || {})) suggested.direction = direction;
    if (!Object.keys(suggested).length) continue;
    const confidence = clamp(item?.confidence ?? item?.confianca, 0, 1, 0.5);
    const category = normalizeCategory(item?.category ?? item?.categoria ?? item?.type, mode);
    const currentHash = segmentHash(segment);
    const suggestionId = `script_review_${sha256(JSON.stringify({ mode, segmentId, category, suggested, currentHash })).slice(0, 24)}`;
    suggestions.push({
      version: 1,
      suggestionId,
      projectId,
      mode,
      segmentId,
      sourceUnitId: String(segment.sourceUnitId || ''),
      chapterId: String(segment.chapterId || ''),
      category,
      current: { speakerId: String(segment.speakerId || 'unresolved'), spokenText: String(segment.spokenText || ''), direction: segment.direction || {} },
      suggested,
      confidence,
      reason: String(item?.reason ?? item?.motivo ?? item?.rationale ?? 'Sugestão contextual da IA.').trim(),
      evidence: normalizeEvidence(item?.evidence ?? item?.evidencia ?? item?.context),
      status: 'pending',
      segmentHash: currentHash,
      createdAt: now(),
    });
  }
  return suggestions;
}
function pendingSpeakerItems(segments: any[]) {
  const items: ReviewWorkItem[] = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment.speakerId !== 'unresolved' || segment.locked) continue;
    const context = segments.slice(Math.max(0, index - 6), Math.min(segments.length, index + 7));
    const hash = sha256(JSON.stringify({ target: contextSnapshot(segment), context: context.map(contextSnapshot) }));
    items.push({
      workItemId: `pending_speaker_${sha256(`${segment.segmentId}|${hash}`).slice(0, 20)}`,
      chapterId: String(segment.chapterId || ''),
      targetSegmentIds: [segment.segmentId],
      contextSegmentIds: context.map(item => item.segmentId),
      hash,
    });
  }
  return items;
}
function finalAuditItems(segments: any[]) {
  const items: ReviewWorkItem[] = [];
  const chapterIds = Array.from(new Set(segments.map(segment => String(segment.chapterId || ''))));
  const step = Math.max(1, AUDIT_WINDOW_SIZE - AUDIT_OVERLAP);
  for (const chapterId of chapterIds) {
    const chapterSegments = segments.filter(segment => String(segment.chapterId || '') === chapterId);
    for (let start = 0; start < chapterSegments.length; start += step) {
      const core = chapterSegments.slice(start, Math.min(chapterSegments.length, start + step));
      const context = chapterSegments.slice(Math.max(0, start - AUDIT_OVERLAP), Math.min(chapterSegments.length, start + AUDIT_WINDOW_SIZE));
      if (!core.length) continue;
      const hash = sha256(JSON.stringify({ chapterId, core: core.map(contextSnapshot), context: context.map(contextSnapshot) }));
      items.push({
        workItemId: `final_audit_${sha256(`${chapterId}|${start}|${hash}`).slice(0, 20)}`,
        chapterId,
        targetSegmentIds: core.map(segment => segment.segmentId),
        contextSegmentIds: context.map(segment => segment.segmentId),
        hash,
      });
    }
  }
  return items;
}
function calculateSourceHash(mode: ReviewMode, project: any, segments: any[], characters: any[], sightings: any[]) {
  return sha256(JSON.stringify({
    mode,
    productionMode: project.productionMode,
    segments: segments.map(contextSnapshot),
    characters: characterSnapshot(characters),
    sightings: sightings.map(sighting => ({ characterId: sighting.characterId, chapterId: sighting.chapterId, chunkId: sighting.chunkId, evidenceText: sighting.evidenceText })),
  }));
}
function pendingPrompt(item: ReviewWorkItem, segmentsById: Map<string, any>, characters: any[], sightings: any[]) {
  const target = item.targetSegmentIds.map(id => contextSnapshot(segmentsById.get(id)));
  const context = item.contextSegmentIds.map(id => contextSnapshot(segmentsById.get(id)));
  return `Você está realizando uma reanálise seletiva de speakerId para locutores pendentes de um roteiro de audionovela.\nAnalise somente o segmento alvo. Use o contexto anterior e posterior, a Bíblia e as aparições conhecidas.\nNunca altere spokenText, direction ou sourceUnitId. Nunca invente IDs. Se não houver evidência suficiente, não retorne sugestão.\n\nPERSONAGENS:\n${JSON.stringify(characterSnapshot(characters))}\n\nAPARIÇÕES RELEVANTES:\n${JSON.stringify(sightings.filter(sighting => !item.chapterId || String(sighting.chapterId || '') === item.chapterId).slice(0, 120))}\n\nCONTEXTO:\n${JSON.stringify(context)}\n\nALVO:\n${JSON.stringify(target)}\n\nResponda em JSON estrito:\n{"suggestions":[{"segmentId":"...","suggestedSpeakerId":"characterId listado ou char_narrator","confidence":0.0,"reason":"...","evidence":["segmentId ou evidência textual"]}]}`;
}
function finalAuditPrompt(item: ReviewWorkItem, segmentsById: Map<string, any>, characters: any[], sightings: any[]) {
  const target = item.targetSegmentIds.map(id => contextSnapshot(segmentsById.get(id)));
  const context = item.contextSegmentIds.map(id => contextSnapshot(segmentsById.get(id)));
  return `AUDITORIA CONTEXTUAL FINAL DO ROTEIRO. Atue como revisor editorial de continuidade para audionovela.\nAvalie somente os segmentos em ALVOS, usando CONTEXTO, Bíblia e aparições. Não reescreva o roteiro inteiro.\nProcure: locutor errado, continuidade de fala, narrador no lugar de personagem, personagem no lugar de narração, alias/identidade, direção emocional incompatível, perda de fidelidade e incoerência de cena.\nNunca modifique segmentos locked. Não sugira alterações cosméticas. Toda sugestão precisa de evidência concreta.\n\nPERSONAGENS:\n${JSON.stringify(characterSnapshot(characters))}\n\nAPARIÇÕES DO CAPÍTULO:\n${JSON.stringify(sightings.filter(sighting => !item.chapterId || String(sighting.chapterId || '') === item.chapterId).slice(0, 160))}\n\nCONTEXTO:\n${JSON.stringify(context)}\n\nALVOS:\n${JSON.stringify(target)}\n\nResponda em JSON estrito:\n{"issues":[{"segmentId":"...","category":"speaker_continuity|narration_role|alias_identity|direction_consistency|text_fidelity|scene_continuity","suggestedSpeakerId":"opcional","suggestedSpokenText":"opcional","suggestedDirection":{"emotion":"opcional","intensity":0.0,"pace":"slow|normal|fast","pauseAfterMs":300},"confidence":0.0,"reason":"...","evidence":["..."]}]}`;
}
async function generateWithRetry(dependencies: ScriptContextReviewDependencies, args: any) {
  let lastError: any;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try { return await dependencies.generateContent(args); } catch (error: any) {
      lastError = error;
      if (error?.retryable === false || attempt === MAX_RETRIES) break;
      await new Promise(resolve => setTimeout(resolve, 300 * attempt));
    }
  }
  throw lastError || new Error('Falha na análise contextual do roteiro.');
}
function progressFor(job: ScriptContextReviewJob) {
  if (job.status === 'completed') return 100;
  if (!job.totalItems) return 100;
  return Math.min(99, Math.round((job.completedWorkItemIds.length / job.totalItems) * 100));
}
function persistJob(storage: ScriptContextReviewStorage, job: ScriptContextReviewJob) {
  job.progress = progressFor(job);
  job.updatedAt = now();
  atomicWriteJson(jobPath(storage, job.projectId, job.mode), job);
  return job;
}
export function readScriptContextReviewJob(storage: ScriptContextReviewStorage, projectIdInput: string, mode: ReviewMode) {
  return readJson<ScriptContextReviewJob | null>(jobPath(storage, safeProjectId(projectIdInput), mode), null);
}
function createJob(projectId: string, mode: ReviewMode, sourceHash: string, totalItems: number): ScriptContextReviewJob {
  const timestamp = now();
  return {
    version: 1,
    jobId: `script_review_job_${crypto.randomUUID()}`,
    projectId,
    mode,
    status: totalItems ? 'queued' : 'completed',
    sourceHash,
    totalItems,
    completedWorkItemIds: [],
    progress: totalItems ? 0 : 100,
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: totalItems ? undefined : timestamp,
    summary: totalItems ? undefined : { suggestions: 0, highConfidence: 0, unresolvedBefore: 0, unresolvedAfter: 0 },
  };
}
function jobKey(projectId: string, mode: ReviewMode) { return `${projectId}:${mode}`; }
function readSuggestions(storage: ScriptContextReviewStorage, projectId: string) {
  const value = readJson<ScriptContextSuggestion[]>(suggestionsPath(storage, projectId), []);
  return Array.isArray(value) ? value : [];
}
function writeSuggestions(storage: ScriptContextReviewStorage, projectId: string, suggestions: ScriptContextSuggestion[]) { atomicWriteJson(suggestionsPath(storage, projectId), suggestions); }
function publishSuggestions(storage: ScriptContextReviewStorage, projectId: string, mode: ReviewMode, workItems: ReviewWorkItem[]) {
  const generated: ScriptContextSuggestion[] = [];
  for (const item of workItems) {
    const checkpoint = readJson<ReviewCheckpoint | null>(checkpointPath(storage, projectId, mode, item.workItemId), null);
    if (!checkpoint || checkpoint.hash !== item.hash) throw new Error(`Checkpoint de revisão ausente ou incompatível: ${item.workItemId}`);
    generated.push(...checkpoint.suggestions);
  }
  const previous = readSuggestions(storage, projectId).map(suggestion => suggestion.mode === mode && suggestion.status === 'pending' ? { ...suggestion, status: 'superseded' as const } : suggestion);
  const map = new Map<string, ScriptContextSuggestion>();
  for (const suggestion of [...previous, ...generated]) map.set(suggestion.suggestionId, suggestion);
  writeSuggestions(storage, projectId, Array.from(map.values()));
  return generated;
}
function invalidateAudio(storage: ScriptContextReviewStorage, projectId: string, segment: any) {
  const candidates = [
    segment.audioPath ? path.join(projectDir(storage, projectId), 'audio', 'segments', path.basename(segment.audioPath)) : '',
    segment.contextualAudioPath ? path.join(projectDir(storage, projectId), 'audio', 'contextualized', path.basename(segment.contextualAudioPath)) : '',
  ].filter(Boolean);
  for (const candidate of candidates) fs.rmSync(candidate, { force: true });
}
function writeSegments(storage: ScriptContextReviewStorage, projectId: string, segments: any[]) {
  atomicWriteJson(segmentsPath(storage, projectId), segments);
  atomicWrite(path.join(scriptsDir(storage, projectId), 'segments.jsonl'), `${segments.map(segment => JSON.stringify(segment)).join('\n')}\n`);
}
function rebuildReports(storage: ScriptContextReviewStorage, projectId: string) {
  const project = getProject(storage, projectId);
  if (!project) throw new Error('Projeto não encontrado.');
  const chapters = readJson<any[]>(chaptersPath(storage, projectId), []);
  const units = readSourceUnits(storage, projectId);
  const segments = readJson<any[]>(segmentsPath(storage, projectId), []);
  const generationJob = readScriptGenerationJob(storage as any, projectId);
  const scriptReport = buildScriptReport(projectId, chapters, units, segments, generationJob?.fallbackBatchIds || []);
  atomicWriteJson(scriptReportPath(storage, projectId), scriptReport);
  const suggestions = readSuggestions(storage, projectId);
  const pending = suggestions.filter(suggestion => suggestion.status === 'pending');
  const finalPending = pending.filter(suggestion => suggestion.mode === 'final_audit');
  const structuralFailures = [...(scriptReport.missingUnitIds || []), ...(scriptReport.duplicatedUnitIds || []), ...scriptReport.unresolvedSpeakers.map((item: any) => item.segmentId)];
  const status = structuralFailures.length ? 'FAIL' : finalPending.length ? 'REVIEW' : 'PASS';
  const finalReport = {
    version: 1,
    projectId,
    status,
    scriptComplete: scriptReport.scriptComplete,
    coverage: scriptReport.coverage,
    unresolvedSpeakers: scriptReport.totalUnresolved,
    structuralFailures,
    pendingSuggestions: pending.length,
    pendingFinalAuditSuggestions: finalPending.length,
    appliedSuggestions: suggestions.filter(suggestion => suggestion.status === 'applied').length,
    rejectedSuggestions: suggestions.filter(suggestion => suggestion.status === 'rejected').length,
    staleSuggestions: suggestions.filter(suggestion => suggestion.status === 'stale').length,
    deterministicBatches: scriptReport.fallbackBatchIds || [],
    generatedAt: now(),
  };
  atomicWriteJson(finalReportPath(storage, projectId), finalReport);
  const updatedProject = updateProject(storage, projectId, { status: scriptReport.scriptComplete && !finalPending.length ? 'generating_audio' : 'scripting', lastError: undefined });
  return { project: updatedProject, scriptReport, finalReport };
}
function loadReviewState(storage: ScriptContextReviewStorage, projectId: string) {
  return {
    project: getProject(storage, projectId),
    characters: readJson<any[]>(charactersPath(storage, projectId), []),
    suggestions: readSuggestions(storage, projectId),
    scriptReport: readJson<any>(scriptReportPath(storage, projectId), null),
    finalReport: readJson<any>(finalReportPath(storage, projectId), null),
    jobs: {
      pendingSpeakers: readScriptContextReviewJob(storage, projectId, 'pending_speakers'),
      finalAudit: readScriptContextReviewJob(storage, projectId, 'final_audit'),
    },
  };
}
async function processJob(storage: ScriptContextReviewStorage, dependencies: ScriptContextReviewDependencies, projectId: string, mode: ReviewMode) {
  const key = jobKey(projectId, mode);
  if (activeJobs.has(key)) return;
  activeJobs.add(key);
  let job = readScriptContextReviewJob(storage, projectId, mode);
  try {
    if (!job || ['completed', 'cancelled'].includes(job.status)) return;
    const project = getProject(storage, projectId);
    if (!project) throw new Error('Projeto não encontrado.');
    const segments = readJson<any[]>(segmentsPath(storage, projectId), []);
    const characters = readJson<any[]>(charactersPath(storage, projectId), []);
    const sightings = readJson<any[]>(sightingsPath(storage, projectId), []);
    if (!segments.length) throw new Error('Gere o roteiro antes da revisão contextual.');
    if (!characters.length) throw new Error('A Bíblia de personagens não está disponível.');
    if (!dependencies.hasTextAi()) throw new Error('OPENAI_API_KEY não configurada para revisão contextual.');
    const items = mode === 'pending_speakers' ? pendingSpeakerItems(segments) : finalAuditItems(segments);
    const expectedHash = calculateSourceHash(mode, project, segments, characters, sightings);
    if (job.sourceHash !== expectedHash) throw new Error('O roteiro ou a Bíblia mudou. Inicie novamente esta análise.');
    const segmentsById = new Map(segments.map(segment => [segment.segmentId, segment]));
    const allowedSpeakers = new Set(['char_narrator', ...characters.map(character => String(character.characterId))]);
    job.status = 'processing';
    job.startedAt ||= now();
    job.attempts += 1;
    job.lastError = undefined;
    persistJob(storage, job);
    const completed = new Set(job.completedWorkItemIds);
    const unresolvedBefore = segments.filter(segment => segment.speakerId === 'unresolved').length;
    for (const item of items) {
      job = readScriptContextReviewJob(storage, projectId, mode) || job;
      if (job.status === 'cancelled') return;
      if (completed.has(item.workItemId)) {
        const checkpoint = readJson<ReviewCheckpoint | null>(checkpointPath(storage, projectId, mode, item.workItemId), null);
        if (checkpoint?.hash === item.hash) continue;
        completed.delete(item.workItemId);
      }
      job.currentWorkItemId = item.workItemId;
      job.currentChapterId = item.chapterId;
      persistJob(storage, job);
      const prompt = mode === 'pending_speakers' ? pendingPrompt(item, segmentsById, characters, sightings) : finalAuditPrompt(item, segmentsById, characters, sightings);
      const response = await generateWithRetry(dependencies, {
        model: mode === 'pending_speakers' ? dependencies.editorialModel() : dependencies.auditModel(),
        contents: [{ text: prompt }],
        config: { responseMimeType: 'application/json', reasoningEffort: mode === 'pending_speakers' ? 'medium' : 'high' },
      });
      const suggestions = parseModelSuggestions(String(response?.text || ''), mode, projectId, segmentsById, allowedSpeakers).filter(suggestion => item.targetSegmentIds.includes(suggestion.segmentId));
      atomicWriteJson(checkpointPath(storage, projectId, mode, item.workItemId), { version: 1, mode, workItemId: item.workItemId, hash: item.hash, suggestions, completedAt: now() } satisfies ReviewCheckpoint);
      completed.add(item.workItemId);
      job.completedWorkItemIds = Array.from(completed);
      job.currentWorkItemId = undefined;
      job.currentChapterId = undefined;
      persistJob(storage, job);
    }
    const generated = publishSuggestions(storage, projectId, mode, items);
    const reports = rebuildReports(storage, projectId);
    job.status = 'completed';
    job.progress = 100;
    job.currentWorkItemId = undefined;
    job.currentChapterId = undefined;
    job.completedAt = now();
    job.summary = { suggestions: generated.length, highConfidence: generated.filter(suggestion => suggestion.confidence >= 0.9).length, unresolvedBefore, unresolvedAfter: reports.scriptReport.totalUnresolved };
    persistJob(storage, job);
  } catch (error: any) {
    job = readScriptContextReviewJob(storage, projectId, mode) || job;
    if (job) {
      job.status = 'failed';
      job.currentWorkItemId = undefined;
      job.currentChapterId = undefined;
      job.lastError = { code: mode === 'pending_speakers' ? 'PENDING_SPEAKER_REVIEW_INTERRUPTED' : 'FINAL_SCRIPT_AUDIT_INTERRUPTED', message: error?.message || String(error), retryable: true, at: now() };
      persistJob(storage, job);
    }
  } finally { activeJobs.delete(key); }
}
function launch(storage: ScriptContextReviewStorage, dependencies: ScriptContextReviewDependencies, projectId: string, mode: ReviewMode) {
  const key = jobKey(projectId, mode);
  if (!activeJobs.has(key)) setTimeout(() => void processJob(storage, dependencies, projectId, mode), 0);
}
function publicJobState(storage: ScriptContextReviewStorage, projectId: string, job: ScriptContextReviewJob) {
  const payload: any = { job };
  if (job.status === 'completed') payload.result = loadReviewState(storage, projectId);
  return payload;
}
function startReview(storage: ScriptContextReviewStorage, dependencies: ScriptContextReviewDependencies, projectId: string, mode: ReviewMode, forceFresh: boolean) {
  const project = getProject(storage, projectId);
  if (!project) throw new Error('Projeto não encontrado.');
  const segments = readJson<any[]>(segmentsPath(storage, projectId), []);
  const characters = readJson<any[]>(charactersPath(storage, projectId), []);
  const sightings = readJson<any[]>(sightingsPath(storage, projectId), []);
  if (!segments.length) throw new Error('Gere o roteiro antes da revisão contextual.');
  if (!characters.length) throw new Error('Conclua a Bíblia antes da revisão contextual.');
  if (!dependencies.hasTextAi()) throw new Error('OPENAI_API_KEY não configurada para revisão contextual.');
  const items = mode === 'pending_speakers' ? pendingSpeakerItems(segments) : finalAuditItems(segments);
  const sourceHash = calculateSourceHash(mode, project, segments, characters, sightings);
  let job = readScriptContextReviewJob(storage, projectId, mode);
  const canResume = job && ['queued', 'processing', 'failed'].includes(job.status) && job.sourceHash === sourceHash && !forceFresh;
  if (!canResume) {
    fs.rmSync(checkpointsDir(storage, projectId, mode), { recursive: true, force: true });
    job = createJob(projectId, mode, sourceHash, items.length);
  } else {
    job!.status = 'queued';
    job!.lastError = undefined;
    job!.totalItems = items.length;
  }
  persistJob(storage, job!);
  if (job!.status !== 'completed') launch(storage, dependencies, projectId, mode); else rebuildReports(storage, projectId);
  return job!;
}
function applySuggestion(storage: ScriptContextReviewStorage, projectId: string, suggestionId: string) {
  const suggestions = readSuggestions(storage, projectId);
  const suggestion = suggestions.find(item => item.suggestionId === suggestionId);
  if (!suggestion) throw new Error('Sugestão não encontrada.');
  if (suggestion.status !== 'pending') throw new Error(`Sugestão já está ${suggestion.status}.`);
  const segments = readJson<any[]>(segmentsPath(storage, projectId), []);
  const segment = segments.find(item => item.segmentId === suggestion.segmentId);
  if (!segment) throw new Error('O trecho associado à sugestão não existe mais.');
  if (segment.locked) throw new Error('Trechos travados não podem ser alterados pela revisão.');
  if (segmentHash(segment) !== suggestion.segmentHash) {
    suggestion.status = 'stale';
    suggestion.staleAt = now();
    writeSuggestions(storage, projectId, suggestions);
    throw new Error('O trecho mudou depois da análise; gere uma nova sugestão.');
  }
  const characters = readJson<any[]>(charactersPath(storage, projectId), []);
  const allowedSpeakers = new Set(['char_narrator', ...characters.map(character => String(character.characterId))]);
  if (suggestion.suggested.speakerId && !allowedSpeakers.has(suggestion.suggested.speakerId)) throw new Error('O locutor sugerido não pertence mais à Bíblia.');
  if (suggestion.suggested.spokenText !== undefined && !suggestion.suggested.spokenText.trim()) throw new Error('A sugestão não pode apagar o texto falado.');
  invalidateAudio(storage, projectId, segment);
  const before = { speakerId: segment.speakerId, spokenText: segment.spokenText, direction: segment.direction };
  if (suggestion.suggested.speakerId) segment.speakerId = suggestion.suggested.speakerId;
  if (suggestion.suggested.spokenText !== undefined) segment.spokenText = suggestion.suggested.spokenText;
  if (suggestion.suggested.direction) segment.direction = { ...segment.direction, ...suggestion.suggested.direction };
  Object.assign(segment, {
    status: 'pending', audioPath: undefined, contextualAudioPath: undefined, durationMs: undefined, checksum: undefined, lastError: undefined, manuallyReviewed: true,
    reviewHistory: [...(Array.isArray(segment.reviewHistory) ? segment.reviewHistory : []), { suggestionId, mode: suggestion.mode, before, after: { speakerId: segment.speakerId, spokenText: segment.spokenText, direction: segment.direction }, appliedAt: now() }],
  });
  writeSegments(storage, projectId, segments);
  atomicWrite(path.join(scriptsDir(storage, projectId), 'tts-input', `${segment.segmentId}.txt`), String(segment.spokenText || ''));
  suggestion.status = 'applied';
  suggestion.appliedAt = now();
  writeSuggestions(storage, projectId, suggestions);
  return { suggestion, segment, ...rebuildReports(storage, projectId) };
}

export function registerScriptContextReviewRoutes(app: Express, storageProvider: () => ScriptContextReviewStorage, dependencies: ScriptContextReviewDependencies) {
  app.get('/api/projects/:projectId/script-review', (req: Request, res: Response) => {
    try {
      const storage = storageProvider();
      const projectId = safeProjectId(req.params.projectId);
      if (!getProject(storage, projectId)) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Projeto não encontrado.' } });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(loadReviewState(storage, projectId));
    } catch (error: any) { return res.status(400).json({ error: { code: 'SCRIPT_REVIEW_STATUS_FAILED', message: error?.message || 'Não foi possível consultar a revisão.' } }); }
  });
  for (const mode of ['pending_speakers', 'final_audit'] as const) {
    const slug = mode === 'pending_speakers' ? 'pending-speakers' : 'final-audit';
    app.post(`/api/projects/:projectId/script-review/${slug}/start`, (req: Request, res: Response) => {
      try {
        const storage = storageProvider();
        const projectId = safeProjectId(req.params.projectId);
        const job = startReview(storage, dependencies, projectId, mode, req.body?.forceFresh === true);
        return res.status(job.status === 'completed' ? 200 : 202).json(publicJobState(storage, projectId, job));
      } catch (error: any) { return res.status(409).json({ error: { code: 'SCRIPT_REVIEW_START_FAILED', message: error?.message || 'Não foi possível iniciar a revisão.' } }); }
    });
    app.get(`/api/projects/:projectId/script-review/${slug}/status`, (req: Request, res: Response) => {
      try {
        const storage = storageProvider();
        const projectId = safeProjectId(req.params.projectId);
        const job = readScriptContextReviewJob(storage, projectId, mode);
        if (!job) return res.status(404).json({ error: { code: 'SCRIPT_REVIEW_JOB_NOT_FOUND', message: 'Esta análise ainda não foi iniciada.' } });
        if (['queued', 'processing'].includes(job.status)) launch(storage, dependencies, projectId, mode);
        res.setHeader('Cache-Control', 'no-store');
        return res.json(publicJobState(storage, projectId, job));
      } catch (error: any) { return res.status(400).json({ error: { code: 'SCRIPT_REVIEW_JOB_STATUS_FAILED', message: error?.message || 'Não foi possível consultar a análise.' } }); }
    });
    app.post(`/api/projects/:projectId/script-review/${slug}/cancel`, (req: Request, res: Response) => {
      try {
        const storage = storageProvider();
        const projectId = safeProjectId(req.params.projectId);
        const job = readScriptContextReviewJob(storage, projectId, mode);
        if (!job) return res.status(404).json({ error: { code: 'SCRIPT_REVIEW_JOB_NOT_FOUND', message: 'Esta análise ainda não foi iniciada.' } });
        job.status = 'cancelled';
        job.currentWorkItemId = undefined;
        job.currentChapterId = undefined;
        persistJob(storage, job);
        return res.json(publicJobState(storage, projectId, job));
      } catch (error: any) { return res.status(400).json({ error: { code: 'SCRIPT_REVIEW_CANCEL_FAILED', message: error?.message || 'Não foi possível cancelar a análise.' } }); }
    });
  }
  app.post('/api/projects/:projectId/script-review/suggestions/apply-high-confidence', (req: Request, res: Response) => {
    try {
      const storage = storageProvider();
      const projectId = safeProjectId(req.params.projectId);
      const threshold = clamp(req.body?.threshold, 0, 1, 0.9);
      const mode = req.body?.mode === 'pending_speakers' || req.body?.mode === 'final_audit' ? req.body.mode as ReviewMode : undefined;
      const candidates = readSuggestions(storage, projectId).filter(suggestion => suggestion.status === 'pending' && suggestion.confidence >= threshold && (!mode || suggestion.mode === mode)).sort((a, b) => b.confidence - a.confidence);
      const applied: string[] = [];
      const failed: Array<{ suggestionId: string; message: string }> = [];
      for (const suggestion of candidates) {
        try { applySuggestion(storage, projectId, suggestion.suggestionId); applied.push(suggestion.suggestionId); }
        catch (error: any) { failed.push({ suggestionId: suggestion.suggestionId, message: error?.message || String(error) }); }
      }
      return res.json({ applied, failed, state: loadReviewState(storage, projectId) });
    } catch (error: any) { return res.status(400).json({ error: { code: 'SCRIPT_REVIEW_BULK_APPLY_FAILED', message: error?.message || 'Não foi possível aplicar as sugestões.' } }); }
  });
  app.post('/api/projects/:projectId/script-review/suggestions/:suggestionId/apply', (req: Request, res: Response) => {
    try { return res.json(applySuggestion(storageProvider(), safeProjectId(req.params.projectId), String(req.params.suggestionId || ''))); }
    catch (error: any) { return res.status(409).json({ error: { code: 'SCRIPT_REVIEW_SUGGESTION_APPLY_FAILED', message: error?.message || 'Não foi possível aplicar a sugestão.' } }); }
  });
  app.post('/api/projects/:projectId/script-review/suggestions/:suggestionId/reject', (req: Request, res: Response) => {
    try {
      const storage = storageProvider();
      const projectId = safeProjectId(req.params.projectId);
      const suggestions = readSuggestions(storage, projectId);
      const suggestion = suggestions.find(item => item.suggestionId === String(req.params.suggestionId || ''));
      if (!suggestion) return res.status(404).json({ error: { code: 'SCRIPT_REVIEW_SUGGESTION_NOT_FOUND', message: 'Sugestão não encontrada.' } });
      if (suggestion.status !== 'pending') return res.status(409).json({ error: { code: 'SCRIPT_REVIEW_SUGGESTION_ALREADY_HANDLED', message: `Sugestão já está ${suggestion.status}.` } });
      suggestion.status = 'rejected';
      suggestion.rejectedAt = now();
      writeSuggestions(storage, projectId, suggestions);
      return res.json({ suggestion, ...rebuildReports(storage, projectId) });
    } catch (error: any) { return res.status(400).json({ error: { code: 'SCRIPT_REVIEW_SUGGESTION_REJECT_FAILED', message: error?.message || 'Não foi possível rejeitar a sugestão.' } }); }
  });
  setTimeout(() => {
    const storage = storageProvider();
    for (const project of readProjects(storage)) {
      for (const mode of ['pending_speakers', 'final_audit'] as const) {
        const job = readScriptContextReviewJob(storage, String(project.projectId || ''), mode);
        if (job && ['queued', 'processing'].includes(job.status)) launch(storage, dependencies, job.projectId, mode);
      }
    }
  }, 0);
}

export function resetScriptContextReviewRuntimeForTests() { activeJobs.clear(); }
