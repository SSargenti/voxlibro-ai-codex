import type { Express, NextFunction, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { buildScriptReport, readScriptGenerationJob } from './scriptGenerationJob';
import type { SourceUnit } from './lib/losslessScript';

export type AudiobookNarrationStorage = {
  projectsRoot: string;
  projectsDbFile: string;
};

type PolicyResult = {
  audiobook: boolean;
  project?: any;
  segments?: any[];
  changedSegmentIds: string[];
  narratorCreated: boolean;
  sanitizedSuggestions: number;
  scriptReport?: any;
  finalReport?: any;
};

function now() { return new Date().toISOString(); }
function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T; }
  catch { return fallback; }
}
function atomicWrite(filePath: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, filePath);
}
function atomicWriteJson(filePath: string, value: unknown) {
  atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
function safeProjectId(value: string) {
  const clean = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean || clean !== value) throw new Error('ID de projeto inválido.');
  return clean;
}
function projectDir(storage: AudiobookNarrationStorage, projectId: string) {
  return path.join(storage.projectsRoot, projectId);
}
function scriptsDir(storage: AudiobookNarrationStorage, projectId: string) {
  return path.join(projectDir(storage, projectId), 'scripts');
}
function segmentsPath(storage: AudiobookNarrationStorage, projectId: string) {
  return path.join(scriptsDir(storage, projectId), 'segments.json');
}
function charactersPath(storage: AudiobookNarrationStorage, projectId: string) {
  return path.join(projectDir(storage, projectId), 'narrative-bible', 'characters.json');
}
function chaptersPath(storage: AudiobookNarrationStorage, projectId: string) {
  return path.join(projectDir(storage, projectId), 'normalized', 'chapters.json');
}
function sourceUnitsPath(storage: AudiobookNarrationStorage, projectId: string) {
  return path.join(scriptsDir(storage, projectId), 'source-units.jsonl');
}
function suggestionsPath(storage: AudiobookNarrationStorage, projectId: string) {
  return path.join(scriptsDir(storage, projectId), 'review-suggestions.json');
}
function scriptReportPath(storage: AudiobookNarrationStorage, projectId: string) {
  return path.join(scriptsDir(storage, projectId), 'script-report.json');
}
function finalReportPath(storage: AudiobookNarrationStorage, projectId: string) {
  return path.join(scriptsDir(storage, projectId), 'final-review-report.json');
}
function readProjects(storage: AudiobookNarrationStorage) {
  const projects = readJson<any[]>(storage.projectsDbFile, []);
  return Array.isArray(projects) ? projects : [];
}
function writeProjects(storage: AudiobookNarrationStorage, projects: any[]) {
  atomicWriteJson(storage.projectsDbFile, projects);
}
function getProject(storage: AudiobookNarrationStorage, projectId: string) {
  return readProjects(storage).find(project => project.projectId === projectId);
}
function isAudiobookProject(project: any) {
  return String(project?.productionMode || '').toLowerCase() === 'audiobook';
}
function readSourceUnits(storage: AudiobookNarrationStorage, projectId: string) {
  const filePath = sourceUnitsPath(storage, projectId);
  if (!fs.existsSync(filePath)) return [] as SourceUnit[];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as SourceUnit);
}
function removeAudio(storage: AudiobookNarrationStorage, projectId: string, segment: any) {
  const files = [
    segment.audioPath ? path.join(projectDir(storage, projectId), 'audio', 'segments', path.basename(segment.audioPath)) : '',
    segment.contextualAudioPath ? path.join(projectDir(storage, projectId), 'audio', 'contextualized', path.basename(segment.contextualAudioPath)) : '',
  ].filter(Boolean);
  for (const filePath of files) fs.rmSync(filePath, { force: true });
}
function performanceContextFor(segment: any, previousSpeakerId: string) {
  const portrayedSpeakerId = segment.portrayedSpeakerId
    || segment.performanceContext?.portrayedSpeakerId
    || (previousSpeakerId && !['char_narrator', 'unresolved'].includes(previousSpeakerId) ? previousSpeakerId : undefined);
  return {
    ...(segment.performanceContext || {}),
    mode: 'single_narrator',
    delivery: segment.type === 'fala' ? 'character_dialogue' : segment.type === 'título' ? 'title' : 'narration',
    portrayedSpeakerId,
    emotion: segment.direction?.emotion || 'neutral',
    intensity: segment.direction?.intensity ?? 0.5,
    pace: segment.direction?.pace || 'normal',
    pauseAfterMs: segment.direction?.pauseAfterMs ?? 300,
  };
}
function ensureNarrator(characters: any[]) {
  let narrator = characters.find(character => character.characterId === 'char_narrator');
  let created = false;
  if (!narrator) {
    const roleNarrator = characters.find(character => character.role === 'narrator');
    narrator = {
      ...(roleNarrator || {}),
      characterId: 'char_narrator',
      canonicalName: roleNarrator?.canonicalName || 'Narrador',
      aliases: Array.from(new Set(['Narrador', 'Narrator', ...(Array.isArray(roleNarrator?.aliases) ? roleNarrator.aliases : [])])),
      role: 'narrator',
    };
    characters.unshift(narrator);
    created = true;
  }
  return { narrator, created };
}
function sanitizeSuggestions(storage: AudiobookNarrationStorage, projectId: string) {
  const filePath = suggestionsPath(storage, projectId);
  const suggestions = readJson<any[]>(filePath, []);
  if (!Array.isArray(suggestions) || !suggestions.length) return 0;
  let changed = 0;
  for (const suggestion of suggestions) {
    if (suggestion.status !== 'pending') continue;
    if (suggestion.mode === 'pending_speakers') {
      suggestion.status = 'superseded';
      suggestion.supersededAt = now();
      suggestion.reason = `${suggestion.reason || ''} Não se aplica ao modo Audiolivro, que utiliza exclusivamente a voz do narrador.`.trim();
      changed += 1;
      continue;
    }
    const suggested = suggestion.suggested && typeof suggestion.suggested === 'object' ? suggestion.suggested : {};
    if (suggested.speakerId && suggested.speakerId !== 'char_narrator') {
      delete suggested.speakerId;
      suggestion.suggested = suggested;
      suggestion.reason = `${suggestion.reason || ''} A troca de voz foi removida porque o modo Audiolivro mantém narrador único.`.trim();
      changed += 1;
    }
    if (!suggested.speakerId && suggested.spokenText === undefined && !suggested.direction) {
      suggestion.status = 'superseded';
      suggestion.supersededAt = now();
      changed += 1;
    }
  }
  if (changed) atomicWriteJson(filePath, suggestions);
  return changed;
}
function rebuildReports(storage: AudiobookNarrationStorage, projectId: string, project: any, segments: any[]) {
  const chapters = readJson<any[]>(chaptersPath(storage, projectId), []);
  const units = readSourceUnits(storage, projectId);
  if (!segments.length || !units.length) return {};
  const generationJob = readScriptGenerationJob(storage as any, projectId);
  const scriptReport = buildScriptReport(projectId, chapters, units, segments, generationJob?.fallbackBatchIds || []);
  atomicWriteJson(scriptReportPath(storage, projectId), scriptReport);

  const suggestions = readJson<any[]>(suggestionsPath(storage, projectId), []);
  const pending = suggestions.filter(suggestion => suggestion.status === 'pending');
  const pendingFinal = pending.filter(suggestion => suggestion.mode === 'final_audit');
  const structuralFailures = [
    ...(scriptReport.missingUnitIds || []),
    ...(scriptReport.duplicatedUnitIds || []),
    ...scriptReport.unresolvedSpeakers.map((item: any) => item.segmentId),
  ];
  const finalReport = {
    version: 1,
    projectId,
    status: structuralFailures.length ? 'FAIL' : pendingFinal.length ? 'REVIEW' : 'PASS',
    narrationMode: 'single_narrator',
    narratorId: 'char_narrator',
    scriptComplete: scriptReport.scriptComplete,
    coverage: scriptReport.coverage,
    unresolvedSpeakers: scriptReport.totalUnresolved,
    structuralFailures,
    pendingSuggestions: pending.length,
    pendingFinalAuditSuggestions: pendingFinal.length,
    generatedAt: now(),
  };
  atomicWriteJson(finalReportPath(storage, projectId), finalReport);

  const projects = readProjects(storage);
  const stored = projects.find(item => item.projectId === projectId);
  if (stored) {
    stored.status = scriptReport.scriptComplete && !pendingFinal.length ? 'generating_audio' : 'scripting';
    stored.narrationMode = 'single_narrator';
    stored.narratorCharacterId = 'char_narrator';
    stored.updatedAt = now();
    writeProjects(storage, projects);
    Object.assign(project, stored);
  }
  return { scriptReport, finalReport };
}

