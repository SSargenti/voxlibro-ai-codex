import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  sliceTextIntoSourceUnits,
  validateBatchResponse,
  applyModeConstraints,
  SourceUnit,
  ScriptSegment
} from './src/lib/losslessScript';

describe('VoxLibro C10 - Roteiro Lossless Tests', () => {
  const mockCharacters = [
    { characterId: 'char_narrator', canonicalName: 'Narrador' },
    { characterId: 'char_pedro', canonicalName: 'Pedro' }
  ];
  const charIds = mockCharacters.map(c => c.characterId);

  it('deve fatiar deterministicamente o texto em sourceUnits com as classificações corretas', () => {
    const text = `Capítulo 1: O Início
Este é um parágrafo normal de introdução.
— Olá, como vai você? perguntou Pedro.
> Esta é uma citação elegante.
* Item 1 da lista
Nota: Esta é uma nota explicativa.
E = mc^2`;

    const units = sliceTextIntoSourceUnits(text, 'ch_1');
    expect(units.length).toBe(7);

    expect(units[0].type).toBe('título');
    expect(units[1].type).toBe('parágrafo');
    expect(units[2].type).toBe('fala');
    expect(units[3].type).toBe('citação');
    expect(units[4].type).toBe('lista');
    expect(units[5].type).toBe('nota');
    expect(units[6].type).toBe('fórmula');

    // Verify offsets and sourceText
    expect(units[0].sourceText).toBe('Capítulo 1: O Início');
    expect(units[6].sourceText).toBe('E = mc^2');
  });

  it('deve validar correspondência 1:1 e falhar se houver unidades omitidas ou duplicadas', () => {
    const units: SourceUnit[] = [
      { sourceUnitId: 'su_ch1_1', chapterId: 'ch1', order: 1, sourceText: 'A', offsets: { start: 0, end: 1 }, type: 'parágrafo' },
      { sourceUnitId: 'su_ch1_2', chapterId: 'ch1', order: 2, sourceText: 'B', offsets: { start: 2, end: 3 }, type: 'parágrafo' }
    ];

    // Perfect valid response
    const validResponse = {
      segments: [
        {
          sourceUnitId: 'su_ch1_1',
          classificação: 'parágrafo',
          speakerId: 'char_narrator',
          spokenText: 'A',
          direction: { emotion: 'neutro', intensity: 0.5, pace: 'normal', pauseAfterMs: 200 }
        },
        {
          sourceUnitId: 'su_ch1_2',
          classificação: 'parágrafo',
          speakerId: 'char_narrator',
          spokenText: 'B',
          direction: { emotion: 'neutro', intensity: 0.5, pace: 'normal', pauseAfterMs: 200 }
        }
      ]
    };

    const segments = validateBatchResponse(validResponse, units, charIds);
    expect(segments.length).toBe(2);
    expect(segments[0].sourceUnitId).toBe('su_ch1_1');
    expect(segments[1].sourceUnitId).toBe('su_ch1_2');

    // Omitted unit (missing su_ch1_2)
    const omittedResponse = {
      segments: [
        {
          sourceUnitId: 'su_ch1_1',
          classificação: 'parágrafo',
          speakerId: 'char_narrator',
          spokenText: 'A',
          direction: { emotion: 'neutro', intensity: 0.5, pace: 'normal', pauseAfterMs: 200 }
        }
      ]
    };
    expect(() => validateBatchResponse(omittedResponse, units, charIds)).toThrow('ID de unidade ausente');

    // Duplicate unit ID
    const duplicateResponse = {
      segments: [
        {
          sourceUnitId: 'su_ch1_1',
          classificação: 'parágrafo',
          speakerId: 'char_narrator',
          spokenText: 'A',
          direction: { emotion: 'neutro', intensity: 0.5, pace: 'normal', pauseAfterMs: 200 }
        },
        {
          sourceUnitId: 'su_ch1_1',
          classificação: 'parágrafo',
          speakerId: 'char_narrator',
          spokenText: 'Duplicado',
          direction: { emotion: 'neutro', intensity: 0.5, pace: 'normal', pauseAfterMs: 200 }
        }
      ]
    };
    expect(() => validateBatchResponse(duplicateResponse, units, charIds)).toThrow('ID de unidade duplicado');

    // Unknown unit ID
    const unknownResponse = {
      segments: [
        {
          sourceUnitId: 'su_ch1_1',
          classificação: 'parágrafo',
          speakerId: 'char_narrator',
          spokenText: 'A',
          direction: { emotion: 'neutro', intensity: 0.5, pace: 'normal', pauseAfterMs: 200 }
        },
        {
          sourceUnitId: 'su_ch1_99',
          classificação: 'parágrafo',
          speakerId: 'char_narrator',
          spokenText: 'Foreign',
          direction: { emotion: 'neutro', intensity: 0.5, pace: 'normal', pauseAfterMs: 200 }
        }
      ]
    };
    expect(() => validateBatchResponse(unknownResponse, units, charIds)).toThrow('ID de unidade desconhecido');
  });

  it('deve mapear speaker inexistente para unresolved', () => {
    const units: SourceUnit[] = [
      { sourceUnitId: 'su_ch1_1', chapterId: 'ch1', order: 1, sourceText: 'A', offsets: { start: 0, end: 1 }, type: 'parágrafo' }
    ];

    const response = {
      segments: [
        {
          sourceUnitId: 'su_ch1_1',
          classificação: 'parágrafo',
          speakerId: 'char_alien_inexistente',
          spokenText: 'A',
          direction: { emotion: 'neutro', intensity: 0.5, pace: 'normal', pauseAfterMs: 200 }
        }
      ]
    };

    const segments = validateBatchResponse(response, units, charIds);
    expect(segments[0].speakerId).toBe('unresolved');
  });

  it('deve aplicar as restrições de cada modo de produção', () => {
    const baseSegment: ScriptSegment = {
      segmentId: 'seg_1',
      projectId: 'proj_1',
      chapterId: 'ch1',
      sourceUnitId: 'su_ch1_1',
      order: 1,
      type: 'fala',
      speakerId: 'char_pedro',
      originalText: 'E = mc^2',
      spokenText: 'E igual a mc quadrado',
      direction: { emotion: 'neutro', intensity: 0.5, pace: 'normal', pauseAfterMs: 200 },
      status: 'pending'
    };

    // Audiobook Mode: force char_narrator
    const audiobookSeg = applyModeConstraints({ ...baseSegment }, 'audiobook');
    expect(audiobookSeg.speakerId).toBe('char_narrator');

    // Audiodrama Mode: preserve pedro, project intensity
    const dramaSeg = applyModeConstraints({ ...baseSegment }, 'audiodrama', 0.85);
    expect(dramaSeg.speakerId).toBe('char_pedro');
    expect(dramaSeg.direction.intensity).toBe(0.85);

    // Technical Mode: formula spokenText must match originalText for auditability
    const techSegment: ScriptSegment = {
      ...baseSegment,
      type: 'fórmula'
    };
    const techSeg = applyModeConstraints({ ...techSegment }, 'technical');
    expect(techSeg.spokenText).toBe('E = mc^2');
  });
});
