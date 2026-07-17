import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { 
  pcmToWav, 
  getWavDurationAndValidate, 
  validateTtsAudioFile, 
  synthesizeTtsForSegment, 
  getPreviewCachePath, 
  ttsProviders 
} from './server';

describe('VoxLibro C12 - Áudio Real e Validado', () => {
  const PROJECTS_ROOT = './projects';

  beforeEach(() => {
    vi.stubEnv('GEMINI_API_KEY', 'fake-gemini-key');
    vi.stubEnv('GOOGLE_CLOUD_TTS_API_KEY', '');
    if (!fs.existsSync(PROJECTS_ROOT)) {
      fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('deve converter PCM puro de 16-bit para WAV correto com cabeçalho de 44 bytes', () => {
    const rawPcm = Buffer.alloc(1000); // 1000 bytes de silêncio
    const wav = pcmToWav(rawPcm, 24000);

    expect(wav.length).toBe(1044);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    
    // Verificar canais (1 channel, offset 22)
    expect(wav.readUInt16LE(22)).toBe(1);
    // Verificar sample rate (24000, offset 24)
    expect(wav.readUInt32LE(24)).toBe(24000);
    // Verificar bits por amostra (16 bits, offset 34)
    expect(wav.readUInt16LE(34)).toBe(16);
    // Verificar chunk de dados
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(1000);
  });

  it('deve extrair a duração e validar um WAV íntegro com sucesso', () => {
    const rawPcm = Buffer.alloc(48000); // 48000 bytes = 24000 amostras de 16-bit
    const wav = pcmToWav(rawPcm, 24000);

    const validation = getWavDurationAndValidate(wav);
    expect(validation.isValid).toBe(true);
    // 24000 amostras a 24000 Hz com 1 canal = 1.0 segundo = 1000 milissegundos
    expect(validation.durationMs).toBe(1000);
    expect(validation.sampleRate).toBe(24000);
    expect(validation.channels).toBe(1);
    expect(validation.bitsPerSample).toBe(16);
  });

  it('deve invalidar WAV corrompido ou sem assinatura correta', () => {
    const corruptBuffer = Buffer.from('isto-nao-eh-um-wav-real-com-certeza-corrompido-etc');
    const validation = getWavDurationAndValidate(corruptBuffer);
    expect(validation.isValid).toBe(false);
    expect(validation.error).toContain('Invalid WAV signature');
  });

  it('deve invalidar arquivos muito pequenos', () => {
    const smallBuffer = Buffer.from('RIFFwave');
    const validation = getWavDurationAndValidate(smallBuffer);
    expect(validation.isValid).toBe(false);
    expect(validation.error).toContain('File size is too small');
  });

  it('deve validar um arquivo de áudio no disco e extrair checksum, tamanho e duração', () => {
    const rawPcm = Buffer.alloc(24000); // 0.5 segundo
    const wav = pcmToWav(rawPcm, 24000);
    
    const testFileDir = path.join(PROJECTS_ROOT, 'test_c12');
    fs.mkdirSync(testFileDir, { recursive: true });
    const filePath = path.join(testFileDir, 'test_audio.wav');
    fs.writeFileSync(filePath, wav);

    const validation = validateTtsAudioFile(filePath, 'gemini', 'Zephyr');
    expect(validation.isValid).toBe(true);
    expect(validation.size).toBe(24044);
    expect(validation.durationMs).toBe(500);
    expect(validation.checksum).toHaveLength(64); // SHA-256 hex length

    // Limpar arquivo de teste
    try {
      fs.unlinkSync(filePath);
      fs.rmdirSync(testFileDir);
    } catch (e) {}
  });

  it('deve invalidar vozes não cadastradas para o provedor correspondente', () => {
    const rawPcm = Buffer.alloc(24000);
    const wav = pcmToWav(rawPcm, 24000);
    
    const testFileDir = path.join(PROJECTS_ROOT, 'test_c12');
    fs.mkdirSync(testFileDir, { recursive: true });
    const filePath = path.join(testFileDir, 'test_audio2.wav');
    fs.writeFileSync(filePath, wav);

    // Voz inválida para gemini
    const validationGeminiInvalid = validateTtsAudioFile(filePath, 'gemini', 'VozInexistente');
    expect(validationGeminiInvalid.isValid).toBe(false);
    expect(validationGeminiInvalid.error).toContain('Voice not registered');

    // Voz válida do gcp testada no provedor gemini
    const validationCrossMatch = validateTtsAudioFile(filePath, 'gemini', 'pt-BR-Wavenet-A');
    expect(validationCrossMatch.isValid).toBe(false);
    expect(validationCrossMatch.error).toContain('Voice not registered');

    // Limpar
    try {
      fs.unlinkSync(filePath);
      fs.rmdirSync(testFileDir);
    } catch (e) {}
  });

  it('deve verificar o cache antes de sintetizar e usar o buffer do cache se for válido', async () => {
    const rawPcm = Buffer.alloc(48000);
    const mockWav = pcmToWav(rawPcm, 24000);

    const characters = [
      {
        characterId: 'char_zephyr',
        voiceAssignment: {
          providerId: 'gemini',
          voiceName: 'Zephyr',
          configurations: {}
        }
      }
    ];

    // Gerar o cache path esperado
    const text = 'Texto de teste do cache';
    const config = { emotion: undefined, intensity: 0.5 };
    const cachePath = getPreviewCachePath('gemini', 'gemini-2.5-flash-preview-tts', 'Zephyr', text, config);

    // Garantir que diretório do cache exista e escrever mock lá
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, mockWav);

    // Spy on synthesize para garantir que ele NÃO seja chamado (hit de cache)
    const synthesizeSpy = vi.spyOn(ttsProviders.gemini, 'synthesize');

    const result = await synthesizeTtsForSegment(text, 'char_zephyr', characters);
    
    expect(synthesizeSpy).not.toHaveBeenCalled();
    expect(result.length).toBe(48044);

    // Limpar cache após teste
    try { fs.unlinkSync(cachePath); } catch (e) {}
  });
});