export function enforceAudiobookNarrationPolicy(
  storage: AudiobookNarrationStorage,
  projectIdInput: string,
): PolicyResult {
  const projectId = safeProjectId(projectIdInput);
  const project = getProject(storage, projectId);
  if (!project || !isAudiobookProject(project)) {
    return { audiobook: false, project, changedSegmentIds: [], narratorCreated: false, sanitizedSuggestions: 0 };
  }

  const characters = readJson<any[]>(charactersPath(storage, projectId), []);
  const narratorState = ensureNarrator(characters);
  if (narratorState.created) atomicWriteJson(charactersPath(storage, projectId), characters);

  const segments = readJson<any[]>(segmentsPath(storage, projectId), []);
  const changedSegmentIds: string[] = [];
  let metadataChanged = false;
  for (const segment of segments) {
    const previousSpeakerId = String(segment.speakerId || 'unresolved');
    const nextContext = performanceContextFor(segment, previousSpeakerId);
    const nextPortrayed = nextContext.portrayedSpeakerId;
    const speakerChanged = previousSpeakerId !== 'char_narrator';
    const contextChanged = JSON.stringify(segment.performanceContext || {}) !== JSON.stringify(nextContext)
      || segment.narrationMode !== 'single_narrator'
      || segment.portrayedSpeakerId !== nextPortrayed;

    if (speakerChanged) {
      removeAudio(storage, projectId, segment);
      Object.assign(segment, {
        status: 'pending',
        audioPath: undefined,
        contextualAudioPath: undefined,
        durationMs: undefined,
        checksum: undefined,
        lastError: undefined,
      });
      changedSegmentIds.push(segment.segmentId);
    }
    if (speakerChanged || contextChanged) {
      segment.speakerId = 'char_narrator';
      segment.narrationMode = 'single_narrator';
      segment.portrayedSpeakerId = nextPortrayed;
      segment.performanceContext = nextContext;
      metadataChanged = true;
    }
  }

  if (metadataChanged) {
    atomicWriteJson(segmentsPath(storage, projectId), segments);
    atomicWrite(path.join(scriptsDir(storage, projectId), 'segments.jsonl'), `${segments.map(segment => JSON.stringify(segment)).join('\n')}\n`);
  }

  const sanitizedSuggestions = sanitizeSuggestions(storage, projectId);
  const reports = rebuildReports(storage, projectId, project, segments);
  return {
    audiobook: true,
    project,
    segments,
    changedSegmentIds,
    narratorCreated: narratorState.created,
    sanitizedSuggestions,
    ...reports,
  };
}

