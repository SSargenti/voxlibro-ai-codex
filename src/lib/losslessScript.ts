import fs from 'fs';
import path from 'path';
import { z } from 'zod';

// ==================== SCHEMAS & TYPES ====================

export interface SourceUnit {
  sourceUnitId: string;
  chapterId: string;
  order: number;
  sourceText: string;
  offsets: { start: number; end: number };
  type: 'título' | 'parágrafo' | 'fala' | 'citação' | 'lista' | 'nota' | 'fórmula';
}

export interface ScriptSegment {
  segmentId: string;
  projectId: string;
  chapterId: string;
  sourceUnitId: string;
  order: number;
  type: 'título' | 'parágrafo' | 'fala' | 'citação' | 'lista' | 'nota' | 'fórmula';
  speakerId: string;
  originalText: string;
  spokenText: string;
  direction: {
    emotion: string;
    intensity: number;
    pace: 'slow' | 'normal' | 'fast';
    pauseAfterMs: number;
  };
  status: 'pending' | 'generating' | 'ready' | 'failed';
  locked?: boolean;
}

export interface ScriptReport {
  projectId: string;
  status: 'PASS' | 'FAIL';
  coverage: number; // 0 to 100
  totalSourceUnits: number;
  totalSegments: number;
  totalBatches: number;
  totalUnresolved: number;
  scriptComplete: boolean;
  unresolvedSpeakers: Array<{
    segmentId: string;
    sourceUnitId: string;
    originalText: string;
    suggestedSpeaker: string;
  }>;
  chaptersSummary: Array<{
    chapterId: string;
    title: string;
    sourceUnitsCount: number;
    segmentsCount: number;
  }>;
  ledgerNonNarrated: Array<{
    sourceUnitId: string;
    reason: string;
    userDecision: 'skip' | 'pending' | 'narrated';
  }>;
}

// Zod schema for validation
export const SegmentResponseSchema = z.object({
  sourceUnitId: z.string(),
  classificação: z.enum(['título', 'parágrafo', 'fala', 'citação', 'lista', 'nota', 'fórmula']),
  speakerId: z.string(),
  spokenText: z.string(),
  direction: z.object({
    emotion: z.string().default('neutral'),
    intensity: z.number().default(0.5),
    pace: z.enum(['slow', 'normal', 'fast']).default('normal'),
    pauseAfterMs: z.number().default(300),
  }),
});

export const BatchResponseSchema = z.object({
  segments: z.array(SegmentResponseSchema),
});

// ==================== PARSER / DETERMINISTIC SPLITTER ====================

export function sliceTextIntoSourceUnits(text: string, chapterId: string): SourceUnit[] {
  const lines = text.split('\n');
  const units: SourceUnit[] = [];
  let currentOffset = 0;
  let order = 1;

  for (const line of lines) {
    const start = currentOffset;
    const end = currentOffset + line.length;
    currentOffset = end + 1; // +1 for '\n'

    const trimmed = line.trim();
    if (!trimmed) {
      continue; // Skip empty lines, offsets still advance
    }

    let type: SourceUnit['type'] = 'parágrafo';
    const lower = trimmed.toLowerCase();

    // Deterministic rules
    const isTitle =
      order === 1 ||
      trimmed.startsWith('#') ||
      lower.startsWith('capítulo') ||
      lower.startsWith('chapter') ||
      lower.startsWith('título:') ||
      lower.startsWith('title:');

    const isList =
      trimmed.startsWith('* ') ||
      trimmed.startsWith('- ') ||
      trimmed.startsWith('+ ') ||
      /^\d+\.\s/.test(trimmed);

    const isDialogue =
      trimmed.startsWith('—') ||
      trimmed.startsWith('–') ||
      (trimmed.startsWith('-') && !trimmed.startsWith('- ')) ||
      trimmed.startsWith('"') ||
      trimmed.startsWith('“') ||
      (trimmed.includes(': ') && /^[A-ZÁ-Ú][a-zá-úA-ZÁ-Ú\s-]{1,25}:/.test(trimmed));

    const isFormula =
      /^[a-zA-Z0-9\s+\-*/=(){}\[\]_^{\\.+]+$/.test(trimmed) &&
      (trimmed.includes('=') ||
        trimmed.includes('+') ||
        trimmed.includes('-') ||
        trimmed.includes('*') ||
        trimmed.includes('/') ||
        trimmed.includes('\\') ||
        trimmed.includes('^'));

    const isQuote = trimmed.startsWith('>') || (trimmed.startsWith('“') && trimmed.endsWith('”') && !isDialogue);

    const isNote =
      lower.startsWith('nota:') ||
      lower.startsWith('note:') ||
      lower.startsWith('referência:') ||
      lower.startsWith('reference:') ||
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('(') && trimmed.endsWith(')') && (lower.includes('nota') || lower.includes('note')));

    if (isTitle) {
      type = 'título';
    } else if (isNote) {
      type = 'nota';
    } else if (isList) {
      type = 'lista';
    } else if (isQuote) {
      type = 'citação';
    } else if (isFormula) {
      type = 'fórmula';
    } else if (isDialogue) {
      type = 'fala';
    }

    units.push({
      sourceUnitId: `su_${chapterId}_${order}`,
      chapterId,
      order: order++,
      sourceText: line,
      offsets: { start, end },
      type,
    });
  }

  return units;
}

