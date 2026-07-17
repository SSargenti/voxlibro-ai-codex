import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureOpenAiModelRouting,
  normalizeCharacterAnalysisResponseText,
  resetOpenAiRoutingAttempts,
} from './src/openAiModelRouting';

const characterPrompt = `Analise o trecho para identificar narradores e todos os personagens.
Retorne JSON com candidates e cada candidateName, aliases, papel, evidenceUnitIds,
genderPresentation, estimatedAge e speechStyle.`;

describe('normalização tolerante da Bíblia narrativa', () => {
  beforeEach(() => {
    resetOpenAiRoutingAttempts();
  });

  it('converte rótulos semânticos fora do enum para o vocabulário aceito', () => {
    const response = normalizeCharacterAnalysisResponseText(JSON.stringify({
      candidates: [
        {
          candidateName: 'Mordecai',
          aliases: 'O gerente',
          atributos: 'voz grave e rouca',
          papel: 'coadjuvante',
          evidenceUnitIds: 'Mordecai respondeu.',
          confidence: 85,
          genderPresentation: 'masculino',
          estimatedAge: 'idoso',
          speechStyle: {
            pace: 'pausado',
            energy: 'alta',
            timbre: 'deep and raspy',
          },
        },
      ],
    }));

    expect(response.changed).toBe(true);
    expect(response.normalizedCandidates).toBe(1);
    expect(response.droppedCandidates).toBe(0);

    const parsed = JSON.parse(response.text);
    expect(parsed.candidates[0]).toMatchObject({
      candidateName: 'Mordecai',
      aliases: ['O gerente'],
      atributos: ['voz grave e rouca'],
      papel: 'supporting',
      evidenceUnitIds: ['Mordecai respondeu.'],
      confidence: 0.85,
      genderPresentation: 'male',
      estimatedAge: 'mature',
      speechStyle: {
        pace: 'slow',
        energy: 'high',
        timbre: 'gravelly',
      },
    });
  });

  it('usa neutral para timbre desconhecido sem perder o personagem', () => {
    const response = normalizeCharacterAnalysisResponseText(JSON.stringify({
      candidates: [
        {
          candidateName: 'Aurora',
          aliases: [],
          atributos: [],
          papel: 'main',
          evidenceUnitIds: [],
          confidence: 0.9,
          genderPresentation: 'female',
          estimatedAge: 'adult',
          speechStyle: {
            pace: 'moderate',
            energy: 'medium',
            timbre: 'ethereal-cinematic',
          },
        },
      ],
    }));

    const parsed = JSON.parse(response.text);
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0].speechStyle.timbre).toBe('neutral');
  });

  it('descarta somente registros sem nome e preserva os candidatos válidos', () => {
    const response = normalizeCharacterAnalysisResponseText(JSON.stringify({
      candidates: [
        {
          candidateName: '',
          speechStyle: { timbre: 'deep' },
        },
        {
          candidateName: 'Narrador',
          papel: 'narrador',
          speechStyle: { timbre: 'claro' },
        },
      ],
    }));

    expect(response.droppedCandidates).toBe(1);
    const parsed = JSON.parse(response.text);
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]).toMatchObject({
      candidateName: 'Narrador',
      papel: 'narrator',
      speechStyle: { timbre: 'clear' },
    });
  });

  it('normaliza a resposta antes de o Zod rígido do servidor recebê-la', async () => {
    const rawResponse = {
      text: JSON.stringify({
        candidates: [
          {
            candidateName: 'Carl',
            papel: 'supporting',
            speechStyle: { pace: 'normal', energy: 'medium', timbre: 'baritone' },
          },
        ],
      }),
      candidates: [
        {
          content: {
            parts: [
              {
                text: 'conteúdo original',
              },
            ],
          },
        },
      ],
    };
    const generateContent = vi.fn().mockResolvedValue(rawResponse);
    let configuredClient: any;
    const server: any = {
      TEXT_MODELS: { bulk: 'gpt-5.6', editorial: 'gpt-5.6', audit: 'gpt-5.6' },
      ai: { models: { generateContent } },
      setAiClient: (client: any) => {
        configuredClient = client;
      },
    };

    configureOpenAiModelRouting(server);
    const result = await configuredClient.models.generateContent({
      model: 'gpt-5.6-luna',
      contents: [{ text: characterPrompt }],
      config: { responseMimeType: 'application/json' },
    });

    const parsed = JSON.parse(result.text);
    expect(parsed.candidates[0].speechStyle.timbre).toBe('gravelly');
    expect(result.candidates[0].content.parts[0].text).toBe(result.text);
    expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-terra',
      config: expect.objectContaining({ reasoningEffort: 'medium' }),
    }));
  });

  it('não altera respostas de outras tarefas', async () => {
    const translationResponse = { text: 'A luz se apagou.' };
    const generateContent = vi.fn().mockResolvedValue(translationResponse);
    let configuredClient: any;
    const server: any = {
      TEXT_MODELS: { bulk: 'gpt-5.6', editorial: 'gpt-5.6', audit: 'gpt-5.6' },
      ai: { models: { generateContent } },
      setAiClient: (client: any) => {
        configuredClient = client;
      },
    };

    configureOpenAiModelRouting(server);
    const result = await configuredClient.models.generateContent({
      model: 'gpt-5.6',
      contents: [{
        text: 'Traduza estritamente. TEXTO PRINCIPAL PARA TRADUZIR: The light went out. Modo de Tradução: Literário',
      }],
    });

    expect(result).toEqual(translationResponse);
  });
});