function patchResponseBody(body: any, result: PolicyResult) {
  if (!result.audiobook || !body || typeof body !== 'object') return body;
  const next = { ...body };
  if (result.project && ('project' in next || next.result?.project)) {
    if ('project' in next) next.project = result.project;
    if (next.result?.project) next.result = { ...next.result, project: result.project };
  }
  if (result.segments && ('segments' in next || next.result?.segments)) {
    if ('segments' in next) next.segments = result.segments;
    if (next.result?.segments) next.result = { ...next.result, segments: result.segments };
  }
  if (result.scriptReport && ('report' in next || next.result?.report)) {
    if ('report' in next) next.report = result.scriptReport;
    if (next.result?.report) next.result = { ...next.result, report: result.scriptReport };
  }
  return next;
}

export function registerAudiobookNarrationPolicy(
  app: Express,
  storageProvider: () => AudiobookNarrationStorage,
) {
  app.use('/api/projects/:projectId', (req: Request, res: Response, next: NextFunction) => {
    let projectId = '';
    try {
      projectId = safeProjectId(req.params.projectId);
      enforceAudiobookNarrationPolicy(storageProvider(), projectId);
    } catch {
      return next();
    }

    const originalJson = res.json.bind(res);
    res.json = ((body: any) => {
      try {
        const result = enforceAudiobookNarrationPolicy(storageProvider(), projectId);
        return originalJson(patchResponseBody(body, result));
      } catch {
        return originalJson(body);
      }
    }) as typeof res.json;
    next();
  });
}

