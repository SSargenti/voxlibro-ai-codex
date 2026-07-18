import type { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { buildScriptReport, readScriptGenerationJob } from './scriptGenerationJob';
import type { SourceUnit } from './lib/losslessScript';

export type VoiceScriptStorage = {
  projectsRoot: string;
  projectsDbFile: string;
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
function projectDir(storage: VoiceScriptStorage, projectId: string) { return path.join(storage.projectsRoot, projectId); }
function scriptsDir(storage: VoiceScriptStorage, projectId: string) { return path.join(projectDir(storage, projectId), 'scripts'); }
function charactersPath(storage: VoiceScriptStorage, projectId: string) { return path.join(projectDir(storage, projectId), 'narrative-bible', 'characters.json'); }
function chaptersPath(storage: VoiceScriptStorage, projectId: string) { return path.join(projectDir(storage, projectId), 'normalized', 'chapters.json'); }
function segmentsPath(storage: VoiceScriptStorage, projectId: string) { return path.join(scriptsDir(storage, projectId), 'segments.json'); }
function sourceUnitsPath(storage: VoiceScriptStorage, projectId: string) { return path.join(scriptsDir(storage, projectId), 'source-units.jsonl'); }
function reportPath(storage: VoiceScriptStorage, projectId: string) { return path.join(scriptsDir(storage, projectId), 'script-report.json'); }
function suggestionsPath(storage: VoiceScriptStorage, projectId: string) { return path.join(scriptsDir(storage, projectId), 'review-suggestions.json'); }
function finalReportPath(storage: VoiceScriptStorage, projectId: string) { return path.join(scriptsDir(storage, projectId), 'final-review-report.json'); }
function readProjects(storage: VoiceScriptStorage) {
  const projects = readJson<any[]>(storage.projectsDbFile, []);
  return Array.isArray(projects) ? projects : [];
}
function writeProjects(storage: VoiceScriptStorage, projects: any[]) { atomicWriteJson(storage.projectsDbFile, projects); }
function getProject(storage: VoiceScriptStorage, projectId: string) { return readProjects(storage).find(project => project.projectId === projectId); }
function readSourceUnits(storage: VoiceScriptStorage, projectId: string) {
  const filePath = sourceUnitsPath(storage, projectId);
  if (!fs.existsSync(filePath)) return [] as SourceUnit[];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as SourceUnit);
}
function voiceIdentity(character: any) {
  return JSON.stringify({
    voiceAssignmentId: character?.voiceAssignmentId || '',
    providerId: character?.voiceAssignment?.providerId || '',
    voiceName: character?.voiceAssignment?.voiceName || '',
    configurations: character?.voiceAssignment?.configurations || {},
  });
}
function normalizeVoice(voiceAssignmentId: string, incomingAssignment?: any) {
  const id = String(voiceAssignmentId || '').trim();
  if (!id) return { voiceAssignmentId: undefined, voiceAssignment: undefined };
  let providerId = 'gemini';
  let voiceName = id;
  if (id.includes(':')) {
    const [provider, ...rest] = id.split(':');
    providerId = provider || 'gemini';
    voiceName = rest.join(':') || id;
  } else if (id.startsWith('pt-BR-')) {
    providerId = 'gcp';
  }
  return {
    voiceAssignmentId: id,
    voiceAssignment: {
      ...(incomingAssignment && typeof incomingAssignment === 'object' ? incomingAssignment : {}),
      providerId,
      voiceName,
    },
  };
}
function removeSegmentAudio(storage: VoiceScriptStorage, projectId: string, segment: any) {
  const candidates = new Set<string>();
  if (segment.audioPath) candidates.add(path.join(projectDir(storage, projectId), 'audio', 'segments', path.basename(segment.audioPath)));
  if (segment.contextualAudioPath) candidates.add(path.join(projectDir(storage, projectId), 'audio', 'contextualized', path.basename(segment.contextualAudioPath)));
  candidates.add(path.join(projectDir(storage, projectId), 'audio', 'segments', `${segment.segmentId}.wav`));
  for (const filePath of candidates) fs.rmSync(filePath, { force: true });
  Object.assign(segment, {
    status: 'pending',
    audioPath: undefined,
    contextualAudioPath: undefined,
    audioSize: undefined,
    durationMs: undefined,
    checksum: undefined,
    lastError: undefined,
  });
}
function writeSegments(storage: VoiceScriptStorage, projectId: string, segments: any[]) {
  atomicWriteJson(segmentsPath(storage, projectId), segments);
  atomicWrite(path.join(scriptsDir(storage, projectId), 'segments.jsonl'), `${segments.map(segment => JSON.stringify(segment)).join('\n')}\n`);
}
function markSuggestionsStale(storage: VoiceScriptStorage, projectId: string, segmentId: string) {
  const suggestions = readJson<any[]>(suggestionsPath(storage, projectId), []);
  let changed = false;
  for (const suggestion of suggestions) {
    if (suggestion.segmentId === segmentId && suggestion.status === 'pending') {
      suggestion.status = 'stale';
      suggestion.staleAt = now();
      suggestion.reason = `${suggestion.reason || ''} O trecho foi editado depois desta análise.`.trim();
      changed = true;
    }
  }
  if (changed) atomicWriteJson(suggestionsPath(storage, projectId), suggestions);
}
function rebuildReports(storage: VoiceScriptStorage, projectId: string, segments: any[]) {
  const projects = readProjects(storage);
  const project = projects.find(item => item.projectId === projectId);
  if (!project) throw new Error('Projeto não encontrado.');
  const chapters = readJson<any[]>(chaptersPath(storage, projectId), []);
  const units = readSourceUnits(storage, projectId);
  let report: any = readJson<any>(reportPath(storage, projectId), null);
  if (units.length) {
    const job = readScriptGenerationJob(storage as any, projectId);
    report = buildScriptReport(projectId, chapters, units, segments, job?.fallbackBatchIds || []);
    atomicWriteJson(reportPath(storage, projectId), report);
  }
  const suggestions = readJson<any[]>(suggestionsPath(storage, projectId), []);
  const pendingFinal = suggestions.filter(item => item.status === 'pending' && item.mode === 'final_audit');
  if (report) {
    const structuralFailures = [
      ...(report.missingUnitIds || []),
      ...(report.duplicatedUnitIds || []),
      ...(report.unresolvedSpeakers || []).map((item: any) => item.segmentId),
    ];
    const existingFinal = readJson<any>(finalReportPath(storage, projectId), {});
    atomicWriteJson(finalReportPath(storage, projectId), {
      ...existingFinal,
      version: 1,
      projectId,
      status: structuralFailures.length ? 'FAIL' : pendingFinal.length ? 'REVIEW' : 'PASS',
      scriptComplete: report.scriptComplete,
      coverage: report.coverage,
      unresolvedSpeakers: report.totalUnresolved,
      structuralFailures,
      pendingFinalAuditSuggestions: pendingFinal.length,
      generatedAt: now(),
    });
    project.status = report.scriptComplete && !pendingFinal.length ? 'generating_audio' : 'scripting';
  }
  project.updatedAt = now();
  writeProjects(storage, projects);
  return { project, report };
}

export function saveVoiceAssignments(storage: VoiceScriptStorage, projectIdInput: string, body: any) {
  const projectId = safeProjectId(projectIdInput);
  const project = getProject(storage, projectId);
  if (!project) throw new Error('Projeto não encontrado.');
  const characters = readJson<any[]>(charactersPath(storage, projectId), []);
  if (!characters.length) throw new Error('Bíblia de personagens não encontrada.');
  const incoming = Array.isArray(body?.assignments) ? body.assignments : Array.isArray(body?.characters) ? body.characters : [];
  if (!incoming.length) throw new Error('Nenhuma atribuição de voz foi enviada.');
  const changedCharacterIds = new Set<string>();
  for (const item of incoming) {
    const characterId = String(item?.characterId || '').trim();
    const character = characters.find(entry => entry.characterId === characterId);
    if (!character) continue;
    const requestedVoiceId = item.voiceAssignmentId ?? (item.voiceAssignment?.providerId && item.voiceAssignment?.voiceName
      ? `${item.voiceAssignment.providerId}:${item.voiceAssignment.voiceName}`
      : undefined);
    if (requestedVoiceId === undefined) continue;
    const before = voiceIdentity(character);
    Object.assign(character, normalizeVoice(String(requestedVoiceId), item.voiceAssignment), { voiceUpdatedAt: now() });
    if (before !== voiceIdentity(character)) changedCharacterIds.add(characterId);
  }
  if (!changedCharacterIds.size) return { project, characters, affectedSegmentIds: [], saved: true };
  atomicWriteJson(charactersPath(storage, projectId), characters);
  const segments = readJson<any[]>(segmentsPath(storage, projectId), []);
  const affectedSegmentIds: string[] = [];
  const audiobookNarratorChanged = project.productionMode === 'audiobook' && changedCharacterIds.has('char_narrator');
  for (const segment of segments) {
    if (audiobookNarratorChanged || changedCharacterIds.has(segment.speakerId)) {
      removeSegmentAudio(storage, projectId, segment);
      segment.voiceInvalidatedAt = now();
      affectedSegmentIds.push(segment.segmentId);
    }
  }
  if (segments.length) writeSegments(storage, projectId, segments);
  const rebuilt = rebuildReports(storage, projectId, segments);
  return { ...rebuilt, characters, segments, affectedSegmentIds, changedCharacterIds: Array.from(changedCharacterIds), saved: true };
}

export function saveScriptSegment(storage: VoiceScriptStorage, projectIdInput: string, segmentId: string, body: any) {
  const projectId = safeProjectId(projectIdInput);
  const project = getProject(storage, projectId);
  if (!project) throw new Error('Projeto não encontrado.');
  const segments = readJson<any[]>(segmentsPath(storage, projectId), []);
  const segment = segments.find(item => item.segmentId === segmentId);
  if (!segment) throw new Error('Trecho do roteiro não encontrado.');
  const characters = readJson<any[]>(charactersPath(storage, projectId), []);
  const allowedSpeakers = new Set(['char_narrator', 'unresolved', ...characters.map(character => String(character.characterId))]);
  const requestedSpeaker = body?.speakerId === undefined ? segment.speakerId : String(body.speakerId);
  if (!allowedSpeakers.has(requestedSpeaker)) throw new Error('O locutor selecionado não pertence à Bíblia.');
  const spokenText = body?.spokenText === undefined ? String(segment.spokenText || '') : String(body.spokenText);
  if (!spokenText.trim()) throw new Error('O texto falado não pode ficar vazio.');
  const before = JSON.stringify({ speakerId: segment.speakerId, spokenText: segment.spokenText, direction: segment.direction || {} });
  let speakerId = requestedSpeaker;
  if (project.productionMode === 'audiobook') {
    if (!['char_narrator', 'unresolved'].includes(requestedSpeaker)) {
      segment.portrayedSpeakerId = requestedSpeaker;
      segment.performanceContext = { ...(segment.performanceContext || {}), mode: 'single_narrator', portrayedSpeakerId: requestedSpeaker };
    }
    speakerId = 'char_narrator';
  }
  Object.assign(segment, {
    spokenText,
    speakerId,
    direction: { ...(segment.direction || {}), ...(body?.direction || {}) },
    manuallyReviewed: true,
    reviewedAt: now(),
  });
  const after = JSON.stringify({ speakerId: segment.speakerId, spokenText: segment.spokenText, direction: segment.direction || {} });
  if (before !== after) {
    removeSegmentAudio(storage, projectId, segment);
    segment.reviewHistory = [
      ...(Array.isArray(segment.reviewHistory) ? segment.reviewHistory : []),
      { source: 'manual_edit', before: JSON.parse(before), after: JSON.parse(after), appliedAt: now() },
    ];
    markSuggestionsStale(storage, projectId, segmentId);
  }
  writeSegments(storage, projectId, segments);
  atomicWrite(path.join(scriptsDir(storage, projectId), 'tts-input', `${segment.segmentId}.txt`), String(segment.spokenText || ''));
  const rebuilt = rebuildReports(storage, projectId, segments);
  return { success: true, segment, segments, ...rebuilt };
}

export function registerVoiceScriptPersistenceRoutes(app: Express, storageProvider: () => VoiceScriptStorage) {
  app.put('/api/projects/:projectId/voice-assignments', (req: Request, res: Response) => {
    try { return res.json(saveVoiceAssignments(storageProvider(), req.params.projectId, req.body)); }
    catch (error: any) { return res.status(409).json({ error: { code: 'VOICE_ASSIGNMENT_SAVE_FAILED', message: error?.message || 'Não foi possível salvar a voz.' } }); }
  });
  app.put('/api/projects/:projectId/script-segments/:segmentId', (req: Request, res: Response) => {
    try { return res.json(saveScriptSegment(storageProvider(), req.params.projectId, String(req.params.segmentId || ''), req.body)); }
    catch (error: any) { return res.status(409).json({ error: { code: 'SCRIPT_SEGMENT_SAVE_FAILED', message: error?.message || 'Não foi possível salvar o trecho.' } }); }
  });
}
