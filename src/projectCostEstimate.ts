import type { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { OPENAI_TEXT_TIERS } from './openAiModelRouting';

export const COST_PRICING_VERSION = '2026-07-17';

export type ProjectCostStorage = {
  projectsRoot: string;
  projectsDbFile: string;
};

type CostRange = { minUsd: number; maxUsd: number };

type ModelPrice = {
  inputPerMillion: number;
  outputPerMillion: number;
};

const OPENAI_PRICES: Record<'luna' | 'terra' | 'sol', ModelPrice> = {
  luna: { inputPerMillion: 1, outputPerMillion: 6 },
  terra: { inputPerMillion: 2.5, outputPerMillion: 15 },
  sol: { inputPerMillion: 5, outputPerMillion: 30 },
};

const GOOGLE_TTS_PRICES = {
  waveNetPerMillionCharacters: 4,
  neural2PerMillionCharacters: 16,
  geminiFlashInputPerMillionTokens: 0.5,
  geminiFlashAudioPerMillionTokens: 10,
  geminiProInputPerMillionTokens: 1,
  geminiProAudioPerMillionTokens: 20,
};

function roundUsd(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function addRanges(...ranges: CostRange[]): CostRange {
  return {
    minUsd: roundUsd(ranges.reduce((sum, range) => sum + range.minUsd, 0)),
    maxUsd: roundUsd(ranges.reduce((sum, range) => sum + range.maxUsd, 0)),
  };
}

function modelTier(model: string): keyof typeof OPENAI_PRICES {
  const normalized = String(model || '').toLowerCase();
  if (normalized.includes('luna')) return 'luna';
  if (normalized.includes('terra')) return 'terra';
  return 'sol';
}

function tokenRangeCost(
  model: string,
  sourceTokens: number,
  inputMultipliers: [number, number],
  outputMultipliers: [number, number],
): CostRange {
  const price = OPENAI_PRICES[modelTier(model)];
  const minInput = sourceTokens * inputMultipliers[0];
  const maxInput = sourceTokens * inputMultipliers[1];
  const minOutput = sourceTokens * outputMultipliers[0];
  const maxOutput = sourceTokens * outputMultipliers[1];
  return {
    minUsd: roundUsd((minInput * price.inputPerMillion + minOutput * price.outputPerMillion) / 1_000_000),
    maxUsd: roundUsd((maxInput * price.inputPerMillion + maxOutput * price.outputPerMillion) / 1_000_000),
  };
}

function isPortuguese(language?: string) {
  const normalized = String(language || '').toLowerCase().trim();
  return normalized.startsWith('pt') || normalized.includes('portug') || normalized.includes('brazil');
}

function readProjects(projectsDbFile: string): any[] {
  if (!fs.existsSync(projectsDbFile)) return [];
  const parsed = JSON.parse(fs.readFileSync(projectsDbFile, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('Banco de projetos inválido.');
  return parsed;
}

function readProjectText(projectDir: string) {
  const rawTextPath = path.join(projectDir, 'extracted', 'raw_text.txt');
  if (fs.existsSync(rawTextPath)) return fs.readFileSync(rawTextPath, 'utf8');

  const chaptersPath = path.join(projectDir, 'normalized', 'chapters.json');
  if (!fs.existsSync(chaptersPath)) return '';
  const chapters = JSON.parse(fs.readFileSync(chaptersPath, 'utf8'));
  if (!Array.isArray(chapters)) return '';
  return chapters.map(chapter => chapter.originalText || chapter.translatedText || '').join('\n\n');
}

function characterPriceRange(characters: [number, number], pricePerMillion: number): CostRange {
  return {
    minUsd: roundUsd((characters[0] * pricePerMillion) / 1_000_000),
    maxUsd: roundUsd((characters[1] * pricePerMillion) / 1_000_000),
  };
}

function geminiTtsRange(
  textTokens: [number, number],
  audioSeconds: [number, number],
  inputPrice: number,
  audioPrice: number,
): CostRange {
  const audioTokens: [number, number] = [audioSeconds[0] * 25, audioSeconds[1] * 25];
  return {
    minUsd: roundUsd((textTokens[0] * inputPrice + audioTokens[0] * audioPrice) / 1_000_000),
    maxUsd: roundUsd((textTokens[1] * inputPrice + audioTokens[1] * audioPrice) / 1_000_000),
  };
}

export function estimateProjectCost(project: any, sourceText: string) {
  const sourceCharacters = sourceText.length || Number(project?.characterCount || 0);
  const sourceWords = Number(project?.wordCount || sourceText.split(/\s+/).filter(Boolean).length || 0);
  if (!sourceCharacters || !sourceWords) {
    throw new Error('O texto precisa ser extraído antes de calcular a previsão de custo.');
  }

  // A practical language-agnostic approximation. Actual tokenization varies by language and punctuation.
  const sourceTokens = Math.max(1, Math.ceil(sourceCharacters / 3.8));
  const languageUnknown = !project?.sourceLanguage || project.sourceLanguage === 'auto';
  const translationLikely = project?.translationEnabled !== false && (languageUnknown || !isPortuguese(project?.sourceLanguage));

  const bulk = tokenRangeCost(
    OPENAI_TEXT_TIERS.bulk,
    sourceTokens,
    translationLikely ? [1.15, 1.45] : [0.2, 0.45],
    translationLikely ? [1, 1.25] : [0.02, 0.07],
  );
  const editorial = tokenRangeCost(
    OPENAI_TEXT_TIERS.editorial,
    sourceTokens,
    [2, 3.2],
    [1.05, 1.35],
  );
  const audit = tokenRangeCost(
    OPENAI_TEXT_TIERS.audit,
    sourceTokens,
    [0.15, 0.45],
    [0.01, 0.06],
  );
  const openAiTotal = addRanges(bulk, editorial, audit);

  const speechCharacters: [number, number] = translationLikely
    ? [Math.round(sourceCharacters * 0.9), Math.round(sourceCharacters * 1.18)]
    : [Math.round(sourceCharacters * 0.97), Math.round(sourceCharacters * 1.08)];
  const speechTokens: [number, number] = [
    Math.ceil(speechCharacters[0] / 3.8),
    Math.ceil(speechCharacters[1] / 3.8),
  ];
  const audioSeconds: [number, number] = [
    Math.max(1, Math.round((sourceWords / 170) * 60)),
    Math.max(1, Math.round((sourceWords / 135) * 60)),
  ];

  const voiceOptions = [
    {
      id: 'gcp-wavenet',
      provider: 'Google Cloud Text-to-Speech',
      label: 'WaveNet / Standard',
      cost: characterPriceRange(speechCharacters, GOOGLE_TTS_PRICES.waveNetPerMillionCharacters),
      freeTierNote: 'A franquia mensal do Google pode reduzir a cobrança; a estimativa usa o preço de tabela antes da franquia.',
    },
    {
      id: 'gcp-neural2',
      provider: 'Google Cloud Text-to-Speech',
      label: 'Neural2',
      cost: characterPriceRange(speechCharacters, GOOGLE_TTS_PRICES.neural2PerMillionCharacters),
      freeTierNote: 'A franquia mensal do Google pode reduzir a cobrança; a estimativa usa o preço de tabela antes da franquia.',
    },
    {
      id: 'gemini-flash-tts',
      provider: 'Gemini Developer API',
      label: 'Gemini 2.5 Flash TTS',
      cost: geminiTtsRange(
        speechTokens,
        audioSeconds,
        GOOGLE_TTS_PRICES.geminiFlashInputPerMillionTokens,
        GOOGLE_TTS_PRICES.geminiFlashAudioPerMillionTokens,
      ),
      freeTierNote: 'Estimativa para processamento padrão, não Batch.',
    },
    {
      id: 'gemini-pro-tts',
      provider: 'Gemini Developer API',
      label: 'Gemini 2.5 Pro TTS',
      cost: geminiTtsRange(
        speechTokens,
        audioSeconds,
        GOOGLE_TTS_PRICES.geminiProInputPerMillionTokens,
        GOOGLE_TTS_PRICES.geminiProAudioPerMillionTokens,
      ),
      freeTierNote: 'Estimativa para processamento padrão, não Batch.',
    },
  ];

  return {
    pricingVersion: COST_PRICING_VERSION,
    currency: 'USD',
    basis: {
      sourceCharacters,
      sourceWords,
      estimatedSourceTokens: sourceTokens,
      estimatedAudioMinutes: {
        min: Math.round((audioSeconds[0] / 60) * 10) / 10,
        max: Math.round((audioSeconds[1] / 60) * 10) / 10,
      },
      translationLikely,
      languageUnknown,
    },
    textProcessing: {
      provider: 'OpenAI API',
      total: openAiTotal,
      stages: [
        { id: 'bulk', label: translationLikely ? 'Preparação e tradução em volume' : 'Preparação em volume', model: OPENAI_TEXT_TIERS.bulk, cost: bulk },
        { id: 'editorial', label: 'Bíblia narrativa e roteiro', model: OPENAI_TEXT_TIERS.editorial, cost: editorial },
        { id: 'audit', label: 'Auditoria e ambiguidades', model: OPENAI_TEXT_TIERS.audit, cost: audit },
      ],
    },
    voiceOptions: voiceOptions.map(option => ({
      ...option,
      totalWithText: addRanges(openAiTotal, option.cost),
    })),
    assumptions: [
      'Estimativa baseada no texto extraído, com faixas para variação de tokens, direção e duração da fala.',
      'Não inclui retries excepcionais, OCR de páginas escaneadas, efeitos sonoros, cache, impostos ou variações cambiais.',
      'A cobrança real é determinada pelos medidores dos provedores; franquias mensais podem reduzir o valor de TTS.',
      'Tarifas registradas em 17/07/2026 e devem ser revisadas quando os provedores alterarem seus preços.',
    ],
  };
}

export function registerProjectCostEstimateRoutes(
  app: Express,
  storageProvider: () => ProjectCostStorage,
) {
  app.get('/api/projects/:projectId/cost-estimate', (req: Request, res: Response) => {
    try {
      const storage = storageProvider();
      const projects = readProjects(storage.projectsDbFile);
      const project = projects.find(item => item.projectId === req.params.projectId);
      if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Projeto não encontrado.' } });

      const projectDir = path.join(storage.projectsRoot, req.params.projectId);
      const sourceText = readProjectText(projectDir);
      const estimate = estimateProjectCost(project, sourceText);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ projectId: req.params.projectId, estimate });
    } catch (error: any) {
      return res.status(400).json({
        error: {
          code: 'COST_ESTIMATE_UNAVAILABLE',
          message: error?.message || 'Não foi possível calcular a previsão de custo.',
        },
      });
    }
  });
}