function readPrompt(contents: any): string {
  const visit = (value: any): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(visit).join('\n');
    if (!value || typeof value !== 'object') return '';
    if (typeof value.text === 'string') return value.text;
    return visit(value.parts || value.content || value.contents || '');
  };
  return visit(contents);
}
function appendInstruction(contents: any, instruction: string) {
  if (Array.isArray(contents)) {
    return [...contents, { text: instruction }];
  }
  return [contents, { text: instruction }];
}
function replaceResponseText(response: any, text: string) {
  const next = { ...response, text };
  if (Array.isArray(response?.candidates)) {
    next.candidates = response.candidates.map((candidate: any) => ({
      ...candidate,
      content: candidate?.content ? {
        ...candidate.content,
        parts: Array.isArray(candidate.content.parts)
          ? candidate.content.parts.map((part: any) => typeof part?.text === 'string' ? { ...part, text } : part)
          : candidate.content.parts,
      } : candidate?.content,
    }));
  }
  return next;
}
function sanitizeSingleNarratorAuditResponse(text: string) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.startsWith('```');
  const jsonText = fenced ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim() : trimmed;
  try {
    const parsed = JSON.parse(jsonText);
    const key = Array.isArray(parsed?.issues) ? 'issues' : Array.isArray(parsed?.suggestions) ? 'suggestions' : Array.isArray(parsed?.results) ? 'results' : '';
    if (!key) return text;
    parsed[key] = parsed[key].flatMap((issue: any) => {
      const next = { ...(issue || {}) };
      delete next.suggestedSpeakerId;
      delete next.suggested_speaker_id;
      delete next.speakerId;
      delete next.speaker_id;
      const hasText = next.suggestedSpokenText !== undefined || next.suggested_spoken_text !== undefined || next.spokenText !== undefined || next.spoken_text !== undefined;
      const hasDirection = next.suggestedDirection || next.suggested_direction || next.direction;
      return hasText || hasDirection ? [next] : [];
    });
    return JSON.stringify(parsed);
  } catch {
    return text;
  }
}

export function withAudiobookContextReviewPolicy(
  generateContent: (args: any) => Promise<any>,
) {
  return async (args: any) => {
    const prompt = readPrompt(args?.contents);
    const finalAudit = prompt.includes('AUDITORIA CONTEXTUAL FINAL DO ROTEIRO');
    const speakerIds = Array.from(prompt.matchAll(/"speakerId"\s*:\s*"([^"]+)"/g)).map(match => match[1]);
    const singleNarrator = finalAudit && speakerIds.length > 0 && speakerIds.every(id => id === 'char_narrator');
    const nextArgs = singleNarrator ? {
      ...args,
      contents: appendInstruction(args.contents, `MODO AUDIOLIVRO COM NARRADOR ÚNICO: todos os segmentos devem continuar com speakerId=char_narrator. Não proponha troca de locutor ou voz. Avalie somente fidelidade do texto e ajustes de interpretação do mesmo narrador — emoção, intensidade, ritmo e pausas — para representar personagem e circunstância sem imitar uma voz diferente.`),
    } : args;
    const response = await generateContent(nextArgs);
    if (!singleNarrator || typeof response?.text !== 'string') return response;
    return replaceResponseText(response, sanitizeSingleNarratorAuditResponse(response.text));
  };
}