// ==================== BATCH PROCESSOR & VALIDATOR ====================

export function validateBatchResponse(
  responseObj: any,
  expectedUnits: SourceUnit[],
  availableCharacterIds: string[]
): ScriptSegment[] {
  // Validate schema first
  const parsed = BatchResponseSchema.safeParse(responseObj);
  if (!parsed.success) {
    throw new Error(`Resposta do Gemini inválida no schema Zod: ${parsed.error.message}`);
  }

  const returnedSegments = parsed.data.segments;
  const expectedIdsSet = new Set(expectedUnits.map((u) => u.sourceUnitId));
  const returnedIdsSet = new Set<string>();

  // 1:1 Matching Checks
  for (const seg of returnedSegments) {
    const uid = seg.sourceUnitId;

    // Unknown ID
    if (!expectedIdsSet.has(uid)) {
      throw new Error(`ID de unidade desconhecido retornado pelo Gemini: ${uid}`);
    }

    // Duplicate ID
    if (returnedIdsSet.has(uid)) {
      throw new Error(`ID de unidade duplicado retornado pelo Gemini: ${uid}`);
    }

    returnedIdsSet.add(uid);
  }

  // Missing ID check
  for (const expectedId of expectedIdsSet) {
    if (!returnedIdsSet.has(expectedId)) {
      throw new Error(`ID de unidade ausente na resposta do Gemini: ${expectedId}`);
    }
  }

  // Build the strict segments mapping to original text
  const segments: ScriptSegment[] = [];

  for (const seg of returnedSegments) {
    const originalUnit = expectedUnits.find((u) => u.sourceUnitId === seg.sourceUnitId)!;

    // Resolve speaker robustly
    let resolvedSpeakerId = seg.speakerId;
    if (resolvedSpeakerId !== 'char_narrator') {
      if (!availableCharacterIds.includes(resolvedSpeakerId)) {
        resolvedSpeakerId = 'unresolved';
      }
    }

    segments.push({
      segmentId: `seg_${seg.sourceUnitId.substring(3)}_${Date.now()}`,
      projectId: '', // will be filled by caller
      chapterId: originalUnit.chapterId,
      sourceUnitId: originalUnit.sourceUnitId,
      order: originalUnit.order,
      type: originalUnit.type,
      speakerId: resolvedSpeakerId,
      originalText: originalUnit.sourceText, // Obtained LOCALLY! Never trust returned original text.
      spokenText: seg.spokenText,
      direction: {
        emotion: seg.direction.emotion,
        intensity: seg.direction.intensity,
        pace: seg.direction.pace,
        pauseAfterMs: seg.direction.pauseAfterMs,
      },
      status: 'pending',
    });
  }

  return segments;
}

// ==================== MODE DIFFERENTIATION ====================

export function applyModeConstraints(
  segment: ScriptSegment,
  mode: 'audiobook' | 'audiodrama' | 'technical',
  projectIntensity?: number
): ScriptSegment {
  if (mode === 'audiobook') {
    // Audiobook Mode: single narrator by default, high fidelity
    segment.speakerId = 'char_narrator';
  } else if (mode === 'audiodrama') {
    // Audiodrama Mode: preserve individual speakers, project intensity
    if (projectIntensity !== undefined) {
      segment.direction.intensity = projectIntensity;
    }
  } else if (mode === 'technical') {
    // Technical Mode: auditable text for abbreviations/symbols, keep original spoken text unless formula, etc.
    // Ensure we do not modify spoken text for technical keywords without authorization.
    if (segment.type === 'fórmula' || segment.type === 'nota') {
      segment.spokenText = segment.originalText; // Ensure spokenText is auditable and matches original
    }
  }
  return segment;
}
