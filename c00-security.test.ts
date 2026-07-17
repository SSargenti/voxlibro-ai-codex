import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';

// Spy on express application listen BEFORE importing server.ts
const listenSpy = vi.spyOn(express.application, 'listen');

import request from 'supertest';
import fs from 'fs';
import path from 'path';
import {
  app,
  redactSensitiveData,
  encrypt,
  decrypt,
  isValidMasterKey,
  CREDENTIALS_PATH,
  GEMINI_CREDENTIALS_PATH,
  OPENAI_CREDENTIALS_PATH,
  ttsProviders
} from './server.ts';

describe('VoxLibro AI — Security & Robust Credential Isolation Suite (F00-R1)', () => {
  const originalMasterKey = process.env.VOXLIBRO_MASTER_KEY;

  beforeEach(() => {
    // Clear credentials folder for isolated testing
    if (fs.existsSync(CREDENTIALS_PATH)) {
      try { fs.unlinkSync(CREDENTIALS_PATH); } catch (e) {}
    }
    if (fs.existsSync(GEMINI_CREDENTIALS_PATH)) {
      try { fs.unlinkSync(GEMINI_CREDENTIALS_PATH); } catch (e) {}
    }
    if (fs.existsSync(OPENAI_CREDENTIALS_PATH)) {
      try { fs.unlinkSync(OPENAI_CREDENTIALS_PATH); } catch (e) {}
    }
  });

  afterEach(() => {
    process.env.VOXLIBRO_MASTER_KEY = originalMasterKey;
    vi.unstubAllEnvs();
  });

  // 1. Redaction centralizada
  it('1. Redaction centralizada intercepta e oculta chaves Google, tokens Bearer e query parameters nas strings, erros, arrays e objetos', () => {
    const rawKey = 'AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6';
    const rawToken = 'Bearer ya29.a0AfH6SMD_random_chars_here_for_token_mock_12345';
    const rawOpenAiKey = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890';
    const queryStr = 'https://texttospeech.googleapis.com/v1/voices?key=AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6';

    // Test string redaction
    const redactedStr1 = redactSensitiveData(`Using key ${rawKey} for authorization`);
    expect(redactedStr1).toContain('[REDACTED_API_KEY]');
    expect(redactedStr1).not.toContain(rawKey);

    const redactedStr2 = redactSensitiveData(`Headers: ${rawToken}`);
    expect(redactedStr2).toContain('Bearer [REDACTED_TOKEN]');
    expect(redactedStr2).not.toContain(rawToken);

    const redactedStr3 = redactSensitiveData(`URL: ${queryStr}`);
    expect(redactedStr3).toContain('key=[REDACTED');
    expect(redactedStr3).not.toContain(rawKey);
    expect(redactSensitiveData(rawOpenAiKey)).toBe('[REDACTED_API_KEY]');

    // Test Error redaction
    const err = new Error(`Connection failed with key=${rawKey} and token=${rawToken}`);
    const redactedErr = redactSensitiveData(err);
    expect(redactedErr).toBeInstanceOf(Error);
    expect(redactedErr.message).toContain('key=[REDACTED');
    expect(redactedErr.message).toContain('[REDACTED');
    expect(redactedErr.message).not.toContain(rawKey);

    // Test Array redaction
    const arr = [rawKey, `auth ${rawToken}`, 'clean string'];
    const redactedArr = redactSensitiveData(arr);
    expect(redactedArr[0]).toContain('[REDACTED');
    expect(redactedArr[1]).toContain('[REDACTED');
    expect(redactedArr[2]).toBe('clean string');

    // Test Object redaction
    const obj = {
      apiKey: rawKey,
      secret: 'my-secret',
      nested: {
        otherField: 'clean-data',
        tokenValue: rawToken
      }
    };
    const redactedObj = redactSensitiveData(obj);
    expect(redactedObj.apiKey).toBe('[REDACTED_SECURE]');
    expect(redactedObj.secret).toBe('[REDACTED_SECURE]');
    expect(redactedObj.nested.otherField).toBe('clean-data');
    expect(redactedObj.nested.tokenValue).toBe('[REDACTED_SECURE]');
  });

  // 2. Endpoint /api/settings/credentials/status nunca expõe as chaves inteiras ou fragmentos delas (lastFour removido)
  it('2. Endpoint /api/settings/credentials/status nunca expõe as chaves inteiras ou fragmentos delas', async () => {
    // Inject some fake env keys via stubEnv
    vi.stubEnv('GOOGLE_CLOUD_TTS_API_KEY', 'AIzaSyMyFakeGcpTtsKeyForStatusEndpoint1234');
    vi.stubEnv('GEMINI_API_KEY', 'AIzaSyMyFakeGeminiKeyForStatusEndpoint5678');
    vi.stubEnv('OPENAI_API_KEY', 'sk-proj-FakeOpenAiKeyForStatusEndpoint9012');

    const response = await request(app)
      .get('/api/settings/credentials/status')
      .expect(200);

    const bodyStr = JSON.stringify(response.body);
    
    // Assert no partial keys (e.g. "1234" or "5678") are in the JSON response
    expect(bodyStr).not.toContain('1234');
    expect(bodyStr).not.toContain('5678');
    expect(bodyStr).not.toContain('9012');
    expect(response.body.openai).toBeDefined();
    expect(response.body.gcp).toBeDefined();
    expect(response.body.gemini).toBeDefined();
    expect(response.body.gcp.lastFour).toBeUndefined();
    expect(response.body.gemini.lastFour).toBeUndefined();
    expect(response.body.openai.lastFour).toBeUndefined();
  });

  // 3. Persistência de credencial com sessionOnly=false falha se VOXLIBRO_MASTER_KEY for ausente/baixa entropia
  it('3. Persistência de credencial com sessionOnly=false falha se VOXLIBRO_MASTER_KEY for ausente ou de baixa entropia', async () => {
    // Use low entropy key via direct assignment
    process.env.VOXLIBRO_MASTER_KEY = 'short';
    if (fs.existsSync(CREDENTIALS_PATH)) {
      try { fs.unlinkSync(CREDENTIALS_PATH); } catch (e) {}
    }

    const payload = {
      method: 'apiKey',
      apiKey: 'AIzaSyMySuperSecretTtsKeyThatShouldNotBeSavedPlaintxt',
      sessionOnly: false
    };

    const response = await request(app)
      .put('/api/settings/credentials/google-cloud-tts')
      .send(payload)
      .expect(400);

    expect(response.body.error).toBeDefined();
    expect(response.body.error.code).toBe('MASTER_KEY_REQUIRED');
    expect(fs.existsSync(CREDENTIALS_PATH)).toBe(false);

    // Try with a placeholder key
    process.env.VOXLIBRO_MASTER_KEY = 'ENTER_SOME_KEY_CONTAINING_PLACEHOLDER_WORDS';
    const response2 = await request(app)
      .put('/api/settings/credentials/google-cloud-tts')
      .send(payload)
      .expect(400);

    expect(response2.body.error.code).toBe('MASTER_KEY_REQUIRED');
    expect(fs.existsSync(CREDENTIALS_PATH)).toBe(false);
  });

  // 4. Sucesso ao persistir criptografado com AES-256-GCM sob chave mestra válida
  it('4. Sucesso ao persistir criptografado com AES-256-GCM sob chave mestra válida e prova de não-exposição de plaintext', async () => {
    // Use valid high entropy key (minimum 32 safe characters, no restricted words)
    const validMasterKey = 'ThisIsAReallySecureAndSuperComplexSecretMasterKeyToUse!';
    process.env.VOXLIBRO_MASTER_KEY = validMasterKey;
    if (fs.existsSync(CREDENTIALS_PATH)) {
      try { fs.unlinkSync(CREDENTIALS_PATH); } catch (e) {}
    }

    const secretKey = 'AIzaSyMySuperSecretGcpTtsKeyThatWillBeEncryptedSafe';
    const payload = {
      method: 'apiKey',
      apiKey: secretKey,
      sessionOnly: false
    };

    await request(app)
      .put('/api/settings/credentials/google-cloud-tts')
      .send(payload)
      .expect(200);

    // Verify file generated
    expect(fs.existsSync(CREDENTIALS_PATH)).toBe(true);

    const fileContent = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    
    // Proving no plaintext exists in the encrypted file
    expect(fileContent).not.toContain(secretKey);
    expect(fileContent).toContain('iv');
    expect(fileContent).toContain('encrypted');
    expect(fileContent).toContain('tag');

    // Prove decryption works and yields correct key
    const decrypted = decrypt(fileContent, validMasterKey);
    const parsed = JSON.parse(decrypted);
    expect(parsed.method).toBe('apiKey');
    expect(parsed.apiKey).toBe(secretKey);
  });

  // 5. Endpoint /api/tts-sample devolve erros devidamente mapeados e sanitizados em vez de mensagens diretas da API
  it('5. Endpoint /api/tts-sample devolve erros devidamente mapeados e sanitizados em caso de chave inválida', async () => {
    // Mock GCP Provider synthesize to throw an API key error
    const gcpProvider = ttsProviders['gcp'];
    const originalSynthesize = gcpProvider.synthesize;
    
    gcpProvider.synthesize = async () => {
      throw new Error('Google Cloud TTS API error [status 400]: API key not valid');
    };

    // Temporarily satisfy validateConfiguration
    const originalValidate = gcpProvider.validateConfiguration;
    gcpProvider.validateConfiguration = () => true;

    const payload = {
      text: 'Olá mundo',
      voiceId: 'gcp:pt-BR-Wavenet-A'
    };

    const response = await request(app)
      .post('/api/tts-sample')
      .send(payload)
      .expect(500);

    expect(response.body.error).toBeDefined();
    expect(response.body.error.code).toBe('API_KEY_INVALID');
    expect(response.body.error.message).toContain('A chave de API fornecida é inválida');

    // Clean up mocks
    gcpProvider.synthesize = originalSynthesize;
    gcpProvider.validateConfiguration = originalValidate;
  });
});
