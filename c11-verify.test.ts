import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiTtsProvider, GoogleCloudTtsProvider, synthesizeTtsForSegment, ttsProviders, parseGcpServiceAccountCredentials, extractGoogleBearerToken } from './server';

describe('VoxLibro C11 - Vozes Reais e Provedores Separados', () => {
  beforeEach(() => {
    vi.stubEnv('GEMINI_API_KEY', 'fake-gemini-key');
    vi.stubEnv('GOOGLE_CLOUD_TTS_API_KEY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('deve listar vozes reais do Gemini no catálogo predefinido', async () => {
    const provider = new GeminiTtsProvider();
    const voices = await provider.listVoices();
    expect(voices.length).toBeGreaterThan(0);
    expect(voices.map(v => v.voiceName)).toContain('Kore');
    expect(voices.map(v => v.voiceName)).toContain('Puck');
    expect(voices.map(v => v.voiceName)).toContain('Zephyr');
  });

  it('valida e normaliza o JSON da Service Account fornecido por GCP_CREDENTIALS', () => {
    const credentials = parseGcpServiceAccountCredentials(JSON.stringify({
      type: 'service_account', project_id: 'voxlibro-test', client_email: 'tts@voxlibro-test.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\\nTESTE\\n-----END PRIVATE KEY-----\\n'
    }));
    expect(credentials?.project_id).toBe('voxlibro-test');
    expect(credentials?.private_key).toContain('\nTESTE\n');
  });

  it('recusa JSON incompleto ou inválido em GCP_CREDENTIALS', () => {
    expect(() => parseGcpServiceAccountCredentials('{invalido')).toThrow('JSON válido');
    expect(() => parseGcpServiceAccountCredentials(JSON.stringify({ type:'service_account' }))).toThrow('client_email');
  });

  it('extrai Bearer token de Headers ou de objetos com caixa variável', () => {
    expect(extractGoogleBearerToken({ Authorization:'Bearer token-a' })).toBe('token-a');
    expect(extractGoogleBearerToken({ authorization:'Bearer token-b' })).toBe('token-b');
    expect(extractGoogleBearerToken(new Headers({ authorization:'Bearer token-c' }))).toBe('token-c');
  });

  it('não deve mostrar vozes Cloud se o provedor GCP não estiver configurado', async () => {
    const provider = new GoogleCloudTtsProvider();
    expect(provider.validateConfiguration()).toBe(false);
    const voices = await provider.listVoices();
    expect(voices.length).toBe(0);
  });

  it('deve mostrar vozes Cloud se o provedor GCP estiver configurado com chave dedicada', async () => {
    vi.stubEnv('GOOGLE_CLOUD_TTS_API_KEY', 'fake-gcp-key');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ voices: [{ name: 'pt-BR-Wavenet-A', languageCodes: ['pt-BR'], ssmlGender: 'FEMALE' }] })
    }));
    const provider = new GoogleCloudTtsProvider();
    expect(provider.validateConfiguration()).toBe(true);
    const voices = await provider.listVoices();
    expect(voices.length).toBeGreaterThan(0);
    expect(voices[0].providerId).toBe('gcp');
  });

  it('não deve reutilizar silenciosamente a GEMINI_API_KEY para o Google Cloud TTS', () => {
    vi.stubEnv('GEMINI_API_KEY', 'some-gemini-key');
    vi.stubEnv('GOOGLE_CLOUD_TTS_API_KEY', '');
    const provider = new GoogleCloudTtsProvider();
    expect(provider.validateConfiguration()).toBe(false);
  });

  it('deve resolver corretamente o provedor e voz para síntese utilizando o objeto de atribuição de voz', async () => {
    const characters = [
      {
        characterId: 'char_kore',
        voiceAssignment: {
          providerId: 'gemini',
          voiceName: 'Kore',
          configurations: {}
        }
      }
    ];

    // Mock Gemini synthesize method
    const geminiSpy = vi.spyOn(ttsProviders.gemini, 'synthesize').mockResolvedValue(Buffer.from('gemini-audio'));

    const result = await synthesizeTtsForSegment('Olá', 'char_kore', characters);
    expect(result.toString()).toBe('gemini-audio');
    expect(geminiSpy).toHaveBeenCalledWith('Olá', 'Kore', expect.any(Object));

    geminiSpy.mockRestore();
  });

  it('deve falhar e não fazer fallback para Web Speech se o provedor não estiver configurado ou falhar', async () => {
    const characters = [
      {
        characterId: 'char_gcp',
        voiceAssignment: {
          providerId: 'gcp',
          voiceName: 'pt-BR-Neural2-A',
          configurations: {}
        }
      }
    ];

    // GCP is not configured (no dedicated GOOGLE_CLOUD_TTS_API_KEY), so it must fail explicitly.
    await expect(synthesizeTtsForSegment('Olá', 'char_gcp', characters)).rejects.toThrow();
  });
});
