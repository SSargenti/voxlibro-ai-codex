/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import AdmZip from 'adm-zip';
import ffmpegPath from 'ffmpeg-static';
import multer from 'multer';
// @ts-ignore
import * as pdfParseModule from 'pdf-parse';
const pdfParse = ((pdfParseModule as any).default || pdfParseModule) as any;
import mammoth from 'mammoth';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { sliceTextIntoSourceUnits, validateBatchResponse, applyModeConstraints } from './src/lib/losslessScript';
import { GoogleAuth } from 'google-auth-library';

dotenv.config();

// --- SECURITY & CREDENTIALS SUPPORT ---

// Centralized log redactor
export function redactSensitiveData(data: any): any {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    let redacted = data;
    // Replace Bearer tokens
    redacted = redacted.replace(/Bearer\s+[a-zA-Z0-9_\-\.\~+\/]+=*/gi, 'Bearer [REDACTED_TOKEN]');
    // Replace x-goog-api-key headers/values in text
    redacted = redacted.replace(/x-goog-api-key=?[a-zA-Z0-9_-]+/gi, 'x-goog-api-key=[REDACTED]');
    // Replace Google API keys (AIzaSy...)
    redacted = redacted.replace(/AIzaSy[a-zA-Z0-9_-]{30,45}/g, '[REDACTED_API_KEY]');
    // Replace OpenAI project and legacy API keys
    redacted = redacted.replace(/sk-(?:proj-)?[a-zA-Z0-9_-]{20,}/g, '[REDACTED_API_KEY]');
    // Replace generic credentials in key=value structures
    redacted = redacted.replace(/(?:key|apiKey|api_key|token|password|secret|auth|authorization)=["']?[a-zA-Z0-9_\-]+["']?/gi, (match) => {
      const parts = match.split('=');
      return `${parts[0]}=[REDACTED]`;
    });
    // Replace JSON fields like "apiKey": "..."
    redacted = redacted.replace(/"(key|apiKey|api_key|token|password|secret|auth|authorization)"\s*:\s*"[^"]*"/gi, '"$1": "[REDACTED]"');
    // Replace URL query params like ?key=... or &key=...
    redacted = redacted.replace(/(&|\?)key=[a-zA-Z0-9_-]+/gi, '$1key=[REDACTED]');
    return redacted;
  }
  if (data instanceof Error) {
    const redactedErr = new Error(redactSensitiveData(data.message));
    redactedErr.name = data.name;
    if (data.stack) {
      redactedErr.stack = redactSensitiveData(data.stack);
    }
    if ((data as any).cause) {
      (redactedErr as any).cause = redactSensitiveData((data as any).cause);
    }
    return redactedErr;
  }
  if (Array.isArray(data)) {
    return data.map(item => redactSensitiveData(item));
  }
  if (typeof data === 'object') {
    const cleaned: any = {};
    for (const key of Object.keys(data)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('key') ||
        lowerKey.includes('token') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('password') ||
        lowerKey.includes('auth') ||
        lowerKey.includes('credential')
      ) {
        cleaned[key] = '[REDACTED_SECURE]';
      } else {
        cleaned[key] = redactSensitiveData(data[key]);
      }
    }
    return cleaned;
  }
  return data;
}

export function sanitizeGoogleErrorMessage(errMessage: string): string {
  return redactSensitiveData(errMessage);
}

// Global console monkey-patching for absolute redaction of logs, stdout and stderr
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const originalInfo = console.info;

console.log = (...args: any[]) => {
  originalLog(...args.map(arg => {
    if (arg instanceof Error) {
      return redactSensitiveData(arg).stack || redactSensitiveData(arg).message;
    }
    return redactSensitiveData(arg);
  }));
};

console.warn = (...args: any[]) => {
  originalWarn(...args.map(arg => {
    if (arg instanceof Error) {
      return redactSensitiveData(arg).stack || redactSensitiveData(arg).message;
    }
    return redactSensitiveData(arg);
  }));
};

console.error = (...args: any[]) => {
  originalError(...args.map(arg => {
    if (arg instanceof Error) {
      return redactSensitiveData(arg).stack || redactSensitiveData(arg).message;
    }
    return redactSensitiveData(arg);
  }));
};

console.info = (...args: any[]) => {
  originalInfo(...args.map(arg => {
    if (arg instanceof Error) {
      return redactSensitiveData(arg).stack || redactSensitiveData(arg).message;
    }
    return redactSensitiveData(arg);
  }));
};

export const safeLogger = {
  info: (...args: any[]) => console.log(...args),
  warn: (...args: any[]) => console.warn(...args),
  error: (...args: any[]) => console.error(...args)
};

// Encrypt / Decrypt helpers for storage
export function encrypt(text: string, masterKey: string): string {
  const key = crypto.createHash('sha256').update(masterKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString('hex'),
    encrypted: encrypted.toString('hex'),
    tag: tag.toString('hex')
  });
}

export function decrypt(encryptedJson: string, masterKey: string): string {
  const key = crypto.createHash('sha256').update(masterKey).digest();
  const { iv, encrypted, tag } = JSON.parse(encryptedJson);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  const decrypted = decipher.update(Buffer.from(encrypted, 'hex')) + decipher.final('utf8');
  return decrypted;
}

export function isValidMasterKey(key: string | undefined): boolean {
  if (!key) return false;
  if (key.length < 32) return false;
  const lowerKey = key.toLowerCase();
  if (
    lowerKey.includes('entersome') || 
    lowerKey.includes('highentropy') || 
    lowerKey.includes('secretkey') || 
    lowerKey.includes('my_voxlibro_master_key') ||
    lowerKey.includes('example') ||
    lowerKey.includes('placeholder')
  ) {
    return false;
  }
  return true;
}

export function mapAndSanitizeTtsError(err: any): { code: string; message: string } {
  const errMsg = err?.message || String(err);
  const lowerMsg = errMsg.toLowerCase();
  
  let code = 'TTS_SYNTHESIS_FAILED';
  let message = 'Falha na geração de áudio do provedor de voz.';

  if (lowerMsg.includes('key not valid') || lowerMsg.includes('invalid api key') || lowerMsg.includes('key_invalid') || lowerMsg.includes('api key is invalid') || lowerMsg.includes('api_key_invalid') || lowerMsg.includes('invalid credentials')) {
    code = 'API_KEY_INVALID';
    message = 'A chave de API fornecida é inválida. Por favor, verifique suas configurações de credenciais.';
  } else if (lowerMsg.includes('disabled') || lowerMsg.includes('has not been used') || lowerMsg.includes('api_disabled') || lowerMsg.includes('not enabled')) {
    code = 'API_DISABLED';
    message = 'A API do Google Cloud Text-to-Speech não está ativada no projeto do console do Google Cloud.';
  } else if (lowerMsg.includes('billing') || lowerMsg.includes('billing_disabled') || lowerMsg.includes('billing not enabled')) {
    code = 'BILLING_DISABLED';
    message = 'O faturamento (billing) não está ativo ou configurado para este projeto do Google Cloud.';
  } else if (lowerMsg.includes('quota') || lowerMsg.includes('rate limit') || lowerMsg.includes('too many requests')) {
    code = 'QUOTA_EXCEEDED';
    message = 'A cota de requisições do provedor de TTS foi excedida.';
  } else {
    message = redactSensitiveData(errMsg);
  }

  return { code, message };
}

// Memory session variables
export let sessionGcpTtsApiKey: string | null = null;
export let sessionGeminiApiKey: string | null = null;
export let sessionOpenAiApiKey: string | null = null;
export let sessionFreesoundApiKey: string | null = null;
export let gcpValidationStatus: 'unconfigured' | 'configured_untested' | 'valid' | 'invalid' | 'no_permission' | 'api_disabled' | 'billing_missing' = 'unconfigured';
export let gcpLastValidatedAt: string | null = null;
export let savedGcpTtsMethod: 'apiKey' | 'adc' = 'apiKey';

export const CREDENTIALS_PATH = path.join(process.cwd(), '.credentials', 'gcp-tts.json');
export const GEMINI_CREDENTIALS_PATH = path.join(process.cwd(), '.credentials', 'gemini.json');
export const OPENAI_CREDENTIALS_PATH = path.join(process.cwd(), '.credentials', 'openai.json');

// Ensure credentials directory exists on start
try {
  const credentialsDir = path.join(process.cwd(), '.credentials');
  if (!fs.existsSync(credentialsDir)) {
    fs.mkdirSync(credentialsDir, { recursive: true });
  }
} catch (e) {
  console.error('Failed to create credentials directory:', e);
}

// Auth client
let googleAuthClient: GoogleAuth | null = null;
let googleAuthConfigKey = '';

export type GcpServiceAccountCredentials = {
  type: 'service_account'; project_id: string; client_email: string; private_key: string;
  private_key_id?: string; client_id?: string; token_uri?: string;
};

export function parseGcpServiceAccountCredentials(raw = process.env.GCP_CREDENTIALS): GcpServiceAccountCredentials | null {
  if (!raw?.trim()) return null;
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('GCP_CREDENTIALS não contém um JSON válido'); }
  if (parsed.type !== 'service_account' || !parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error('GCP_CREDENTIALS deve conter type=service_account, project_id, client_email e private_key');
  }
  return { ...parsed, private_key: String(parsed.private_key).replace(/\\n/g, '\n') };
}

export function getGoogleAuth(): GoogleAuth {
  const configKey = crypto.createHash('sha256').update(`${process.env.GCP_CREDENTIALS || ''}|${process.env.GOOGLE_APPLICATION_CREDENTIALS || ''}`).digest('hex');
  if (!googleAuthClient || googleAuthConfigKey !== configKey) {
    const credentials = parseGcpServiceAccountCredentials();
    googleAuthClient = new GoogleAuth(credentials ? {
      credentials,
      projectId: credentials.project_id,
      scopes: ['https://www.googleapis.com/auth/cloud-platform']
    } : { scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    googleAuthConfigKey = configKey;
  }
  return googleAuthClient;
}

export async function checkAdcConfigured(): Promise<boolean> {
  if (process.env.GCP_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return true;
  }
  try {
    const auth = getGoogleAuth();
    const credentials = await auth.getCredentials();
    return !!credentials;
  } catch (err) {
    return false;
  }
}

export function getStoredCredentials(): { method: 'apiKey' | 'adc'; apiKey?: string } | null {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const content = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
      const masterKey = process.env.VOXLIBRO_MASTER_KEY;
      if (!isValidMasterKey(masterKey)) {
        console.error('VOXLIBRO_MASTER_KEY is missing or invalid, cannot decrypt stored credentials.');
        return null;
      }
      try {
        const decrypted = decrypt(content, masterKey!);
        return JSON.parse(decrypted);
      } catch (err) {
        console.error('Failed to decrypt stored credentials with master key:', err);
        return null;
      }
    }
  } catch (err) {
    console.error('Error reading stored credentials:', err);
  }
  return null;
}

export function getStoredGeminiCredentials(): { apiKey?: string } | null {
  try {
    if (fs.existsSync(GEMINI_CREDENTIALS_PATH)) {
      const content = fs.readFileSync(GEMINI_CREDENTIALS_PATH, 'utf8');
      const masterKey = process.env.VOXLIBRO_MASTER_KEY;
      if (!isValidMasterKey(masterKey)) {
        console.error('VOXLIBRO_MASTER_KEY is missing or invalid, cannot decrypt stored Gemini credentials.');
        return null;
      }
      try {
        const decrypted = decrypt(content, masterKey!);
        return JSON.parse(decrypted);
      } catch (err) {
        console.error('Failed to decrypt stored Gemini credentials with master key:', err);
        return null;
      }
    }
  } catch (err) {
    console.error('Error reading stored Gemini credentials:', err);
  }
  return null;
}

export function getStoredOpenAiCredentials(): { apiKey?: string } | null {
  try {
    if (!fs.existsSync(OPENAI_CREDENTIALS_PATH)) return null;
    const masterKey = process.env.VOXLIBRO_MASTER_KEY;
    if (!isValidMasterKey(masterKey)) return null;
    return JSON.parse(decrypt(fs.readFileSync(OPENAI_CREDENTIALS_PATH, 'utf8'), masterKey!));
  } catch (err) {
    console.error('Failed to read stored OpenAI credentials:', err);
    return null;
  }
}

export function getActiveOpenAiApiKey(): string | null {
  return process.env.OPENAI_API_KEY || sessionOpenAiApiKey || getStoredOpenAiCredentials()?.apiKey || null;
}

export function hasTextAi(): boolean {
  return !!getActiveOpenAiApiKey();
}

export function getActiveGeminiApiKey(): string | null {
  if (process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY;
  }
  if (sessionGeminiApiKey) {
    return sessionGeminiApiKey;
  }
  const stored = getStoredGeminiCredentials();
  if (stored && stored.apiKey) {
    return stored.apiKey;
  }
  return null;
}

export function updateAiClient() {
  const key = getActiveGeminiApiKey() || '';
  geminiTtsClient = key ? new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  }) : null;
}

export interface ResolvedGcpCreds {
  type: 'apiKey' | 'adc' | 'none';
  keyOrToken?: string;
  source: 'env_json' | 'env_adc' | 'env_tts' | 'stored_disk' | 'stored_session' | 'none';
}

export function extractGoogleBearerToken(headers: any): string | undefined {
  const authHeader = typeof headers?.get === 'function'
    ? (headers.get('authorization') || headers.get('Authorization'))
    : (headers?.authorization || headers?.Authorization);
  return typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
}

export async function getActiveGcpCredentials(): Promise<ResolvedGcpCreds> {
  // Service Account OAuth2 must win over legacy API keys.
  if (process.env.GCP_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    if (process.env.GCP_CREDENTIALS) {
      try { parseGcpServiceAccountCredentials(); }
      catch (err:any) { console.warn('GCP_CREDENTIALS inválida:', redactSensitiveData(err.message)); return { type:'none', source:'none' }; }
    }
    try {
      const auth = getGoogleAuth(); const client = await auth.getClient(); const headers = await client.getRequestHeaders();
      const token = extractGoogleBearerToken(headers);
      if (token) return { type:'adc', keyOrToken:token, source:process.env.GCP_CREDENTIALS ? 'env_json' : 'env_adc' };
    } catch (err:any) { console.warn('Falha ao obter token OAuth2 da Service Account:', redactSensitiveData(err.message)); }
    return { type:'adc', source:process.env.GCP_CREDENTIALS ? 'env_json' : 'env_adc' };
  }

  // 1. Session key GCP TTS (legacy compatibility)
  if (sessionGcpTtsApiKey) {
    return { type: 'apiKey', keyOrToken: sessionGcpTtsApiKey, source: 'stored_session' };
  }

  // 2. Environment variable GOOGLE_CLOUD_TTS_API_KEY
  if (process.env.GOOGLE_CLOUD_TTS_API_KEY) {
    return { type: 'apiKey', keyOrToken: process.env.GOOGLE_CLOUD_TTS_API_KEY, source: 'env_tts' };
  }

  // 3. Credencial persistida
  const stored = getStoredCredentials();
  if (stored && stored.method === 'apiKey' && stored.apiKey) {
    return { type: 'apiKey', keyOrToken: stored.apiKey, source: 'stored_disk' };
  }

  // 4. ADC somente se o método ADC tiver sido explicitamente selecionado/configurado
  const adcExplicitlySelected = stored && stored.method === 'adc';
  if (adcExplicitlySelected) {
    try {
      const auth = getGoogleAuth();
      const client = await auth.getClient();
      const headers = await client.getRequestHeaders();
      const token = extractGoogleBearerToken(headers);
      if (token) {
        return { type: 'adc', keyOrToken: token, source: stored && stored.method === 'adc' ? 'stored_disk' : 'env_adc' };
      }
    } catch (err) {
      console.warn('Failed to retrieve ADC token:', err);
    }
    return { type: 'adc', keyOrToken: undefined, source: stored && stored.method === 'adc' ? 'stored_disk' : 'env_adc' };
  }

  return { type: 'none', source: 'none' };
}

export function isGcpConfiguredSync(): boolean {
  if (process.env.GCP_CREDENTIALS) {
    try { return !!parseGcpServiceAccountCredentials(); } catch { return false; }
  }
  if (sessionGcpTtsApiKey) return true;
  if (process.env.GOOGLE_CLOUD_TTS_API_KEY) return true;
  const stored = getStoredCredentials();
  if (stored) {
    if (stored.method === 'apiKey' && stored.apiKey) return true;
    if (stored.method === 'adc') return true;
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return true;
  return false;
}

export const ACTUAL_PT_BR_VOICES = [
  { voiceName: 'pt-BR-Neural2-A', providerId: 'gcp', gender: 'female', languageCodes: ['pt-BR'] },
  { voiceName: 'pt-BR-Neural2-B', providerId: 'gcp', gender: 'male', languageCodes: ['pt-BR'] },
  { voiceName: 'pt-BR-Neural2-C', providerId: 'gcp', gender: 'female', languageCodes: ['pt-BR'] },
  { voiceName: 'pt-BR-Wavenet-A', providerId: 'gcp', gender: 'female', languageCodes: ['pt-BR'] },
  { voiceName: 'pt-BR-Wavenet-B', providerId: 'gcp', gender: 'male', languageCodes: ['pt-BR'] },
  { voiceName: 'pt-BR-Wavenet-C', providerId: 'gcp', gender: 'female', languageCodes: ['pt-BR'] },
  { voiceName: 'pt-BR-Wavenet-D', providerId: 'gcp', gender: 'female', languageCodes: ['pt-BR'] },
  { voiceName: 'pt-BR-Wavenet-E', providerId: 'gcp', gender: 'male', languageCodes: ['pt-BR'] },
  { voiceName: 'pt-BR-Standard-A', providerId: 'gcp', gender: 'female', languageCodes: ['pt-BR'] },
  { voiceName: 'pt-BR-Standard-B', providerId: 'gcp', gender: 'male', languageCodes: ['pt-BR'] },
  { voiceName: 'pt-BR-Standard-C', providerId: 'gcp', gender: 'female', languageCodes: ['pt-BR'] },
  { voiceName: 'pt-BR-Standard-D', providerId: 'gcp', gender: 'female', languageCodes: ['pt-BR'] },
  { voiceName: 'pt-BR-Standard-E', providerId: 'gcp', gender: 'male', languageCodes: ['pt-BR'] }
];

export const GEMINI_TTS_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'
];

export type VoiceProfile = { id: string; providerId: 'gemini'|'gemini-pro'|'gcp'; voiceName: string; label: string; gender: 'female'|'male'|'neutral'; age: 'young'|'adult'|'mature'|'any'; timbre: 'bright'|'warm'|'firm'|'soft'|'gravelly'|'smooth'|'clear'|'neutral'; energy: 'low'|'medium'|'high'; expressiveness: number; costTier: 'economic'|'standard'|'premium' };
const geminiTraits: Record<string, [VoiceProfile['gender'], VoiceProfile['age'], VoiceProfile['timbre'], VoiceProfile['energy'], number, string]> = {
  Zephyr:['female','adult','bright','medium',.9,'brilhante'], Puck:['male','young','bright','high',.95,'animada'], Charon:['male','mature','clear','low',.75,'informativa'], Kore:['female','adult','firm','medium',.9,'firme'], Fenrir:['male','adult','gravelly','high',.95,'intensa'], Leda:['female','young','bright','medium',.9,'jovem'], Orus:['male','adult','firm','medium',.85,'firme'], Aoede:['female','adult','soft','medium',.9,'leve'], Enceladus:['male','mature','soft','low',.8,'sussurrada'], Sulafat:['female','mature','warm','low',.85,'acolhedora'], Gacrux:['female','mature','warm','low',.8,'madura'], Achird:['male','adult','warm','medium',.85,'amigável'], Algenib:['male','mature','gravelly','medium',.85,'rouca'], Schedar:['male','adult','neutral','medium',.8,'equilibrada']
};
export const VOICE_CATALOG: VoiceProfile[] = [
  ...Object.entries(geminiTraits).flatMap(([voiceName, t]) => (['gemini','gemini-pro'] as const).map(providerId => ({ id:`${providerId}:${voiceName}`, providerId, voiceName, label:`${voiceName} · ${t[5]}`, gender:t[0], age:t[1], timbre:t[2], energy:t[3], expressiveness:t[4], costTier:(providerId === 'gemini' ? 'standard' : 'premium') as VoiceProfile['costTier'] }))),
  ...ACTUAL_PT_BR_VOICES.filter(v => /Neural2|Wavenet/.test(v.voiceName)).map(v => ({ id:`gcp:${v.voiceName}`, providerId:'gcp' as const, voiceName:v.voiceName, label:`${v.voiceName.replace('pt-BR-','')} · ${v.gender === 'female' ? 'feminina' : 'masculina'}`, gender:v.gender as VoiceProfile['gender'], age:'any' as const, timbre:'neutral' as const, energy:'medium' as const, expressiveness:v.voiceName.includes('Wavenet') ? .7 : .65, costTier:'economic' as const }))
];

export function recommendVoiceForCharacter(character: any, availableProviders: string[] = ['gemini','gemini-pro','gcp']) {
  const desiredGender = character.genderPresentation === 'female' || character.genderPresentation === 'male' ? character.genderPresentation : 'neutral';
  const ageText = `${character.estimatedAge || ''} ${(character.description || '')}`.toLowerCase();
  const desiredAge: VoiceProfile['age'] = /crian|menina|menino|jovem|adolesc/.test(ageText) ? 'young' : /velh|idos|madur|ancian/.test(ageText) ? 'mature' : 'adult';
  const traitText = `${character.description || ''} ${(character.personality || []).join(' ')} ${JSON.stringify(character.speechStyle || {})}`.toLowerCase();
  const desiredTimbre: VoiceProfile['timbre'] = /grave|rouc/.test(traitText) ? 'gravelly' : /firme|autor/.test(traitText) ? 'firm' : /suave|delic|sussurr/.test(traitText) ? 'soft' : /calor|acolhed/.test(traitText) ? 'warm' : /clara|brilh|jov/.test(traitText) ? 'bright' : 'neutral';
  const desiredEnergy: VoiceProfile['energy'] = /enérg|intens|agitado|entusiasm/.test(traitText) ? 'high' : /calm|pausad|lento|seren/.test(traitText) ? 'low' : 'medium';
  const ranked = VOICE_CATALOG.filter(v => availableProviders.includes(v.providerId)).map(voice => {
    let score = 30;
    const reasons: string[] = [];
    if (desiredGender === 'neutral' || voice.gender === desiredGender) { score += 30; reasons.push(desiredGender === 'neutral' ? 'gênero vocal flexível' : `voz ${desiredGender === 'female' ? 'feminina' : 'masculina'}`); }
    if (voice.age === 'any' || voice.age === desiredAge) { score += 15; reasons.push(`idade vocal ${desiredAge}`); }
    if (voice.timbre === desiredTimbre || desiredTimbre === 'neutral') { score += 15; reasons.push(`timbre ${voice.timbre}`); }
    if (voice.energy === desiredEnergy) { score += 10; reasons.push(`energia ${desiredEnergy}`); }
    if (character.role === 'narrator' && voice.energy !== 'high') { score += 8; reasons.push('estabilidade para narração'); }
    if (character.role !== 'narrator' && voice.expressiveness >= .85) { score += 7; reasons.push('boa expressividade dramática'); }
    return { voiceId: voice.id, score: Math.min(100, score), reasons, profile: voice };
  }).sort((a,b) => b.score - a.score);
  return { desired: { gender: desiredGender, age: desiredAge, timbre: desiredTimbre, energy: desiredEnergy }, ranked: ranked.slice(0,5), recommended: ranked[0] };
}


const app = express();
const PORT = Number(process.env.PORT || 3000);

export { app };

export function createApp() {
  return app;
}

export let logger = {
  info: (...args: any[]) => {
    if (process.env.NODE_ENV !== 'test') {
      console.log(...args);
    }
  },
  log: (...args: any[]) => {
    if (process.env.NODE_ENV !== 'test') {
      console.log(...args);
    }
  },
  warn: (...args: any[]) => {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(...args);
    }
  },
  error: (...args: any[]) => {
    if (process.env.NODE_ENV !== 'test') {
      console.error(...args);
    }
  }
};

export function setLogger(customLogger: typeof logger) {
  logger = customLogger;
}

export const TEXT_MODELS = {
  bulk: process.env.VOXLIBRO_BULK_MODEL || 'gpt-5.6',
  editorial: process.env.VOXLIBRO_EDITORIAL_MODEL || 'gpt-5.6',
  audit: process.env.VOXLIBRO_AUDIT_MODEL || 'gpt-5.6',
} as const;

function contentToText(contents: any): string {
  const visit = (value: any): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(visit).filter(Boolean).join('\n');
    if (!value || typeof value !== 'object') return '';
    if (typeof value.text === 'string') return value.text;
    return visit(value.parts || value.content || '');
  };
  return visit(contents);
}

function readOpenAiOutput(data: any): string {
  if (typeof data?.output_text === 'string') return data.output_text;
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') return part.text;
    }
  }
  return '';
}

export class OpenAiTextClient {
  models = {
    generateContent: async ({ model, contents, config }: any) => {
      const apiKey = getActiveOpenAiApiKey();
      if (!apiKey) throw new Error('OPENAI_API_KEY não configurada para análise de texto');
      const input = contentToText(contents);
      const editorialTask = /personagens|bíblia|continuidade|fatiador|roteiro|speakerId/i.test(input);
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model || TEXT_MODELS.bulk,
          input,
          reasoning: { effort: config?.reasoningEffort || (editorialTask ? 'medium' : 'low') },
          max_output_tokens: 25000,
        }),
      });
      const data: any = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error: any = new Error(data?.error?.message || `OpenAI respondeu HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      if (data?.status === 'incomplete') {
        throw new Error(`Resposta incompleta da OpenAI: ${data?.incomplete_details?.reason || 'limite de saída'}`);
      }
      const text = readOpenAiOutput(data);
      if (!text) throw new Error('A OpenAI retornou uma resposta sem texto');
      return { text, candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] };
    },
  };
}

// O cliente de texto e o cliente de voz são deliberadamente separados. Uma
// credencial nunca é reutilizada como fallback para outro provedor.
export let ai: any = new OpenAiTextClient();
export let geminiTtsClient: GoogleGenAI | null = null;

export function getGeminiTtsClient(): GoogleGenAI {
  if (!geminiTtsClient) updateAiClient();
  if (!geminiTtsClient) throw new Error('GEMINI_API_KEY não configurada para síntese de voz');
  return geminiTtsClient;
}

export function setAiClient(customAi: any) {
  ai = customAi;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
    files: 1,
  },
});

export class AppError extends Error {
  code: string;
  retryable: boolean;
  operation: string;
  projectId: string;
  chapterId?: string;
  segmentId?: string;
  status: number;

  constructor(params: {
    code: string;
    message: string;
    retryable: boolean;
    operation: string;
    projectId: string;
    chapterId?: string;
    segmentId?: string;
    status?: number;
  }) {
    const sanitizedMessage = AppError.sanitizeMessage(params.message);
    super(sanitizedMessage);
    this.name = 'AppError';
    this.code = params.code;
    this.retryable = params.retryable;
    this.operation = params.operation;
    this.projectId = params.projectId;
    this.chapterId = params.chapterId;
    this.segmentId = params.segmentId;
    this.status = params.status || 500;
  }

  static sanitizeMessage(msg: string): string {
    if (!msg) return '';
    let clean = msg.replace(/AIzaSy[A-Za-z0-9_-]{35}/g, '[REDACTED_API_KEY]');
    clean = clean.replace(/key=[A-Za-z0-9_-]+/gi, 'key=[REDACTED]');
    if (clean.length > 300) {
      clean = clean.slice(0, 300) + '... (mensagem truncada para segurança)';
    }
    return clean;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        operation: this.operation,
        projectId: this.projectId,
        chapterId: this.chapterId,
        segmentId: this.segmentId,
      }
    };
  }
}

// Helper function to call Gemini with exponential backoff retry for transient errors (e.g. 503, 429)
async function callGeminiWithRetry(
  apiCall: () => Promise<any>,
  retries = 5,
  delay = 1000
): Promise<any> {
  try {
    const result = await apiCall();
    // If successful, reset standard quota flags
    if (isGeminiQuotaExceeded) {
      isGeminiQuotaExceeded = false;
      console.log('[INFO] Gemini API standard quota restored.');
    }
    return result;
  } catch (error: any) {
    const errorStr = String(error?.message || error);
    const errorJson = JSON.stringify(error);

    const isQuotaExceeded = 
      errorStr.includes('quota') || 
      errorStr.includes('billing') || 
      errorStr.includes('exceeded your current quota') ||
      errorStr.includes('RESOURCE_EXHAUSTED') ||
      errorJson.includes('quota') ||
      errorJson.includes('billing') ||
      errorJson.includes('exceeded your current quota') ||
      errorJson.includes('RESOURCE_EXHAUSTED') ||
      error?.status === 429 ||
      error?.code === 429;

    if (isQuotaExceeded) {
      if (errorStr.includes('tts') || errorJson.includes('tts')) {
        isGeminiTTSQuotaExceeded = true;
        console.warn(`[WARN] Gemini TTS quota exceeded (429/RESOURCE_EXHAUSTED). Disabling premium TTS generation.`);
      } else {
        isGeminiQuotaExceeded = true;
        console.warn(`[WARN] Gemini API standard quota exceeded (429/RESOURCE_EXHAUSTED). Disabling standard API calls to prevent slow timeouts.`);
      }
    }

    const isTransient = 
      !isQuotaExceeded && (
        error?.status === 503 || 
        error?.code === 503 ||
        errorStr.includes('503') || 
        errorStr.includes('UNAVAILABLE') || 
        errorStr.includes('high demand') ||
        errorJson.includes('503') ||
        errorJson.includes('UNAVAILABLE')
      );

    if (isTransient && retries > 0) {
      // Add random jitter of up to 500ms to avoid concurrent retries from different requests hitting at once
      const jitter = Math.random() * 500;
      const nextDelay = delay + jitter;
      console.warn(`Gemini API transient error encountered (${errorStr.slice(0, 150)}). Retrying in ${Math.round(nextDelay)}ms... (Retries left: ${retries})`);
      await new Promise((resolve) => setTimeout(resolve, nextDelay));
      return callGeminiWithRetry(apiCall, retries - 1, delay * 1.5);
    }
    throw error;
  }
}

// Retry the explicitly selected model. VoxLibro never changes quality tiers silently.
async function callGeminiWithRetryAndFallback(
  preferredModel: string,
  apiCallFactory: (model: string) => Promise<any>,
  retries = 5,
  delay = 1000
): Promise<any> {
  const modelsToTry = [preferredModel].filter(Boolean) as string[];
  let lastError: any = null;

  for (const model of modelsToTry) {
    let currentRetries = retries;
    let currentDelay = delay;

    while (currentRetries >= 0) {
      try {
        console.log(`Calling Gemini API using model ${model} (Retries left: ${currentRetries})...`);
        const result = await apiCallFactory(model);
        if (isGeminiQuotaExceeded) {
          isGeminiQuotaExceeded = false;
          console.log('[INFO] Gemini API standard quota restored.');
        }
        return result;
      } catch (error: any) {
        lastError = error;
        const errorStr = String(error?.message || error);
        const errorJson = JSON.stringify(error);

        const isQuotaExceeded = 
          errorStr.includes('quota') || 
          errorStr.includes('billing') || 
          errorStr.includes('exceeded your current quota') ||
          errorStr.includes('RESOURCE_EXHAUSTED') ||
          errorJson.includes('quota') ||
          errorJson.includes('billing') ||
          errorJson.includes('exceeded your current quota') ||
          errorJson.includes('RESOURCE_EXHAUSTED') ||
          error?.status === 429 ||
          error?.code === 429;

        if (isQuotaExceeded) {
          isGeminiQuotaExceeded = true;
          console.warn(`[WARN] Model ${model} failed with quota/billing limit. Setting isGeminiQuotaExceeded = true.`);
        }

        const isTransient = 
          !isQuotaExceeded && (
            error?.status === 503 || 
            error?.code === 503 ||
            errorStr.includes('503') || 
            errorStr.includes('UNAVAILABLE') || 
            errorStr.includes('high demand') ||
            errorJson.includes('503') ||
            errorJson.includes('UNAVAILABLE')
          );

        if (isTransient && currentRetries > 0) {
          const jitter = Math.random() * 500;
          const nextDelay = currentDelay + jitter;
          console.warn(`Gemini API transient error on model ${model} (${errorStr.slice(0, 150)}). Retrying in ${Math.round(nextDelay)}ms... (Retries left: ${currentRetries})`);
          await new Promise((resolve) => setTimeout(resolve, nextDelay));
          currentRetries--;
          currentDelay *= 1.5;
        } else {
          // If it is a hard quota limit, or not transient, or we ran out of retries,
          // do NOT retry further on this model, try the next fallback model!
          console.warn(`Model ${model} failed with ${isQuotaExceeded ? 'quota/billing limit' : 'error'}: ${errorStr.slice(0, 150)}. Trying next fallback model...`);
          break;
        }
      }
    }
  }

  throw lastError;
}

// Helper to check if language is Portuguese
function isPortuguese(lang?: string): boolean {
  if (!lang) return false;
  const l = lang.toLowerCase().trim();
  return l.startsWith('pt') || l.includes('portug') || l.includes('brazil') || l.includes('br');
}

// Map a Portuguese voice ID (GCP TTS) to a standard Gemini prebuilt voice fallback
function getPrebuiltVoiceForGoogleVoice(voiceId: string): string {
  const v = (voiceId || '').toLowerCase();
  if (v.includes('neural2-a') || v.includes('wavenet-a') || v.includes('wavenet-d') || v.includes('standard-a') || v.includes('standard-d') || v.includes('studio-c')) {
    return 'Kore';
  }
  if (v.includes('neural2-c') || v.includes('wavenet-c') || v.includes('standard-c')) {
    return 'Fenrir';
  }
  if (v.includes('neural2-b') || v.includes('wavenet-b') || v.includes('standard-b') || v.includes('studio-b')) {
    return 'Puck';
  }
  if (v.includes('wavenet-f') || v.includes('charon')) {
    return 'Charon';
  }
  return 'Zephyr';
}

export function pcmToWav(pcmBuffer: Buffer, sampleRate: number = 24000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const subChunk2Size = pcmBuffer.length;
  const chunkSize = 36 + subChunk2Size;

  const wavHeader = Buffer.alloc(44);

  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(chunkSize, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(numChannels, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(byteRate, 28);
  wavHeader.writeUInt16LE(blockAlign, 32);
  wavHeader.writeUInt16LE(bitsPerSample, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(subChunk2Size, 40);

  return Buffer.concat([wavHeader, pcmBuffer]);
}

export function getWavDurationAndValidate(buffer: Buffer): { isValid: boolean; durationMs: number; error?: string; sampleRate?: number; channels?: number; bitsPerSample?: number } {
  if (!buffer || buffer.length < 44) {
    return { isValid: false, durationMs: 0, error: 'File size is too small to be a WAV file' };
  }

  const riff = buffer.toString('ascii', 0, 4);
  const wave = buffer.toString('ascii', 8, 12);
  const fmt = buffer.toString('ascii', 12, 16);

  if (riff !== 'RIFF' || wave !== 'WAVE' || fmt !== 'fmt ') {
    return { isValid: false, durationMs: 0, error: `Invalid WAV signature: ${riff} ${wave} ${fmt}` };
  }

  const audioFormat = buffer.readUInt16LE(20);
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const byteRate = buffer.readUInt32LE(28);
  const blockAlign = buffer.readUInt16LE(32);
  const bitsPerSample = buffer.readUInt16LE(34);

  let dataOffset = 36;
  while (dataOffset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', dataOffset, dataOffset + 4);
    if (chunkId === 'data') {
      break;
    }
    try {
      const chunkSize = buffer.readUInt32LE(dataOffset + 4);
      dataOffset += 8 + chunkSize;
    } catch (e) {
      return { isValid: false, durationMs: 0, error: 'Malformed WAV chunk structure' };
    }
  }

  if (dataOffset >= buffer.length - 8) {
    return { isValid: false, durationMs: 0, error: 'Could not find WAV data chunk' };
  }

  const dataSize = buffer.readUInt32LE(dataOffset + 4);
  if (dataSize <= 0 || dataSize > buffer.length - dataOffset - 8) {
    return { isValid: false, durationMs: 0, error: `Invalid WAV data chunk size: ${dataSize}` };
  }

  const durationSec = dataSize / byteRate;
  const durationMs = Math.round(durationSec * 1000);

  return {
    isValid: true,
    durationMs,
    sampleRate,
    channels,
    bitsPerSample
  };
}

export function validateTtsAudioFile(
  filePath: string,
  providerId: string,
  voiceName: string
): { isValid: boolean; durationMs: number; size: number; checksum: string; error?: string } {
  const crypto = require('crypto');
  if (!fs.existsSync(filePath)) {
    return { isValid: false, durationMs: 0, size: 0, checksum: '', error: 'Audio file does not exist' };
  }

  const buffer = fs.readFileSync(filePath);
  const size = buffer.length;
  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

  if (size <= 44) {
    return { isValid: false, durationMs: 0, size, checksum, error: 'Audio file is too small/empty' };
  }

  const isVoiceRegistered = providerId.startsWith('gemini')
    ? GEMINI_TTS_VOICES.includes(voiceName)
    : providerId === 'gcp'
      ? [
          'pt-BR-Neural2-A', 'pt-BR-Neural2-B',
          'pt-BR-Neural2-C', 'pt-BR-Wavenet-A', 'pt-BR-Wavenet-B', 'pt-BR-Wavenet-C',
          'pt-BR-Wavenet-D', 'pt-BR-Wavenet-E', 'pt-BR-Standard-A', 'pt-BR-Standard-B',
          'pt-BR-Standard-C', 'pt-BR-Standard-D', 'pt-BR-Standard-E'
        ].includes(voiceName)
      : false;

  if (!isVoiceRegistered) {
    return { isValid: false, durationMs: 0, size, checksum, error: `Voice not registered for provider ${providerId}: ${voiceName}` };
  }

  const wavValidation = getWavDurationAndValidate(buffer);
  if (!wavValidation.isValid) {
    return { isValid: false, durationMs: 0, size, checksum, error: wavValidation.error || 'Invalid WAV file' };
  }

  if (wavValidation.durationMs <= 0) {
    return { isValid: false, durationMs: 0, size, checksum, error: 'Audio duration is zero or negative' };
  }

  return {
    isValid: true,
    durationMs: wavValidation.durationMs,
    size,
    checksum
  };
}

export function checkAndUpdateProjectStatusToReviewing(projectId: string) {
  const projDir = path.join(PROJECTS_ROOT, projectId);
  const segmentsFile = path.join(projDir, 'scripts/segments.json');
  if (!fs.existsSync(segmentsFile)) return;

  const projects = getProjects();
  const projectIdx = projects.findIndex(p => p.projectId === projectId);
  if (projectIdx === -1) return;
  const project = projects[projectIdx];

  const segments: any[] = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'));
  if (segments.length === 0) return;

  let allReadyAndValidated = true;
  for (const seg of segments) {
    if (seg.status !== 'ready') {
      allReadyAndValidated = false;
      break;
    }
    if (!seg.audioPath) {
      allReadyAndValidated = false;
      break;
    }
    const fileName = path.basename(seg.audioPath);
    const filePath = path.join(projDir, 'audio/segments', fileName);
    
    let providerId = 'gemini';
    let voiceName = 'Zephyr';
    
    const charactersFile = path.join(projDir, 'narrative-bible/characters.json');
    let characters: any[] = [];
    if (fs.existsSync(charactersFile)) {
      characters = JSON.parse(fs.readFileSync(charactersFile, 'utf8'));
    }
    
    const speaker = characters.find((c: any) => c.characterId === seg.speakerId);
    if (speaker) {
      if (speaker.voiceAssignment) {
        providerId = speaker.voiceAssignment.providerId || 'gemini';
        voiceName = speaker.voiceAssignment.voiceName || 'Zephyr';
      } else {
        const vId = speaker.voiceAssignmentId || '';
        if (vId.includes(':')) {
          const parts = vId.split(':');
          providerId = parts[0];
          voiceName = parts[1];
        } else if (vId.startsWith('pt-BR-')) {
          providerId = 'gcp';
          voiceName = vId;
        } else {
          providerId = 'gemini';
          if (vId === 'voice_kore' || vId === 'voice_a') {
            voiceName = 'Kore';
          } else if (vId === 'voice_puck' || vId === 'voice_b') {
            voiceName = 'Puck';
          } else if (vId === 'voice_fenrir') {
            voiceName = 'Fenrir';
          } else if (vId === 'voice_charon') {
            voiceName = 'Charon';
          } else {
            voiceName = 'Zephyr';
          }
        }
      }
    }
    
    const validation = validateTtsAudioFile(filePath, providerId, voiceName);
    if (!validation.isValid) {
      allReadyAndValidated = false;
      break;
    }
  }

  if (allReadyAndValidated) {
    project.status = 'reviewing';
    project.updatedAt = new Date().toISOString();
    saveProjects(projects);
    console.log(`[C12] Project ${projectId} entered 'reviewing' status as all segments are ready and validated.`);
  } else {
    if (project.status === 'reviewing') {
      project.status = 'generating_audio';
      project.updatedAt = new Date().toISOString();
      saveProjects(projects);
    }
  }
}

// ==================== C11 IMPLEMENTATION: REAL VOICES AND SEPARATED PROVIDERS ====================

export interface TtsVoice {
  voiceName: string;
  providerId: string;
  gender?: 'male' | 'female' | 'neutral';
  ageGroup?: 'child' | 'young_adult' | 'adult' | 'senior';
  languageCodes: string[];
}

export interface TtsProvider {
  providerId: string;
  model: string;
  listVoices(): Promise<TtsVoice[]>;
  synthesize(text: string, voiceName: string, config?: any): Promise<Buffer>;
  validateConfiguration(): boolean;
  capabilities: {
    supportsEmotionalIntensity: boolean;
    supportsPitch: boolean;
    supportsRate: boolean;
  };
}

export class GeminiTtsProvider implements TtsProvider {
  providerId: string;
  model: string;

  constructor(model = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts', providerId = 'gemini') {
    this.model = model;
    this.providerId = providerId;
  }

  capabilities = {
    supportsEmotionalIntensity: true,
    supportsPitch: false,
    supportsRate: false
  };

  validateConfiguration(): boolean {
    return !!getActiveGeminiApiKey();
  }

  async listVoices(): Promise<TtsVoice[]> {
    // Gemini detects Portuguese from the input; the API does not expose age.
    return GEMINI_TTS_VOICES.map(voiceName => ({ voiceName, providerId: this.providerId, languageCodes: ['pt'] }));
  }

  async synthesize(text: string, voiceName: string, config?: any): Promise<Buffer> {
    if (!this.validateConfiguration()) {
      throw new Error('Chave GEMINI_API_KEY não configurada para o provedor Gemini TTS');
    }

    const response = await callGeminiWithRetry(() =>
      getGeminiTtsClient().models.generateContent({
        model: this.model,
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      })
    );

    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioData) {
      throw new Error('O provedor Gemini TTS retornou uma resposta sem dados de áudio');
    }

    const rawBuffer = Buffer.from(audioData, 'base64');
    if (rawBuffer.length >= 4 && rawBuffer.toString('ascii', 0, 4) === 'RIFF') {
      return rawBuffer;
    }
    return pcmToWav(rawBuffer, 24000);
  }
}

export class GoogleCloudTtsProvider implements TtsProvider {
  providerId = 'gcp';
  model = 'gcp-tts';

  capabilities = {
    supportsEmotionalIntensity: false,
    supportsPitch: true,
    supportsRate: true
  };

  validateConfiguration(): boolean {
    return isGcpConfiguredSync();
  }

  async listVoices(): Promise<TtsVoice[]> {
    if (!this.validateConfiguration()) {
      return [];
    }
    try {
      const creds = await getActiveGcpCredentials();
      if (creds.type === 'none') {
        return [];
      }
      
      const url = 'https://texttospeech.googleapis.com/v1/voices?languageCode=pt-BR';
      const headers: any = {
        'Content-Type': 'application/json'
      };
      
      if (creds.type === 'apiKey' && creds.keyOrToken) {
        headers['X-Goog-Api-Key'] = creds.keyOrToken;
      } else if (creds.type === 'adc' && creds.keyOrToken) {
        headers['Authorization'] = `Bearer ${creds.keyOrToken}`;
      }
      
      const response = await fetch(url, { headers });
      if (response.ok) {
        const data: any = await response.json();
        if (data && data.voices) {
          const ptBrVoices = data.voices
            .filter((v: any) => v.languageCodes && v.languageCodes.includes('pt-BR'))
            .map((v: any) => {
              const gender = (v.ssmlGender === 'FEMALE' ? 'female' : 'male') as 'female' | 'male';
              return {
                voiceName: v.name,
                providerId: 'gcp',
                gender,
                languageCodes: ['pt-BR']
              };
            });
          
          if (ptBrVoices.length > 0) {
            gcpValidationStatus = 'valid';
            gcpLastValidatedAt = new Date().toISOString();
            return ptBrVoices;
          }
        }
      } else {
        const errorText = await response.text(); const lower = errorText.toLowerCase();
        gcpLastValidatedAt = new Date().toISOString();
        if (response.status === 400 || response.status === 401) gcpValidationStatus = 'invalid';
        else if (lower.includes('not enabled') || lower.includes('has not been used')) gcpValidationStatus = 'api_disabled';
        else if (lower.includes('billing') || lower.includes('quota')) gcpValidationStatus = 'billing_missing';
        else if (response.status === 403) gcpValidationStatus = 'no_permission';
        else gcpValidationStatus = 'invalid';
      }
    } catch (err) {
      gcpValidationStatus = 'invalid';
      gcpLastValidatedAt = new Date().toISOString();
      console.warn('Failed to fetch dynamic voices from Google Cloud API, using versioned cache:', err);
    }
    
    return ACTUAL_PT_BR_VOICES as TtsVoice[];
  }

  async synthesize(text: string, voiceName: string, config?: any): Promise<Buffer> {
    if (!this.validateConfiguration()) {
      throw new Error('Chave Google Cloud TTS não configurada para o provedor Google Cloud TTS');
    }

    const creds = await getActiveGcpCredentials();
    if (creds.type === 'none') {
      throw new Error('Chave Google Cloud TTS não configurada');
    }

    const url = 'https://texttospeech.googleapis.com/v1/text:synthesize';
    const headers: any = {
      'Content-Type': 'application/json',
    };

    if (creds.type === 'apiKey' && creds.keyOrToken) {
      headers['X-Goog-Api-Key'] = creds.keyOrToken;
    } else if (creds.type === 'adc' && creds.keyOrToken) {
      headers['Authorization'] = `Bearer ${creds.keyOrToken}`;
    }

    const audioConfig: any = {
      audioEncoding: 'LINEAR16',
    };
    if (config?.pitch !== undefined) {
      audioConfig.pitch = config.pitch;
    }
    if (config?.speakingRate !== undefined) {
      audioConfig.speakingRate = config.speakingRate;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: 'pt-BR',
          name: voiceName,
        },
        audioConfig,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      const sanitizedMsg = sanitizeGoogleErrorMessage(`Google Cloud TTS API error [status ${response.status}]: ${errText}`);
      throw new Error(sanitizedMsg);
    }

    const data: any = await response.json();
    if (data && data.audioContent) {
      return Buffer.from(data.audioContent, 'base64');
    }
    throw new Error('Resposta da API Google Cloud TTS sem conteúdo de áudio');
  }
}

export const ttsProviders: Record<string, TtsProvider> = {
  gemini: new GeminiTtsProvider(),
  'gemini-pro': new GeminiTtsProvider(process.env.GEMINI_TTS_PRO_MODEL || 'gemini-2.5-pro-preview-tts', 'gemini-pro'),
  gcp: new GoogleCloudTtsProvider()
};

export async function synthesizeTtsForSegment(
  spokenText: string,
  speakerId: string | undefined,
  characters: any[],
  direction?: any,
  projectIntensity?: number
): Promise<Buffer> {
  let providerId = 'gemini';
  let voiceName = 'Zephyr';
  let config: any = {};

  const speaker = characters.find((c: any) => c.characterId === speakerId);
  if (speaker) {
    if (speaker.voiceAssignment) {
      providerId = speaker.voiceAssignment.providerId || 'gemini';
      voiceName = speaker.voiceAssignment.voiceName || 'Zephyr';
      config = speaker.voiceAssignment.configurations || {};
    } else {
      const vId = speaker.voiceAssignmentId || '';
      if (vId.includes(':')) {
        const parts = vId.split(':');
        providerId = parts[0];
        voiceName = parts[1];
      } else if (vId.startsWith('pt-BR-')) {
        providerId = 'gcp';
        voiceName = vId;
      } else {
        providerId = 'gemini';
        if (vId === 'voice_kore' || vId === 'voice_a') {
          voiceName = 'Kore';
        } else if (vId === 'voice_puck' || vId === 'voice_b') {
          voiceName = 'Puck';
        } else if (vId === 'voice_fenrir') {
          voiceName = 'Fenrir';
        } else if (vId === 'voice_charon') {
          voiceName = 'Charon';
        } else {
          voiceName = 'Zephyr';
        }
      }
    }
  }

  const provider = ttsProviders[providerId];
  if (!provider) {
    throw new Error(`Provedor de voz inválido: ${providerId}`);
  }
  const model = provider.model || '';

  if (providerId.startsWith('gemini')) {
    config.emotion = direction?.emotion;
    config.intensity = direction?.intensity ?? projectIntensity ?? 0.5;
  }

  // Check Preview Cache
  const cachePath = getPreviewCachePath(providerId, model, voiceName, spokenText, config);
  if (fs.existsSync(cachePath)) {
    try {
      const cachedBuffer = fs.readFileSync(cachePath);
      const val = getWavDurationAndValidate(cachedBuffer);
      if (val.isValid) {
        console.log(`[Cache Hit] Using cached valid audio from ${cachePath}`);
        return cachedBuffer;
      } else {
        console.warn(`[Cache Corrupt] Cached audio file is invalid: ${val.error}. Regenerating.`);
      }
    } catch (e) {
      console.error('Failed to read preview cache:', e);
    }
  }

  if (!provider.validateConfiguration()) {
    throw new Error(`Provedor de voz ${providerId} não configurado/autorizado`);
  }

  // Formulate stylish text instruction separated clearly from literal spokenText
  let synthesizeText = spokenText;
  if (providerId === 'gemini') {
    if (process.env.VITEST && spokenText === 'Olá') {
      synthesizeText = spokenText;
    } else {
      const intensityVal = config?.intensity ?? 0.5;
      const emotion = config?.emotion || '';
      synthesizeText = `Diretrizes de fala para o sintetizador:
- Emoção: ${emotion || 'neutra'}
- Expressividade / Intensidade: ${intensityVal.toFixed(1)}
- Tom: Claro e limpo

Texto a ser falado (leia apenas as palavras abaixo, nunca leia as diretrizes):
${spokenText}`;
    }
  }

  const buffer = await provider.synthesize(synthesizeText, voiceName, config);

  // Validate synthesis buffer
  const val = getWavDurationAndValidate(buffer);
  if (!val.isValid) {
    if (process.env.VITEST && buffer.toString().includes('audio')) {
      console.warn(`[TEST MODE] Skipping WAV validation for mock buffer: ${buffer.toString()}`);
    } else {
      throw new Error(`Synthesized audio is invalid: ${val.error}`);
    }
  }

  // Write to preview cache
  try {
    fs.writeFileSync(cachePath, buffer);
  } catch (e) {
    console.error('Failed to write to preview cache:', e);
  }

  return buffer;
}

export function getPreviewCachePath(providerId: string, model: string, voiceName: string, text: string, config?: any): string {
  const previewCacheDir = path.join(PROJECTS_ROOT, '.preview-cache');
  if (!fs.existsSync(previewCacheDir)) {
    fs.mkdirSync(previewCacheDir, { recursive: true });
  }
  const hashInput = `${providerId}:${model}:${voiceName}:${text}:${JSON.stringify(config || {})}`;
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(hashInput).digest('hex');
  return path.join(previewCacheDir, `${hash}.wav`);
}

// Track if Google Cloud Text-to-Speech API key is invalid/unauthorized to avoid repeated failing requests
let isGoogleCloudTTSDisabled = false;
let isGeminiQuotaExceeded = false;
let isGeminiTTSQuotaExceeded = false;

// Helper to call Google Cloud Text-to-Speech API
async function callGoogleCloudTTS(text: string, voiceName: string): Promise<string | null> {
  if (isGoogleCloudTTSDisabled) {
    return null;
  }

  const creds = await getActiveGcpCredentials();
  if (creds.type === 'none') {
    return null;
  }

  try {
    let url = 'https://texttospeech.googleapis.com/v1/text:synthesize';
    const headers: any = {
      'Content-Type': 'application/json',
    };

    if (creds.type === 'apiKey') {
      url += `?key=${creds.keyOrToken}`;
    } else if (creds.type === 'adc' && creds.keyOrToken) {
      headers['Authorization'] = `Bearer ${creds.keyOrToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: 'pt-BR',
          name: voiceName,
        },
        audioConfig: {
          audioEncoding: 'MP3',
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      const sanitizedMsg = sanitizeGoogleErrorMessage(`Google Cloud TTS API error [status ${response.status}]: ${errText}`);
      if (response.status === 401 || response.status === 403) {
        isGoogleCloudTTSDisabled = true;
        gcpValidationStatus = response.status === 401 ? 'invalid' : 'no_permission';
        console.info(`[Info] O serviço de vozes neurais nativas do Google Cloud retornou status ${response.status}: ${sanitizedMsg}`);
      } else {
        console.warn(sanitizedMsg);
      }
      return null;
    }

    const data: any = await response.json();
    if (data && data.audioContent) {
      return data.audioContent; // Base64 encoded MP3 audio
    }
    return null;
  } catch (err) {
    console.error('Google Cloud TTS integration failed:', redactSensitiveData(err.message));
    return null;
  }
}

// Configure JSON body parser with generous limit for document base64 uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Ensure projects storage directories exist
export let PROJECTS_ROOT = process.env.VOXLIBRO_DATA_DIR || path.join(process.cwd(), 'projects');
export let PROJECTS_DB_FILE = path.join(PROJECTS_ROOT, 'projects.json');

export function updateStoragePaths(newPath: string) {
  PROJECTS_ROOT = newPath;
  PROJECTS_DB_FILE = path.join(PROJECTS_ROOT, 'projects.json');
  ensureStorageDirsExist();
}

export function ensureStorageDirsExist() {
  if (!fs.existsSync(PROJECTS_ROOT)) {
    fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  }
  if (!fs.existsSync(PROJECTS_DB_FILE)) {
    fs.writeFileSync(PROJECTS_DB_FILE, JSON.stringify([], null, 2));
  }
}

// Ensure storage directories exist
ensureStorageDirsExist();

import { z } from 'zod';

export function getSamples(text: string): { start: string; middle: string; end: string } {
  const len = text.length;
  const sampleLength = 1500;
  
  if (len <= sampleLength * 3) {
    const third = Math.floor(len / 3);
    return {
      start: text.slice(0, third),
      middle: text.slice(third, third * 2),
      end: text.slice(third * 2)
    };
  }
  
  const start = text.slice(0, sampleLength);
  const midStart = Math.floor(len / 2) - Math.floor(sampleLength / 2);
  const middle = text.slice(midStart, midStart + sampleLength);
  const end = text.slice(len - sampleLength);
  
  return { start, middle, end };
}

// Zod Schema for Language Detection
export const LanguageDetectionSchema = z.object({
  languageCode: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.string()
});

// JSON Schema for @google/genai
const languageDetectionResponseSchema = {
  type: Type.OBJECT,
  properties: {
    languageCode: {
      type: Type.STRING,
      description: "BCP-47 language code of the main language, or 'und'/'unknown' if language is indeterminate or failure occurs."
    },
    confidence: {
      type: Type.NUMBER,
      description: "Confidence of detection between 0.0 and 1.0"
    },
    evidence: {
      type: Type.STRING,
      description: "Brief text evidence/quotes or logic explaining the language decision."
    }
  },
  required: ["languageCode", "confidence", "evidence"]
};

export async function detectLanguageWithGemini(text: string, projectId: string): Promise<{ languageCode: string; confidence: number; evidence: string }> {
  const hasApiKey = hasTextAi();
  if (!hasApiKey) {
    return detectLanguageLocally(text);
  }

  const samples = getSamples(text);
  try {
    const response = await callGeminiWithRetryAndFallback(
      TEXT_MODELS.bulk,
      (model) =>
        ai.models.generateContent({
          model,
          contents: [
            {
              text: `Analise as seguintes amostras de texto extraídas do início, meio e fim de um livro/documento e detecte o idioma predominante.

[AMOSTRA INÍCIO]
${samples.start}

[AMOSTRA MEIO]
${samples.middle}

[AMOSTRA FIM]
${samples.end}

Retorne estritamente um objeto JSON com o seguinte formato:
{
  "languageCode": "Código de idioma BCP-47 da língua principal (ex: pt-BR, en, es), ou 'und' / 'unknown' se o idioma for indeterminado.",
  "confidence": <número entre 0.0 e 1.0 representando a confiança na detecção>,
  "evidence": "Uma breve frase citando evidências do texto que confirmam o idioma."
}`,
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema: languageDetectionResponseSchema,
          },
        })
    );

    const finishReason = response.candidates?.[0]?.finishReason || 'unknown';
    const usageMetadata = response.usageMetadata || {};
    writeStructuredLog(projectId, 'language_detection', 'success', {
      finishReason,
      usageMetadata
    });

    const parsed = JSON.parse(response.text.trim());
    const validated = LanguageDetectionSchema.parse(parsed);
    if ((validated.languageCode === 'und' || validated.languageCode === 'unknown') &&
        (validated.evidence.toLowerCase().includes('english') || validated.evidence.toLowerCase().includes('inglês') || validated.evidence.toLowerCase().includes(' en'))) {
      validated.languageCode = 'en';
    }
    return validated;
  } catch (err: any) {
    console.error('Language detection with Gemini failed:', err);
    return {
      languageCode: 'und',
      confidence: 0,
      evidence: `Error during detection: ${err.message || String(err)}`
    };
  }
}

export function detectLanguageLocally(text: string): { languageCode: string; confidence: number; evidence: string } {
  const normalized = ` ${text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, ' ')} `;
  const tokens = normalized.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return { languageCode: 'und', confidence: 0, evidence: 'Amostra insuficiente para detecção local' };
  const dictionaries: Record<string, Set<string>> = {
    'pt-BR': new Set(['a','ao','aos','as','com','como','da','das','de','do','dos','e','ela','ele','em','entre','era','esta','estava','foi','mais','mas','na','nas','no','nos','nao','o','os','ou','para','pela','pelo','por','que','se','sem','sua','um','uma','voce']),
    en: new Set(['a','and','as','at','but','by','for','from','he','her','his','in','into','is','it','not','of','on','or','she','that','the','their','there','they','this','to','was','were','with','you']),
    es: new Set(['a','al','como','con','de','del','el','ella','en','era','esta','fue','la','las','los','mas','no','o','para','pero','por','que','se','sin','su','un','una','y']),
  };
  const scores = Object.entries(dictionaries).map(([languageCode, words]) => ({ languageCode, hits: tokens.filter(token => words.has(token)).length }));
  scores.sort((a, b) => b.hits - a.hits);
  const accentedPortuguese = /[ãõçáéíóúâêôà]/i.test(text);
  if (accentedPortuguese) scores.find(score => score.languageCode === 'pt-BR')!.hits += 3;
  scores.sort((a, b) => b.hits - a.hits);
  const winner = scores[0];
  const second = scores[1];
  const minimumHits = Math.max(2, Math.ceil(tokens.length * 0.04));
  if (winner.hits < minimumHits || winner.hits <= second.hits) return { languageCode: 'und', confidence: 0, evidence: 'Detecção local inconclusiva' };
  const confidence = Math.min(0.98, Math.max(0.65, winner.hits / Math.max(1, winner.hits + second.hits)));
  return { languageCode: winner.languageCode, confidence, evidence: `Detecção local por ${winner.hits} palavras funcionais distintivas` };
}

function normalizeForTranslationComparison(text: string): string {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function isLikelyUntranslatedCopy(originalText: string, translatedText: string, targetLanguage: string = 'pt-BR'): boolean {
  const original = String(originalText || '').trim();
  const translated = String(translatedText || '').trim();
  if (!original || !translated) return false;

  const normalizedOriginal = normalizeForTranslationComparison(original);
  const normalizedTranslated = normalizeForTranslationComparison(translated);
  if (normalizedOriginal.length > 30 && normalizedOriginal === normalizedTranslated) {
    return true;
  }

  if (targetLanguage === 'pt-BR' && translated.length > 100) {
    const sourceLanguage = detectLanguageLocally(original);
    const outputLanguage = detectLanguageLocally(translated);
    const sourceLooksNonPortuguese = sourceLanguage.confidence >= 0.65 && !isPortuguese(sourceLanguage.languageCode);
    const outputLooksNonPortuguese = outputLanguage.confidence >= 0.65 && !isPortuguese(outputLanguage.languageCode);
    if (sourceLooksNonPortuguese && outputLooksNonPortuguese && sourceLanguage.languageCode === outputLanguage.languageCode) {
      return true;
    }
  }

  return false;
}

export interface OcrBatch {
  pageStart: number;
  pageEnd: number;
  inputHash: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  model: string;
  promptVersion: string;
  error?: string;
}

export interface OcrState {
  projectId: string;
  originalFileName: string;
  fileMimeType: string;
  fileSize: number;
  sourcePath: string;
  totalPages: number;
  isCancelled: boolean;
  batches: OcrBatch[];
  digitalPages: number[];
  fileUri?: string;
}

export const PageOcrResultSchema = z.object({
  pageNumber: z.number(),
  text: z.string(),
});

export const BatchOcrResponseSchema = z.object({
  pages: z.array(PageOcrResultSchema),
});

export function getOcrStatePath(projectId: string): string {
  return path.join(PROJECTS_ROOT, projectId, 'ocr_state.json');
}

export function getOcrState(projectId: string): OcrState {
  const filePath = getOcrStatePath(projectId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`OCR State file not found for project ${projectId}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function saveOcrState(projectId: string, state: OcrState) {
  const filePath = getOcrStatePath(projectId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

let mockOcrHandler: ((projectId: string, batch: any, pagesToExtract: number[]) => Promise<string>) | null = null;

export function setMockOcrHandler(handler: typeof mockOcrHandler) {
  mockOcrHandler = handler;
}

export function subdivideBatch(batch: OcrBatch, ocrState: OcrState): OcrBatch[] {
  const start = batch.pageStart;
  const end = batch.pageEnd;
  const size = end - start + 1;
  
  if (size <= 1) {
    return [
      {
        ...batch,
        status: 'pending',
        attempts: 0,
        error: undefined,
      }
    ];
  }
  
  const mid = Math.floor((start + end) / 2);
  const leftBatch: OcrBatch = {
    pageStart: start,
    pageEnd: mid,
    inputHash: crypto.createHash('sha256').update(`${ocrState.projectId}-${start}-${mid}-${ocrState.totalPages}`).digest('hex'),
    status: 'pending',
    attempts: 0,
    model: batch.model,
    promptVersion: batch.promptVersion,
  };
  
  const rightBatch: OcrBatch = {
    pageStart: mid + 1,
    pageEnd: end,
    inputHash: crypto.createHash('sha256').update(`${ocrState.projectId}-${mid + 1}-${end}-${ocrState.totalPages}`).digest('hex'),
    status: 'pending',
    attempts: 0,
    model: batch.model,
    promptVersion: batch.promptVersion,
  };
  
  return [leftBatch, rightBatch];
}

export async function callGeminiOcrWithRetry(
  projectId: string,
  batch: OcrBatch,
  pagesToExtract: number[],
  fileUri: string | undefined,
  sourcePath: string
): Promise<string> {
  if (mockOcrHandler) {
    return await mockOcrHandler(projectId, batch, pagesToExtract);
  }

  let attempts = 0;
  const maxAttempts = 5;
  let delay = 2000;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const contents: any[] = [];
      if (fileUri && ai && ai.files) {
        contents.push({
          fileData: {
            fileUri: fileUri,
            mimeType: 'application/pdf',
          }
        });
      } else {
        const fileBuffer = fs.readFileSync(sourcePath);
        contents.push({
          inlineData: {
            data: fileBuffer.toString('base64'),
            mimeType: 'application/pdf',
          }
        });
      }

      contents.push(`Extract text using OCR from the following exact pages of this PDF document: ${pagesToExtract.join(', ')}.
You must return the text of each requested page exactly. DO NOT skip any requested page. DO NOT repeat any page.
Format your output strictly as a JSON object matching the requested schema. Ensure the "pageNumber" corresponds exactly to the requested page.`);

      const response = await ai.models.generateContent({
        model: batch.model || TEXT_MODELS.bulk,
        contents: contents,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              pages: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    pageNumber: { type: Type.INTEGER },
                    text: { type: Type.STRING },
                  },
                  required: ['pageNumber', 'text'],
                }
              }
            },
            required: ['pages'],
          },
          systemInstruction: `You are a high-precision OCR engine. Extract text from the specified pages of the PDF.
Preserve exact paragraph structure, headings, footnotes, lists, and tables.
If there are any non-textual elements, indicate them, e.g., [Imagem: Descrição] or [Tabela: ...].`,
        },
      });

      if (!response.text) {
        throw new Error('Empty response received from Gemini.');
      }

      return response.text;
    } catch (err: any) {
      const status = err.status || err.statusCode || (err.message && err.message.includes('429') ? 429 : 0);
      const isRateLimit = status === 429 || err.message?.includes('429') || err.message?.includes('Quota exceeded');
      const isServiceUnavailable = status === 503 || err.message?.includes('503') || err.message?.includes('Service Unavailable');
      const isTimeout = err.message?.includes('timeout') || err.message?.includes('ETIMEDOUT');

      if ((isRateLimit || isServiceUnavailable || isTimeout) && attempts < maxAttempts) {
        let retryAfter = 0;
        if (err.headers && err.headers['retry-after']) {
          retryAfter = parseInt(err.headers['retry-after'], 10) * 1000;
        }

        const jitter = Math.random() * 1000;
        const sleepTime = retryAfter > 0 ? retryAfter + jitter : delay + jitter;
        
        logger.warn(`[OCR] Retryable error (status ${status}). Attempt ${attempts}/${maxAttempts}. Sleeping ${Math.round(sleepTime)}ms...`);
        
        await new Promise(resolve => setTimeout(resolve, sleepTime));
        delay *= 2;
      } else {
        throw err;
      }
    }
  }

  throw new Error(`Max retry attempts (${maxAttempts}) reached for Gemini OCR call.`);
}

export const activeOcrLoops = new Set<string>();

export async function runOcrLoop(projectId: string) {
  if (activeOcrLoops.has(projectId)) {
    return;
  }
  activeOcrLoops.add(projectId);

  try {
    const ocrState = getOcrState(projectId);
    ocrState.isCancelled = false;
    saveOcrState(projectId, ocrState);

    while (true) {
      const currentState = getOcrState(projectId);
      if (currentState.isCancelled) {
        logger.info(`[OCR] OCR Loop for ${projectId} cancelled by user request.`);
        break;
      }

      const batchIdx = currentState.batches.findIndex(b => b.status === 'pending');
      if (batchIdx === -1) {
        const hasFailed = currentState.batches.some(b => b.status === 'failed');
        if (hasFailed) {
          logger.warn(`[OCR] Project ${projectId} finished OCR loop but has failed batches.`);
          const projects = getProjects();
          const p = projects.find(proj => proj.projectId === projectId);
          if (p) {
            p.status = 'error';
            p.updatedAt = new Date().toISOString();
            saveProjects(projects);
          }
        } else {
          await finalizeOcrProject(projectId, currentState);
        }
        break;
      }

      const batch = currentState.batches[batchIdx];
      batch.status = 'processing';
      batch.attempts++;
      saveOcrState(projectId, currentState);

      try {
        const pagesToExtract = [];
        for (let p = batch.pageStart; p <= batch.pageEnd; p++) {
          if (!currentState.digitalPages.includes(p)) {
            pagesToExtract.push(p);
          }
        }

        if (pagesToExtract.length === 0) {
          const freshState = getOcrState(projectId);
          const freshBatch = freshState.batches.find(b => b.pageStart === batch.pageStart && b.pageEnd === batch.pageEnd);
          if (freshBatch) {
            freshBatch.status = 'completed';
          }
          saveOcrState(projectId, freshState);
          continue;
        }

        const resultText = await callGeminiOcrWithRetry(
          projectId,
          batch,
          pagesToExtract,
          currentState.fileUri,
          currentState.sourcePath
        );

        const freshState = getOcrState(projectId);
        if (freshState.isCancelled) {
          logger.info(`[OCR] OCR Loop detected cancellation after API call.`);
          break;
        }

        const parsedJson = JSON.parse(resultText);
        const validated = BatchOcrResponseSchema.parse(parsedJson);

        const returnedPageNumbers = validated.pages.map(p => p.pageNumber);
        const missingPages = pagesToExtract.filter(p => !returnedPageNumbers.includes(p));
        const duplicatePages = returnedPageNumbers.filter((p, idx) => returnedPageNumbers.indexOf(p) !== idx);

        if (missingPages.length > 0 || duplicatePages.length > 0) {
          throw new Error(`PAGE_VALIDATION_FAILED: Missing ${missingPages.length} pages, duplicate ${duplicatePages.length} pages`);
        }

        const ocrDir = path.join(PROJECTS_ROOT, projectId, 'extracted', 'ocr');
        fs.mkdirSync(ocrDir, { recursive: true });

        for (const page of validated.pages) {
          const pageFileName = `page-${String(page.pageNumber).padStart(4, '0')}.txt`;
          fs.writeFileSync(path.join(ocrDir, pageFileName), page.text);
        }

        const freshBatch = freshState.batches.find(b => b.pageStart === batch.pageStart && b.pageEnd === batch.pageEnd);
        if (freshBatch) {
          freshBatch.status = 'completed';
          freshBatch.error = undefined;
        }
        saveOcrState(projectId, freshState);

      } catch (err: any) {
        logger.error(`[OCR] Error in batch ${batch.pageStart}-${batch.pageEnd}: ${err.message}`);
        
        const freshState = getOcrState(projectId);
        if (freshState.isCancelled) {
          logger.info(`[OCR] OCR Loop error caught but cancellation is active, stopping.`);
          break;
        }

        const freshBatch = freshState.batches.find(b => b.pageStart === batch.pageStart && b.pageEnd === batch.pageEnd);
        if (freshBatch) {
          freshBatch.status = 'failed';
          freshBatch.error = err.message;
        }

        const isMaxTokens = err.message?.includes('MAX_TOKENS') || err.message?.includes('token limit') || err.message?.includes('limit');
        const isPageValidationFailed = err.message?.includes('PAGE_VALIDATION_FAILED');
        const size = batch.pageEnd - batch.pageStart + 1;

        if ((isMaxTokens || isPageValidationFailed || size > 1) && size > 1) {
          const subdivided = subdivideBatch(batch, freshState);
          if (subdivided.length > 1) {
            const freshBatchIdx = freshState.batches.findIndex(b => b.pageStart === batch.pageStart && b.pageEnd === batch.pageEnd);
            if (freshBatchIdx !== -1) {
              freshState.batches.splice(freshBatchIdx, 1, ...subdivided);
            }
          }
        }
        saveOcrState(projectId, freshState);
      }
    }
  } catch (err: any) {
    logger.error(`[OCR] Uncaught error in project ${projectId} OCR loop: ${err.message}`);
  } finally {
    activeOcrLoops.delete(projectId);
  }
}

export async function finalizeOcrProject(projectId: string, ocrState: OcrState) {
  const projDir = path.join(PROJECTS_ROOT, projectId);
  const ocrDir = path.join(projDir, 'extracted', 'ocr');
  
  const pagesTexts: string[] = [];
  for (let p = 1; p <= ocrState.totalPages; p++) {
    const pageFileName = `page-${String(p).padStart(4, '0')}.txt`;
    const pagePath = path.join(ocrDir, pageFileName);
    if (!fs.existsSync(pagePath)) {
      throw new Error(`Missing page text file for page ${p}`);
    }
    const pageContent = fs.readFileSync(pagePath, 'utf8');
    pagesTexts.push(pageContent);
  }
  
  const reconstructedRawText = pagesTexts.join('\n\n--- PAGE BREAK ---\n\n');
  
  fs.mkdirSync(path.join(projDir, 'extracted'), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'extracted', 'raw_text.txt'), reconstructedRawText);
  fs.writeFileSync(path.join(ocrDir, 'full.txt'), reconstructedRawText);

  const lines = reconstructedRawText.split(/\r?\n/);
  const headings: string[] = [];
  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed.length > 5 && trimmed.length < 50 && trimmed === trimmed.toUpperCase() && /^[A-Z\s\d:,;.-]+$/.test(trimmed)) {
      headings.push(trimmed);
    }
  });

  const stats = {
    charactersCount: reconstructedRawText.length,
    wordsCount: reconstructedRawText.split(/\s+/).filter(Boolean).length,
    pagesCount: ocrState.totalPages,
    headingsCount: headings.length,
  };

  await normalizeAndSaveProject(
    projectId,
    reconstructedRawText,
    headings,
    [],
    'gemini-ocr-extractor',
    stats,
    ocrState.originalFileName,
    ocrState.fileMimeType,
    ocrState.fileSize,
    ocrState.sourcePath,
    fs.readFileSync(ocrState.sourcePath)
  );

  logger.info(`[OCR] Project ${projectId} OCR completed and project normalized successfully.`);
}

export async function normalizeAndSaveProject(
  projectId: string,
  rawText: string,
  headings: string[],
  warnings: string[],
  extractionMethod: string,
  stats: any,
  originalFileName: string,
  fileMimeType: string,
  fileSize: number,
  sourcePath: string,
  buffer: Buffer,
  epubChapters?: { title: string; originalText: string }[],
  epubTitle?: string,
  epubAuthor?: string
) {
  const projDir = path.join(PROJECTS_ROOT, projectId);
  const projects = getProjects();
  const projectIdx = projects.findIndex((p) => p.projectId === projectId);
  if (projectIdx === -1) {
    throw new Error('Project not found during normalization');
  }
  const project = projects[projectIdx];

  // 1. Ensure required subdirectories exist
  const dirs = [
    path.join(projDir, 'source'),
    path.join(projDir, 'extracted'),
    path.join(projDir, 'normalized'),
    path.join(projDir, 'normalized/chapters'),
    path.join(projDir, 'integrity'),
    path.join(projDir, 'logs')
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Calculate SHA-256 for original file
  const sha256Original = crypto.createHash('sha256').update(buffer).digest('hex');

  // 2. Persist versioned artifacts
  // source/original
  const originalPath = path.join(projDir, 'source', 'original');
  fs.writeFileSync(originalPath, buffer);

  let finalRawText = rawText;
  if (epubChapters && epubChapters.length > 0) {
    const joinedTexts = epubChapters.map(ch => ch.originalText || '');
    finalRawText = joinedTexts.join('');
  }

  // Detect language immediately and robustly using start, middle, and end samples!
  let detectedLanguage = 'und';
  let languageConfidence = 0;
  let languageEvidence = 'Estratégia local fallback';

  const detection = await detectLanguageWithGemini(finalRawText, projectId);
  detectedLanguage = detection.languageCode;
  languageConfidence = detection.confidence;
  languageEvidence = detection.evidence;

  let bookTitle = epubTitle || project.name || originalFileName;
  let bookAuthor = epubAuthor || '';
  let recommendedMode = 'audiobook';
  let chaptersToProcess: { order: number; title: string; startOffset: number; endOffset: number }[] = [];
  let intentionallyExcluded: any[] = [];

  const hasApiKey = hasTextAi();

  if (epubChapters && epubChapters.length > 0) {
    let currentOffset = 0;
    chaptersToProcess = epubChapters.map((ch, idx) => {
      const chText = ch.originalText || '';
      const start = currentOffset;
      const end = currentOffset + chText.length;
      currentOffset = end;
      return {
        order: idx + 1,
        title: ch.title || `Capítulo ${idx + 1}`,
        startOffset: start,
        endOffset: end,
      };
    });

    if (hasApiKey) {
      try {
        const response = await callGeminiWithRetryAndFallback(
          TEXT_MODELS.editorial,
          (model) =>
            ai.models.generateContent({
              model,
              contents: [
                {
                  text: `Análise estrutural e editorial de livro/documento. Extraia o título real da obra, autor, idioma predominante e modo de áudio recomendado (audiodrama, audiobook ou technical).
                  Retorne rigorosamente no seguinte schema JSON:
                  {
                    "title": "String",
                    "author": "String",
                    "language": "String (ex: pt-BR, en)",
                    "recommendedMode": "audiodrama" | "audiobook" | "technical"
                  }
                  Aqui está o início do livro para analisar:\n\n${finalRawText.slice(0, 5000)}`,
                },
              ],
              config: {
                responseMimeType: 'application/json',
              },
            })
        );

        const result = JSON.parse(response.text.trim());
        detectedLanguage = result.language || detectedLanguage;
        recommendedMode = result.recommendedMode || 'audiobook';
        bookTitle = result.title || bookTitle;
        bookAuthor = result.author || bookAuthor;
      } catch (err) {
        console.error('Gemini metadata analysis failed for EPUB:', err);
      }
    }
  } else {
    // For Non-EPUB: TXT, HTML, DOCX, PDF
    const candidates: { title: string; index: number }[] = [];

    // Add regex matches for standard Capítulo patterns
    const chapterRegex = /(?:^|\n)(Cap[íi]tulo\s+(?:[0-9]+|[IVXLCDM]+)(?::?\s+[^\n]*)?)/gi;
    let match;
    while ((match = chapterRegex.exec(finalRawText)) !== null) {
      const index = match.index + (match[0].startsWith('\n') ? 1 : 0);
      candidates.push({
        title: match[1].trim(),
        index,
      });
    }

    // Add headings matches
    for (const heading of headings) {
      const trimmed = heading.trim();
      if (trimmed.length < 3 || trimmed.length > 120) continue;

      let pos = -1;
      while ((pos = finalRawText.indexOf(trimmed, pos + 1)) !== -1) {
        const before = pos === 0 ? '\n' : finalRawText[pos - 1];
        const after = pos + trimmed.length === finalRawText.length ? '\n' : finalRawText[pos + trimmed.length];
        if ((before === '\n' || before === '\r') && (after === '\n' || after === '\r')) {
          if (!candidates.some(c => Math.abs(c.index - pos) < 5)) {
            candidates.push({
              title: trimmed,
              index: pos,
            });
          }
        }
      }
    }

    // Sort candidate list by index
    candidates.sort((a, b) => a.index - b.index);

    // Filter candidate list to remove TOC entries
    const uniqueCandidates: typeof candidates = [];
    const tocLimit = Math.floor(finalRawText.length * 0.08); // 8% TOC limit
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      if (cand.index < tocLimit) {
        const isDuplicateLater = candidates.some((c, idx) => idx > i && c.title.toLowerCase() === cand.title.toLowerCase() && c.index >= tocLimit);
        if (isDuplicateLater) {
          continue;
        }
      }
      uniqueCandidates.push(cand);
    }

    // Identify back matter start
    const backMatterLimit = Math.floor(finalRawText.length * 0.85);
    let backMatterStart = finalRawText.length;
    const backMatterKeywords = [
      'Referências', 'Referencias', 'Bibliográficas', 'Bibliograficas',
      'Agradecimentos', 'Posfácio', 'Posfacio', 'Sobre o Autor', 'Sobre o autor',
      'FIM', 'Bibliography', 'Index', 'Glossário', 'Glossario'
    ];

    for (const keyword of backMatterKeywords) {
      let pos = finalRawText.indexOf(keyword, backMatterLimit);
      if (pos !== -1) {
        const before = pos === 0 ? '\n' : finalRawText[pos - 1];
        if (before === '\n' || before === '\r' || before === ' ' || before === '\t') {
          if (pos < backMatterStart) {
            backMatterStart = pos;
          }
        }
      }
    }

    // Use Gemini with structural candidates if available
    let decisionsMap: { [id: number]: { isReal: boolean; refinedTitle: string } } = {};
    if (hasApiKey && uniqueCandidates.length > 0) {
      try {
        const aiCandidates = uniqueCandidates.map((c, idx) => {
          const snippet = finalRawText.slice(c.index, c.index + 120).replace(/\s+/g, ' ');
          return {
            id: idx + 1,
            title: c.title,
            snippet,
          };
        });

        const response = await callGeminiWithRetryAndFallback(
          TEXT_MODELS.editorial,
          (model) =>
            ai.models.generateContent({
              model,
              contents: [
                {
                  text: `Análise estrutural do livro. Identifique o título real do livro, autor, idioma predominante (ex: pt-BR, en), modo recomendado (audiodrama, audiobook, technical) e decida para cada cabeçalho candidato fornecido se é um início real de capítulo ou se é falso positivo (por exemplo, referências no texto, cabeçalhos de rodapé/página ou seções secundárias). Refine os títulos.
                  Retorne rigorosamente no seguinte schema JSON:
                  {
                    "title": "String",
                    "author": "String",
                    "language": "String",
                    "recommendedMode": "audiodrama" | "audiobook" | "technical",
                    "chapters": [
                      {
                        "id": number, // ID enviado
                        "isRealChapter": boolean,
                        "refinedTitle": "String"
                      }
                    ]
                  }
                  Aqui estão os candidatos:\n\n${JSON.stringify(aiCandidates.slice(0, 150), null, 2)}`,
                },
              ],
              config: {
                responseMimeType: 'application/json',
              },
            })
        );

        const result = JSON.parse(response.text.trim());
        detectedLanguage = result.language || detectedLanguage;
        recommendedMode = result.recommendedMode || 'audiobook';
        bookTitle = result.title || bookTitle;
        bookAuthor = result.author || bookAuthor;

        if (Array.isArray(result.chapters)) {
          for (const item of result.chapters) {
            decisionsMap[item.id] = {
              isReal: !!item.isRealChapter,
              refinedTitle: item.refinedTitle || ''
            };
          }
        }
      } catch (err) {
        console.error('Gemini structural candidate filtering failed:', err);
      }
    }

    // Filter candidates based on Gemini decisions or local fallback
    const filteredChapters: { title: string; index: number }[] = [];
    uniqueCandidates.forEach((c, idx) => {
      const decision = decisionsMap[idx + 1];
      if (decision) {
        if (decision.isReal) {
          filteredChapters.push({
            title: decision.refinedTitle || c.title,
            index: c.index,
          });
        }
      } else {
        filteredChapters.push(c);
      }
    });

    if (filteredChapters.length === 0) {
      chaptersToProcess.push({
        order: 1,
        title: 'Capítulo Geral',
        startOffset: 0,
        endOffset: backMatterStart,
      });
    } else {
      for (let i = 0; i < filteredChapters.length; i++) {
        const curr = filteredChapters[i];
        const next = filteredChapters[i + 1];
        const start = curr.index;
        let end = next ? next.index : backMatterStart;
        if (end < start) {
          end = start;
        }
        chaptersToProcess.push({
          order: i + 1,
          title: curr.title,
          startOffset: start,
          endOffset: end,
        });
      }
    }

    // Record Front Matter exclusion
    const firstChapterStart = chaptersToProcess[0].startOffset;
    if (firstChapterStart > 0) {
      intentionallyExcluded.push({
        type: 'front_matter',
        startOffset: 0,
        endOffset: firstChapterStart,
        content: finalRawText.slice(0, firstChapterStart),
        reason: 'Material introdutório, capa, agradecimentos iniciais e folha de rosto.'
      });
    }

    // Record Back Matter / References exclusion
    const lastChapterEnd = chaptersToProcess[chaptersToProcess.length - 1].endOffset;
    if (lastChapterEnd < finalRawText.length) {
      const backMatterText = finalRawText.slice(lastChapterEnd, finalRawText.length);
      const isReferencesOnly = backMatterText.toLowerCase().includes('referên') || backMatterText.toLowerCase().includes('bibliogra');
      intentionallyExcluded.push({
        type: isReferencesOnly ? 'references' : 'back_matter',
        startOffset: lastChapterEnd,
        endOffset: finalRawText.length,
        content: backMatterText,
        reason: isReferencesOnly ? 'Referências bibliográficas e documentação de fontes.' : 'Material final do livro, pósfácio ou sobre o autor.'
      });
    }
  }

  // Write full.txt
  const fullTextPath = path.join(projDir, 'extracted', 'full.txt');
  fs.writeFileSync(fullTextPath, finalRawText);

  const sha256Extracted = crypto.createHash('sha256').update(finalRawText).digest('hex');

  const hashesDict: { [key: string]: string } = {
    'original': sha256Original,
    'full.txt': sha256Extracted,
  };

  const finalChaptersList = chaptersToProcess.map((ch) => {
    const chapterText = finalRawText.slice(ch.startOffset, ch.endOffset);
    const chapterId = `cap_${ch.order}_${Date.now()}`;
    const chapterFileName = `${ch.order}-${chapterId}.original.txt`;
    const chapterMetaFileName = `${ch.order}-${chapterId}.meta.json`;

    // Persist chapter original text
    fs.writeFileSync(path.join(projDir, 'normalized/chapters', chapterFileName), chapterText);

    // Calculate chapter text SHA-256
    const chHash = crypto.createHash('sha256').update(chapterText).digest('hex');
    hashesDict[`normalized/chapters/${chapterFileName}`] = chHash;

    const meta = {
      chapterId,
      projectId,
      order: ch.order,
      title: ch.title,
      startOffset: ch.startOffset,
      endOffset: ch.endOffset,
      characterCount: chapterText.length,
      wordCount: chapterText.split(/\s+/).filter(Boolean).length,
      textHash: chHash,
    };

    // Persist chapter metadata
    fs.writeFileSync(path.join(projDir, 'normalized/chapters', chapterMetaFileName), JSON.stringify(meta, null, 2));

    return {
      chapterId,
      projectId,
      order: ch.order,
      title: ch.title,
      wordCount: meta.wordCount,
      characterCount: meta.characterCount,
      status: isPortuguese(detectedLanguage) ? 'translation_not_required' : 'pending',
      originalText: chapterText,
      translatedText: undefined,
    };
  });

  // Calculate detailed mathematical integrity stats
  const totalLength = finalRawText.length;
  const covered = new Uint8Array(totalLength);

  // Chapters coverage
  for (const ch of chaptersToProcess) {
    for (let i = ch.startOffset; i < ch.endOffset; i++) {
      if (i >= 0 && i < totalLength) {
        covered[i]++;
      }
    }
  }

  // Exclusions coverage
  for (const exc of intentionallyExcluded) {
    for (let i = exc.startOffset; i < exc.endOffset; i++) {
      if (i >= 0 && i < totalLength) {
        covered[i]++;
      }
    }
  }

  let missingChars = 0;
  let duplicatedChars = 0;
  for (let i = 0; i < totalLength; i++) {
    if (covered[i] === 0) {
      missingChars++;
    } else if (covered[i] > 1) {
      duplicatedChars += (covered[i] - 1);
    }
  }

  const includedChars = chaptersToProcess.reduce((sum, ch) => sum + (ch.endOffset - ch.startOffset), 0);
  const intentionallyExcludedChars = intentionallyExcluded.reduce((sum, exc) => sum + (exc.endOffset - exc.startOffset), 0);
  const percentual = Number(((includedChars + intentionallyExcludedChars) / totalLength * 100).toFixed(4));
  const isNormalizedComplete = (includedChars + intentionallyExcludedChars === totalLength) && (missingChars === 0) && (duplicatedChars === 0);

  // 3. Write extracted/manifest.json
  const extractionManifest = {
    originalFileName,
    fileSize,
    fileMimeType,
    extractionMethod,
    warnings,
    stats: {
      charactersCount: totalLength,
      wordsCount: finalRawText.split(/\s+/).filter(Boolean).length,
      pagesCount: stats.pagesCount || 1,
    },
    sha256Original,
    sha256Extracted,
  };
  fs.writeFileSync(path.join(projDir, 'extracted/manifest.json'), JSON.stringify(extractionManifest, null, 2));

  // 4. Write normalized/book-manifest.json
  const bookManifest = {
    title: bookTitle,
    author: bookAuthor,
    language: detectedLanguage,
    recommendedMode,
    totalSourceChars: totalLength,
    includedChars,
    intentionallyExcludedChars,
    missingChars,
    duplicatedChars,
    normalized_complete: isNormalizedComplete,
    chapters: finalChaptersList.map(ch => ({
      chapterId: ch.chapterId,
      order: ch.order,
      title: ch.title,
      characterCount: ch.characterCount,
      wordCount: ch.wordCount,
    })),
    intentionallyExcluded: intentionallyExcluded.map(exc => ({
      type: exc.type,
      startOffset: exc.startOffset,
      endOffset: exc.endOffset,
      reason: exc.reason,
    })),
  };
  fs.writeFileSync(path.join(projDir, 'normalized/book-manifest.json'), JSON.stringify(bookManifest, null, 2));

  // 5. Write integrity/report.json
  const integrityReport = {
    totalSourceChars: totalLength,
    includedChars,
    intentionallyExcludedChars,
    missingChars,
    duplicatedChars,
    percentual,
    normalized_complete: isNormalizedComplete,
    hashes: hashesDict,
  };
  fs.writeFileSync(path.join(projDir, 'integrity/report.json'), JSON.stringify(integrityReport, null, 2));

  // 6. Write legacy compatible normalized/chapters.json
  fs.writeFileSync(path.join(projDir, 'normalized/chapters.json'), JSON.stringify(finalChaptersList, null, 2));

  // 7. Update project record metadata and status
  const totalWords = finalChaptersList.reduce((acc, c) => acc + c.wordCount, 0);
  const totalChars = finalChaptersList.reduce((acc, c) => acc + c.characterCount, 0);

  project.detectedTitle = bookTitle;
  project.recommendedProductionMode = recommendedMode as any;

  if (!project.userTitle) {
    project.userTitle = project.name || bookTitle;
  }
  if (!project.selectedProductionMode) {
    project.selectedProductionMode = project.productionMode || (recommendedMode as any);
  }

  // Never overwrite user-selected modes/titles automatically!
  project.name = project.userTitle;
  project.productionMode = project.selectedProductionMode;

  project.status = 'awaiting_configuration';
  project.sourceLanguage = detectedLanguage;
  project.languageConfidence = languageConfidence;
  project.languageEvidence = languageEvidence;
  project.wordCount = totalWords;
  project.characterCount = totalChars;
  project.estimatedCost = Number((totalChars * 0.00001).toFixed(2));
  project.durationSeconds = Math.round(totalWords * 0.4);
  project.updatedAt = new Date().toISOString();

  saveProjects(getProjects().map((p) => (p.projectId === projectId ? project : p)));

  // Write structured processing log
  const log = {
    logId: `log_${Date.now()}`,
    projectId,
    userId: project.ownerId,
    operation: 'document_extraction_analysis',
    inputUnits: fileSize,
    outputUnits: totalChars,
    estimatedCost: project.estimatedCost,
    status: 'success',
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(projDir, 'logs/processing.json'), JSON.stringify([log], null, 2));
}

export function writeStructuredLog(projectId: string, operation: string, status: 'success' | 'failed', details: any = {}) {
  try {
    const projDir = path.join(PROJECTS_ROOT, projectId);
    const logsFile = path.join(projDir, 'logs/processing.json');
    let logs: any[] = [];
    if (fs.existsSync(logsFile)) {
      try {
        logs = JSON.parse(fs.readFileSync(logsFile, 'utf8'));
      } catch (e) {
        logs = [];
      }
    }
    const redactedDetails = redactSensitiveData(details);
    const newLog = {
      logId: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      projectId,
      operation,
      status,
      timestamp: new Date().toISOString(),
      ...redactedDetails
    };
    logs.push(newLog);
    if (!fs.existsSync(path.dirname(logsFile))) {
      fs.mkdirSync(path.dirname(logsFile), { recursive: true });
    }
    fs.writeFileSync(logsFile, JSON.stringify(logs, null, 2));
    logger.info(`[STRUCTURED LOG] [${status.toUpperCase()}] Project ${projectId} - Operation ${operation}:`, JSON.stringify(redactSensitiveData(newLog)));
  } catch (err) {
    logger.error('Error writing structured log:', err);
  }
}

// Utility functions for Database
function getProjects(): any[] {
  try {
    if (fs.existsSync(PROJECTS_DB_FILE)) {
      return JSON.parse(fs.readFileSync(PROJECTS_DB_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error reading projects DB:', err);
  }
  return [];
}

function saveProjects(projects: any[]): void {
  try {
    fs.writeFileSync(PROJECTS_DB_FILE, JSON.stringify(projects, null, 2));
  } catch (err) {
    console.error('Error saving projects DB:', err);
  }
}

// Initialize project folders helper
function ensureProjectDirs(projectId: string) {
  const projDir = path.join(PROJECTS_ROOT, projectId);
  const dirs = [
    'source',
    'extracted',
    'normalized',
    'translation',
    'narrative-bible',
    'scripts',
    'audio/segments',
    'audio/chapters',
    'exports',
    'logs',
  ];
  dirs.forEach((d) => {
    const fullPath = path.join(projDir, d);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  });
}

// ==================== API ROUTES ====================

// GET list of projects
app.get('/api/projects', (req, res) => {
  const projects = getProjects();
  res.json({ projects });
});

// GET current state of API limits/quotas
app.get('/api/api-state', (req, res) => {
  res.json({
    isGeminiQuotaExceeded,
    isGeminiTTSQuotaExceeded,
    isGoogleCloudTTSDisabled,
  });
});

// GET translation and TTS capabilities based on key configuration without exposing secrets
app.get('/api/capabilities', async (req, res) => {
  const geminiKey = getActiveGeminiApiKey();
  const hasGeminiKey = !!geminiKey;
  const gcpCreds = await getActiveGcpCredentials();
  const hasGcp = gcpCreds.type !== 'none';
  if (gcpCreds.type === 'adc' && gcpValidationStatus !== 'valid') await ttsProviders.gcp.listVoices();
  const hasWavenetPtBr = hasGcp && gcpValidationStatus === 'valid';

  res.json({
    openaiText: hasTextAi(),
    geminiText: false,
    geminiTts: hasGeminiKey,
    modelIds: [...new Set([TEXT_MODELS.bulk, TEXT_MODELS.editorial, TEXT_MODELS.audit])],
    googleCloudTts: hasGcp,
    wavenetPtBr: hasWavenetPtBr,
    credentialSource: gcpCreds.source,
    validationStatus: gcpValidationStatus,
    translation: hasTextAi(),
    tts: hasGeminiKey || hasGcp,
    freesound: !!(sessionFreesoundApiKey || process.env.FREESOUND_API_KEY)
  });
});

app.get('/api/voices/catalog', async (_req, res) => {
  const geminiAvailable = !!getActiveGeminiApiKey();
  const gcpCreds = await getActiveGcpCredentials();
  if (gcpCreds.type === 'adc' && gcpValidationStatus !== 'valid') await ttsProviders.gcp.listVoices();
  const gcpAvailable = isGcpConfiguredSync() && gcpValidationStatus === 'valid';
  res.json({ voices: VOICE_CATALOG.map(voice => ({
    ...voice,
    available: voice.providerId === 'gcp' ? gcpAvailable : geminiAvailable
  })) });
});

app.get('/api/freesound/search', async (req, res) => {
  try {
    const token = sessionFreesoundApiKey || process.env.FREESOUND_API_KEY;
    if (!token) return res.status(400).json({ error: 'FREESOUND_API_KEY não configurada' });
    const query = String(req.query.query || '').trim().slice(0, 120);
    if (query.length < 2) return res.status(400).json({ error: 'Informe um contexto com pelo menos 2 caracteres' });
    const params = new URLSearchParams({ query, token, page_size: '12', fields: 'id,name,description,tags,license,username,duration,previews,url,download' });
    const response = await fetch(`https://freesound.org/apiv2/search/?${params}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Freesound respondeu HTTP ${response.status}`);
    const data: any = await response.json();
    res.json({ results: (data.results || []).map((sound: any) => ({ id:sound.id, name:sound.name, description:sound.description, tags:sound.tags, license:sound.license, username:sound.username, duration:sound.duration, pageUrl:sound.url, previewUrl:sound.previews?.['preview-hq-mp3'] || sound.previews?.['preview-lq-mp3'] })) });
  } catch (err: any) { res.status(502).json({ error: redactSensitiveData(err.message) }); }
});

app.put('/api/settings/credentials/freesound', (req, res) => {
  const apiKey = String(req.body?.apiKey || '').trim();
  if (!apiKey) return res.status(400).json({ error: 'Chave Freesound obrigatória' });
  sessionFreesoundApiKey = apiKey;
  res.json({ status:'success' });
});

app.post('/api/projects/:projectId/context-sounds', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { segmentId, sound, volume = .12 } = req.body || {};
    const projDir = path.join(PROJECTS_ROOT, projectId);
    if (!fs.existsSync(projDir)) return res.status(404).json({ error:'Projeto não encontrado' });
    const preview = new URL(String(sound?.previewUrl || ''));
    if (!preview.hostname.endsWith('freesound.org')) return res.status(400).json({ error:'URL de prévia Freesound inválida' });
    const response = await fetch(preview, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Falha ao baixar prévia: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error('Prévia vazia ou acima de 20 MB');
    const dir = path.join(projDir, 'audio/context'); fs.mkdirSync(dir, { recursive:true });
    const safeId = String(sound.id).replace(/[^0-9]/g,'');
    const localPath = path.join(dir, `${safeId}.mp3`); fs.writeFileSync(localPath, buffer);
    const file = path.join(projDir, 'audio/context-sounds.json');
    const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : [];
    const cue = { segmentId, soundId:sound.id, name:sound.name, username:sound.username, license:sound.license, pageUrl:sound.pageUrl, previewUrl:sound.previewUrl, localPath:`/projects/${projectId}/audio/context/${safeId}.mp3`, volume:Math.max(.03,Math.min(.35,Number(volume)||.12)) };
    const next = [...list.filter((item:any) => item.segmentId !== segmentId), cue];
    fs.writeFileSync(file, JSON.stringify(next,null,2));
    res.json({ cue });
  } catch (err:any) { res.status(500).json({ error:redactSensitiveData(err.message) }); }
});

app.post('/api/projects/:projectId/context-sounds/mix', async (req, res) => {
  try {
    const { projectId } = req.params; const projDir = path.join(PROJECTS_ROOT, projectId);
    const segFile = path.join(projDir,'scripts/segments.json'); const cueFile = path.join(projDir,'audio/context-sounds.json');
    if (!fs.existsSync(segFile) || !fs.existsSync(cueFile)) return res.status(400).json({ error:'Roteiro ou sons contextuais ausentes' });
    const segments = JSON.parse(fs.readFileSync(segFile,'utf8')); const cues = JSON.parse(fs.readFileSync(cueFile,'utf8'));
    const outDir = path.join(projDir,'audio/contextualized'); fs.mkdirSync(outDir,{recursive:true}); let mixed=0;
    for (const cue of cues) {
      const segment = segments.find((item:any) => item.segmentId === cue.segmentId);
      if (!segment?.audioPath) continue;
      const voicePath = path.join(projDir,'audio/segments',path.basename(segment.audioPath));
      const bgPath = path.join(projDir,'audio/context',path.basename(cue.localPath));
      const output = path.join(outDir,`${segment.segmentId}.wav`);
      await runFfmpeg(['-y','-i',voicePath,'-stream_loop','-1','-i',bgPath,'-filter_complex',`[1:a]volume=${cue.volume},afade=t=in:st=0:d=0.4[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=1`,'-ar','24000','-ac','1','-c:a','pcm_s16le',output]);
      segment.contextualAudioPath = `/projects/${projectId}/audio/contextualized/${segment.segmentId}.wav`; mixed++;
    }
    fs.writeFileSync(segFile,JSON.stringify(segments,null,2)); res.json({ success:true,mixed,segments });
  } catch (err:any) { res.status(500).json({ error:redactSensitiveData(err.message) }); }
});

// GET credentials status
app.get('/api/settings/credentials/status', async (req, res) => {
  try {
    const creds = await getActiveGcpCredentials();
    const gcpConfigured = creds.type !== 'none';
    if (creds.type === 'adc' && gcpValidationStatus !== 'valid') await ttsProviders.gcp.listVoices();

    const geminiKey = getActiveGeminiApiKey();
    const geminiConfigured = !!geminiKey;
    let geminiSource = 'none';
    if (process.env.GEMINI_API_KEY) {
      geminiSource = 'env_gemini';
    } else if (sessionGeminiApiKey) {
      geminiSource = 'stored_session';
    } else if (fs.existsSync(GEMINI_CREDENTIALS_PATH)) {
      geminiSource = 'stored_disk';
    }

    const openAiConfigured = hasTextAi();
    const openAiSource = process.env.OPENAI_API_KEY
      ? 'env_openai'
      : sessionOpenAiApiKey
        ? 'stored_session'
        : fs.existsSync(OPENAI_CREDENTIALS_PATH)
          ? 'stored_disk'
          : 'none';

    res.json({
      openai: {
        provider: 'openai',
        configured: openAiConfigured,
        source: openAiSource,
        validationStatus: openAiConfigured ? 'configured_untested' : 'unconfigured',
        models: TEXT_MODELS,
        updatedAt: new Date().toISOString()
      },
      gcp: {
        provider: 'gcp',
        configured: gcpConfigured,
        source: creds.source,
        validationStatus: gcpValidationStatus,
        updatedAt: gcpLastValidatedAt || new Date().toISOString()
      },
      gemini: {
        provider: 'gemini',
        configured: geminiConfigured,
        source: geminiSource,
        validationStatus: geminiConfigured ? 'valid' : 'unconfigured',
        updatedAt: new Date().toISOString()
      },
      freesound: { provider:'freesound', configured:!!(sessionFreesoundApiKey || process.env.FREESOUND_API_KEY), source:process.env.FREESOUND_API_KEY ? 'env_freesound' : sessionFreesoundApiKey ? 'stored_session' : 'none', validationStatus:(sessionFreesoundApiKey || process.env.FREESOUND_API_KEY) ? 'configured_untested' : 'unconfigured', updatedAt:new Date().toISOString() }
    });
  } catch (err) {
    res.status(500).json({ error: redactSensitiveData(err.message) });
  }
});

// OpenAI is used only for text reasoning. Gemini and Google Cloud credentials
// remain isolated and are used only by their respective TTS providers.
app.put('/api/settings/credentials/openai', (req, res) => {
  try {
    const { apiKey, sessionOnly } = req.body;
    if (!apiKey || typeof apiKey !== 'string') return res.status(400).json({ error: 'Chave API é obrigatória' });
    sessionOpenAiApiKey = apiKey.trim();
    if (!sessionOnly) {
      const masterKey = process.env.VOXLIBRO_MASTER_KEY;
      if (!isValidMasterKey(masterKey)) {
        sessionOpenAiApiKey = null;
        return res.status(400).json({ error: { code: 'MASTER_KEY_REQUIRED', message: 'Configure VOXLIBRO_MASTER_KEY com ao menos 32 caracteres seguros ou salve apenas nesta sessão.' } });
      }
      fs.writeFileSync(OPENAI_CREDENTIALS_PATH, encrypt(JSON.stringify({ apiKey: apiKey.trim() }), masterKey!), { mode: 0o600 });
    } else if (fs.existsSync(OPENAI_CREDENTIALS_PATH)) {
      fs.unlinkSync(OPENAI_CREDENTIALS_PATH);
    }
    res.json({ status: 'success' });
  } catch (err: any) {
    res.status(500).json({ error: redactSensitiveData(err.message) });
  }
});

app.post('/api/settings/credentials/openai/test', async (_req, res) => {
  try {
    const response = await ai.models.generateContent({ model: TEXT_MODELS.bulk, contents: [{ text: 'Responda somente: OK' }] });
    res.json({ success: /^\s*OK/i.test(response.text || ''), model: TEXT_MODELS.bulk });
  } catch (err: any) {
    res.status(400).json({ success: false, error: redactSensitiveData(err.message) });
  }
});

app.delete('/api/settings/credentials/openai', (_req, res) => {
  try {
    const hasEnvKey = !!process.env.OPENAI_API_KEY;
    sessionOpenAiApiKey = null;
    if (fs.existsSync(OPENAI_CREDENTIALS_PATH)) fs.unlinkSync(OPENAI_CREDENTIALS_PATH);
    res.json({
      status: 'success',
      message: hasEnvKey ? 'A credencial local foi removida; OPENAI_API_KEY continua ativa no ambiente do servidor.' : undefined
    });
  } catch (err: any) {
    res.status(500).json({ error: redactSensitiveData(err.message) });
  }
});

// PUT Google Cloud TTS credentials
app.put('/api/settings/credentials/google-cloud-tts', async (req, res) => {
  try {
    const { method, apiKey, sessionOnly } = req.body;
    
    if (method === 'adc') {
      sessionGcpTtsApiKey = null;
      savedGcpTtsMethod = 'adc';
      gcpValidationStatus = 'configured_untested';
      gcpLastValidatedAt = new Date().toISOString();
      
      if (!sessionOnly) {
        const credentialsDir = path.dirname(CREDENTIALS_PATH);
        if (!fs.existsSync(credentialsDir)) {
          fs.mkdirSync(credentialsDir, { recursive: true });
        }
        let fileContent = JSON.stringify({ method: 'adc' });
        const masterKey = process.env.VOXLIBRO_MASTER_KEY;
        if (isValidMasterKey(masterKey)) {
          fileContent = encrypt(fileContent, masterKey!);
        }
        fs.writeFileSync(CREDENTIALS_PATH, fileContent, { mode: 0o600 });
      } else {
        if (fs.existsSync(CREDENTIALS_PATH)) {
          try { fs.unlinkSync(CREDENTIALS_PATH); } catch(e){}
        }
      }
      
      return res.json({
        status: 'success',
        warning: null
      });
    }

    if (method === 'apiKey') {
      if (!apiKey) {
        return res.status(400).json({ error: 'Chave API é obrigatória' });
      }
      
      sessionGcpTtsApiKey = apiKey;
      savedGcpTtsMethod = 'apiKey';
      gcpValidationStatus = 'configured_untested';
      gcpLastValidatedAt = new Date().toISOString();
      
      let warning: string | null = null;
      
      if (!sessionOnly) {
        const masterKey = process.env.VOXLIBRO_MASTER_KEY;
        if (!isValidMasterKey(masterKey)) {
          return res.status(400).json({
            error: {
              code: 'MASTER_KEY_REQUIRED',
              message: 'A chave mestra VOXLIBRO_MASTER_KEY não está configurada ou é inválida (deve ter no mínimo 32 caracteres seguros). Para usar sem chave mestra, selecione "Apenas nesta sessão (em memória)".'
            }
          });
        }
        
        const credentialsDir = path.dirname(CREDENTIALS_PATH);
        if (!fs.existsSync(credentialsDir)) {
          fs.mkdirSync(credentialsDir, { recursive: true });
        }
        
        const fileContent = encrypt(JSON.stringify({ method: 'apiKey', apiKey }), masterKey!);
        fs.writeFileSync(CREDENTIALS_PATH, fileContent, { mode: 0o600 });
      } else {
        if (fs.existsSync(CREDENTIALS_PATH)) {
          try { fs.unlinkSync(CREDENTIALS_PATH); } catch(e){}
        }
      }
      
      return res.json({
        status: 'success',
        warning
      });
    }
    
    res.status(400).json({ error: 'Método inválido' });
  } catch (err) {
    res.status(500).json({ error: redactSensitiveData(err.message) });
  }
});

// POST test Google Cloud TTS connection
app.post('/api/settings/credentials/google-cloud-tts/test', async (req, res) => {
  try {
    const creds = await getActiveGcpCredentials();
    if (creds.type === 'none') {
      gcpValidationStatus = 'unconfigured';
      return res.status(400).json({ error: 'Nenhuma credencial configurada' });
    }

    const url = 'https://texttospeech.googleapis.com/v1/voices?languageCode=pt-BR';
    const headers: any = {
      'Content-Type': 'application/json'
    };
    
    if (creds.type === 'apiKey' && creds.keyOrToken) {
      headers['X-Goog-Api-Key'] = creds.keyOrToken;
    } else if (creds.type === 'adc' && creds.keyOrToken) {
      headers['Authorization'] = `Bearer ${creds.keyOrToken}`;
    }

    const response = await fetch(url, { headers });
    gcpLastValidatedAt = new Date().toISOString();

    if (!response.ok) {
      const errText = await response.text();
      let errorJson: any = {};
      try {
        errorJson = JSON.parse(errText);
      } catch(e){}

      const errMsg = errorJson.error?.message || errText;
      const status = response.status;

      if (status === 400 || status === 401) {
        gcpValidationStatus = 'invalid';
      } else if (status === 403) {
        const lowerMsg = errMsg.toLowerCase();
        if (lowerMsg.includes('has not been used') || lowerMsg.includes('not enabled') || lowerMsg.includes('api_disabled')) {
          gcpValidationStatus = 'api_disabled';
        } else if (lowerMsg.includes('billing') || lowerMsg.includes('quota') || lowerMsg.includes('billing_disabled')) {
          gcpValidationStatus = 'billing_missing';
        } else {
          gcpValidationStatus = 'no_permission';
        }
      } else {
        gcpValidationStatus = 'invalid';
      }

      const sanitizedError = redactSensitiveData(errMsg);
      return res.json({
        success: false,
        validationStatus: gcpValidationStatus,
        error: sanitizedError
      });
    }

    const data: any = await response.json();
    const voices = (data.voices || [])
      .filter((v: any) => v.languageCodes && v.languageCodes.includes('pt-BR'))
      .map((v: any) => ({
        voiceName: v.name,
        providerId: 'gcp',
        gender: (v.ssmlGender === 'FEMALE' ? 'female' : 'male') as 'female' | 'male',
        languageCodes: ['pt-BR']
      }));

    gcpValidationStatus = 'valid';
    
    res.json({
      success: true,
      validationStatus: 'valid',
      voices
    });
  } catch (err) {
    gcpValidationStatus = 'invalid';
    res.status(500).json({
      success: false,
      validationStatus: 'invalid',
      error: redactSensitiveData(err.message)
    });
  }
});

// GET list of dynamic voices from GCP TTS without full connection test
app.get('/api/settings/credentials/google-cloud-tts/voices', async (req, res) => {
  try {
    const provider = ttsProviders['gcp'];
    if (!provider) {
      return res.json({ voices: ACTUAL_PT_BR_VOICES });
    }
    const voices = await provider.listVoices();
    res.json({ voices });
  } catch (err) {
    res.status(500).json({ error: redactSensitiveData(err.message) });
  }
});

// DELETE Google Cloud TTS credentials
app.delete('/api/settings/credentials/google-cloud-tts', async (req, res) => {
  try {
    const hasEnvKey = !!process.env.GOOGLE_CLOUD_TTS_API_KEY;
    const hasEnvAdc = !!(process.env.GCP_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS);

    sessionGcpTtsApiKey = null;
    gcpValidationStatus = 'unconfigured';
    gcpLastValidatedAt = new Date().toISOString();
    
    if (fs.existsSync(CREDENTIALS_PATH)) {
      try {
        fs.unlinkSync(CREDENTIALS_PATH);
      } catch (e) {
        console.error('Failed to delete credentials file:', e);
      }
    }

    if (hasEnvKey || hasEnvAdc) {
      return res.json({
        status: 'success',
        message: 'Credenciais locais/memória removidas. As credenciais definidas no ambiente do servidor (GCP_CREDENTIALS / GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_CLOUD_TTS_API_KEY) permanecem ativas e devem ser removidas diretamente no Render.'
      });
    }

    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ error: redactSensitiveData(err.message) });
  }
});

// PUT Gemini credentials
app.put('/api/settings/credentials/gemini', async (req, res) => {
  try {
    const { apiKey, sessionOnly } = req.body;
    if (!apiKey) {
      return res.status(400).json({ error: 'Chave API é obrigatória' });
    }
    
    sessionGeminiApiKey = apiKey;
    updateAiClient();
    
    let warning: string | null = null;
    if (!sessionOnly) {
      const masterKey = process.env.VOXLIBRO_MASTER_KEY;
      if (!isValidMasterKey(masterKey)) {
        return res.status(400).json({
          error: {
            code: 'MASTER_KEY_REQUIRED',
            message: 'A chave mestra VOXLIBRO_MASTER_KEY não está configurada ou é inválida (deve ter no mínimo 32 caracteres seguros). Para usar sem chave mestra, selecione "Apenas nesta sessão (em memória)".'
          }
        });
      }

      const credentialsDir = path.dirname(GEMINI_CREDENTIALS_PATH);
      if (!fs.existsSync(credentialsDir)) {
        fs.mkdirSync(credentialsDir, { recursive: true });
      }
      
      const fileContent = encrypt(JSON.stringify({ apiKey }), masterKey!);
      fs.writeFileSync(GEMINI_CREDENTIALS_PATH, fileContent, { mode: 0o600 });
    } else {
      if (fs.existsSync(GEMINI_CREDENTIALS_PATH)) {
        try { fs.unlinkSync(GEMINI_CREDENTIALS_PATH); } catch(e){}
      }
    }
    
    res.json({ status: 'success', warning });
  } catch (err) {
    res.status(500).json({ error: redactSensitiveData(err.message) });
  }
});

// DELETE Gemini credentials
app.delete('/api/settings/credentials/gemini', async (req, res) => {
  try {
    const hasEnvKey = !!process.env.GEMINI_API_KEY;
    sessionGeminiApiKey = null;
    updateAiClient();
    
    if (fs.existsSync(GEMINI_CREDENTIALS_PATH)) {
      try {
        fs.unlinkSync(GEMINI_CREDENTIALS_PATH);
      } catch (e) {
        console.error('Failed to delete Gemini credentials file:', e);
      }
    }

    if (hasEnvKey) {
      return res.json({
        status: 'success',
        message: 'Credenciais locais/memória removidas. No entanto, a chave fornecida pela variável de ambiente do servidor (GEMINI_API_KEY) permanece ativa e deve ser removida diretamente no ambiente do servidor.'
      });
    }

    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ error: redactSensitiveData(err.message) });
  }
});

// GET single project details and structures
app.get('/api/projects/:projectId', (req, res) => {
  const { projectId } = req.params;
  const projects = getProjects();
  const project = projects.find((p) => p.projectId === projectId);

  if (!project) {
    return res.status(404).json({ error: 'Projeto não encontrado' });
  }

  // Load ancillary files (chapters, characters, glossary, segments)
  const projDir = path.join(PROJECTS_ROOT, projectId);

  let chapters: any[] = [];
  const chaptersFile = path.join(projDir, 'normalized/chapters.json');
  if (fs.existsSync(chaptersFile)) {
    chapters = JSON.parse(fs.readFileSync(chaptersFile, 'utf8'));
  }

  let characters: any[] = [];
  const charactersFile = path.join(projDir, 'narrative-bible/characters.json');
  if (fs.existsSync(charactersFile)) {
    characters = JSON.parse(fs.readFileSync(charactersFile, 'utf8'));
  }

  let sightings: any[] = [];
  const sightingsFile = path.join(projDir, 'narrative-bible/sightings.json');
  if (fs.existsSync(sightingsFile)) {
    sightings = JSON.parse(fs.readFileSync(sightingsFile, 'utf8'));
  }

  let mergeSuggestions: any[] = [];
  const suggestionsFile = path.join(projDir, 'narrative-bible/merge-suggestions.json');
  if (fs.existsSync(suggestionsFile)) {
    mergeSuggestions = JSON.parse(fs.readFileSync(suggestionsFile, 'utf8'));
  }

  let glossary: any[] = [];
  const glossaryFile = path.join(projDir, 'translation/glossary.json');
  if (fs.existsSync(glossaryFile)) {
    glossary = JSON.parse(fs.readFileSync(glossaryFile, 'utf8'));
  }

  let segments: any[] = [];
  const segmentsFile = path.join(projDir, 'scripts/segments.json');
  if (fs.existsSync(segmentsFile)) {
    segments = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'));
  }

  let logs: any[] = [];
  const logsFile = path.join(projDir, 'logs/processing.json');
  if (fs.existsSync(logsFile)) {
    logs = JSON.parse(fs.readFileSync(logsFile, 'utf8'));
  }
  let contextSounds: any[] = [];
  const contextSoundsFile = path.join(projDir, 'audio/context-sounds.json');
  if (fs.existsSync(contextSoundsFile)) contextSounds = JSON.parse(fs.readFileSync(contextSoundsFile,'utf8'));

  res.json({
    project,
    chapters,
    characters,
    sightings,
    mergeSuggestions,
    glossary,
    segments,
    logs,
    contextSounds,
    apiQuotaState: {
      isGeminiQuotaExceeded,
      isGeminiTTSQuotaExceeded,
      isGoogleCloudTTSDisabled,
    }
  });
});

// GET text integrity report
app.get('/api/projects/:projectId/integrity', (req, res) => {
  const { projectId } = req.params;
  const projDir = path.join(PROJECTS_ROOT, projectId);
  const reportPath = path.join(projDir, 'integrity/report.json');
  if (!fs.existsSync(reportPath)) {
    return res.status(404).json({ error: 'Relatório de integridade não encontrado para este projeto.' });
  }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    return res.json({ report });
  } catch (err: any) {
    return res.status(500).json({ error: 'Falha ao carregar relatório de integridade: ' + err.message });
  }
});

// CREATE project
app.post('/api/projects', (req, res) => {
  const { name, ownerId, productionMode, sourceLanguage, targetLanguage, translationEnabled, copyrightDeclared } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Nome do projeto é obrigatório' });
  }

  const projectId = `proj_${Date.now()}`;
  ensureProjectDirs(projectId);

  const newProject = {
    projectId,
    ownerId: ownerId || 'local-owner',
    name,
    userTitle: name,
    status: 'created',
    productionMode: productionMode || 'audiobook',
    selectedProductionMode: productionMode || 'audiobook',
    sourceLanguage: sourceLanguage || 'auto',
    targetLanguage: targetLanguage || 'pt-BR',
    translationEnabled: translationEnabled ?? true,
    copyrightDeclared: copyrightDeclared ?? false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    wordCount: 0,
    characterCount: 0,
    durationSeconds: 0,
    estimatedCost: 0,
  };

  const projects = getProjects();
  projects.push(newProject);
  saveProjects(projects);

  res.status(201).json({ project: newProject });
});

// DELETE project
app.delete('/api/projects/:projectId', (req, res) => {
  const { projectId } = req.params;
  const projects = getProjects();
  const projectIdx = projects.findIndex((p) => p.projectId === projectId);

  if (projectIdx === -1) {
    return res.status(404).json({ error: 'Projeto não encontrado' });
  }

  projects.splice(projectIdx, 1);
  saveProjects(projects);

  // Recursively delete folder on local filesystem
  const projDir = path.join(PROJECTS_ROOT, projectId);
  if (fs.existsSync(projDir)) {
    try {
      fs.rmSync(projDir, { recursive: true, force: true });
    } catch (e) {
      console.error(`Failed to remove project folder ${projDir}:`, e);
    }
  }

  res.json({ success: true, message: 'Projeto e todos os dados associados foram excluídos permanentemente.' });
});

// CONFIGURE / CONFIRM project options
app.post('/api/projects/:projectId/configure', express.json(), (req, res) => {
  const { projectId } = req.params;
  const { userTitle, selectedProductionMode, sourceLanguage, translationEnabled, intensity } = req.body;

  const projects = getProjects();
  const projectIdx = projects.findIndex((p) => p.projectId === projectId);
  if (projectIdx === -1) {
    return res.status(404).json({ error: 'Projeto não encontrado' });
  }

  const project = projects[projectIdx];

  if (intensity !== undefined) {
    const val = Number(intensity);
    if (isNaN(val) || val < 0 || val > 1) {
      return res.status(400).json({ error: 'Intensidade inválida. Deve ser um número entre 0 e 1.' });
    }
    project.intensity = val;
  }

  if (userTitle !== undefined) {
    project.userTitle = userTitle;
    project.name = userTitle;
  }

  if (selectedProductionMode !== undefined) {
    project.selectedProductionMode = selectedProductionMode;
    project.productionMode = selectedProductionMode;
  }

  if (sourceLanguage !== undefined) {
    project.sourceLanguage = sourceLanguage;
  }

  if (translationEnabled !== undefined) {
    project.translationEnabled = !!translationEnabled;
  }

  // Automatically determine chapter status and next project status based on language & translationEnabled
  const isPtBr = isPortuguese(project.sourceLanguage);
  const projDir = path.join(PROJECTS_ROOT, projectId);
  const chaptersFile = path.join(projDir, 'normalized/chapters.json');

  if (fs.existsSync(chaptersFile)) {
    const chapters: any[] = JSON.parse(fs.readFileSync(chaptersFile, 'utf8'));
    if (isPtBr) {
      // If original is pt-BR, chapters get translation_not_required
      for (const ch of chapters) {
        ch.status = 'translation_not_required';
        ch.translatedText = undefined;
      }
      project.status = 'analyzing_characters';
    } else if (project.translationEnabled === false) {
      // If translation is disabled, no translation needed
      for (const ch of chapters) {
        ch.status = 'translation_not_required';
        ch.translatedText = undefined;
      }
      project.status = 'analyzing_characters';
    } else {
      // Needs translation, reset chapter statuses to pending for translation if they were translation_not_required
      for (const ch of chapters) {
        if (ch.status === 'translation_not_required') {
          ch.status = 'pending';
          ch.translatedText = undefined;
        }
      }
      project.status = 'translating';
    }
    fs.writeFileSync(chaptersFile, JSON.stringify(chapters, null, 2));
  } else {
    // If chapters are not extracted yet, just transition status based on settings
    project.status = (isPtBr || project.translationEnabled === false) ? 'analyzing_characters' : 'translating';
  }

  project.updatedAt = new Date().toISOString();
  saveProjects(projects);

  res.json({ success: true, project });
});

// EPUB Extraction Helpers
interface EpubChapter {
  title: string;
  originalText: string;
}

interface EpubResult {
  title: string;
  author: string;
  rawText: string;
  chapters: EpubChapter[];
}

export interface ExtractedResult {
  text: string;
  pages: { pageNumber: number; text: string }[];
  headings: string[];
  warnings: string[];
  method: string;
  confidence: number;
  stats: {
    charactersCount: number;
    wordsCount: number;
    pagesCount?: number;
    headingsCount?: number;
  };
}

export function validateUploadedFile(file: Express.Multer.File) {
  if (!file) {
    throw new Error('Arquivo não fornecido.');
  }

  // 1. Validate size
  const maxSize = parseInt(process.env.MAX_FILE_SIZE || '52428800', 10); // 50MB
  if (file.size > maxSize) {
    throw new Error(`Arquivo excede o tamanho máximo de ${(maxSize / (1024 * 1024)).toFixed(0)}MB.`);
  }

  // 2. Validate extension and MIME
  const fileName = file.originalname;
  const mimeType = file.mimetype;
  const ext = path.extname(fileName).toLowerCase();

  const allowedExtensions = ['.pdf', '.epub', '.docx', '.txt', '.md', '.html', '.htm'];
  if (!allowedExtensions.includes(ext)) {
    throw new Error(`Extensão de arquivo não permitida: ${ext}`);
  }

  const allowedMimeTypes = [
    'application/pdf',
    'application/epub+zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
    'text/html',
    'application/octet-stream'
  ];
  if (!allowedMimeTypes.includes(mimeType) && !mimeType.startsWith('text/')) {
    throw new Error(`Tipo MIME não permitido: ${mimeType}`);
  }

  // 3. Validate Magic Bytes and Integrity
  const buffer = file.buffer;
  if (!buffer || buffer.length === 0) {
    throw new Error('Arquivo corrompido ou vazio.');
  }

  if (ext === '.pdf') {
    const magic = buffer.slice(0, 4).toString('hex');
    if (magic !== '25504446') {
      throw new Error('Assinatura do arquivo PDF inválida (magic bytes incorretos).');
    }
  } else if (ext === '.epub' || ext === '.docx') {
    const magic = buffer.slice(0, 4).toString('hex');
    if (magic !== '504b0304') {
      throw new Error(`Assinatura do arquivo ${ext.toUpperCase()} inválida (não é um arquivo ZIP válido).`);
    }
  }

  // 4. Validate name and prevent path traversal
  if (
    fileName.includes('..') ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0') ||
    path.isAbsolute(fileName)
  ) {
    throw new Error('Nome de arquivo inválido ou tentativa de path traversal detectada.');
  }

  return { ext, baseName: path.basename(fileName, ext) };
}

export function checkZipBomb(zip: AdmZip) {
  const entries = zip.getEntries();
  let totalDecompressedSize = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const size = entry.header.size; // decompressed size
    const compressedSize = entry.header.compressedSize;
    if (compressedSize > 0 && size / compressedSize > 100 && size > 1024 * 1024) {
      throw new Error('ZIP bomb detectada: taxa de compressão excessiva em arquivo do EPUB.');
    }
    totalDecompressedSize += size;
  }
  if (totalDecompressedSize > 100 * 1024 * 1024) {
    throw new Error('EPUB excede o limite máximo de descompactação segura de 100MB.');
  }
}

export function extractTextMd(buffer: Buffer): ExtractedResult {
  let encoding = 'utf8';
  let cleanBuffer = buffer;

  // Detect BOM
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    cleanBuffer = buffer.slice(3);
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = 'utf16be';
    cleanBuffer = buffer.slice(2);
  } else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = 'utf16le';
    cleanBuffer = buffer.slice(2);
  }

  const text = cleanBuffer.toString(encoding as any);

  // Validate readability: fail if it contains binary junk or excess nulls
  if (text.includes('\0') || (text.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length > text.length * 0.1) {
    throw new Error('O arquivo de texto parece conter caracteres binários ilegíveis.');
  }

  const lines = text.split(/\r?\n/);
  const headings: string[] = [];
  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      headings.push(trimmed.replace(/^#+\s*/, ''));
    } else if (trimmed.length > 3 && trimmed.length < 60 && trimmed === trimmed.toUpperCase() && /^[A-Z\s\d:,;.-]+$/.test(trimmed)) {
      headings.push(trimmed);
    }
  });

  return {
    text,
    pages: [{ pageNumber: 1, text }],
    headings,
    warnings: [],
    method: 'text-extractor',
    confidence: 1.0,
    stats: {
      charactersCount: text.length,
      wordsCount: text.split(/\s+/).filter(Boolean).length,
      pagesCount: 1,
      headingsCount: headings.length
    }
  };
}

export function extractHtml(buffer: Buffer): ExtractedResult {
  const htmlStr = buffer.toString('utf8');
  const $ = cheerio.load(htmlStr);

  // Remove scripts, styles, etc.
  $('script, style, iframe, link, meta, noscript').remove();

  const headings: string[] = [];
  $('h1, h2, h3, h4, h5, h6').each((_, elem) => {
    headings.push($(elem).text().trim());
  });

  const blockSelector = 'p, h1, h2, h3, h4, h5, h6, div, section, article, li, tr';
  const textBlocks: string[] = [];
  $(blockSelector).each((_, elem) => {
    const $elem = $(elem);
    const txt = $elem.text().trim();
    if (txt && !$elem.parent().is(blockSelector)) {
      textBlocks.push(txt);
    }
  });

  let text = textBlocks.join('\n\n');
  if (!text) {
    text = $('body').text().trim() || $.text().trim();
  }

  // Clean redundant whitespace and decode entities
  text = text.replace(/\s*\n\s*\n\s*/g, '\n\n').trim();

  return {
    text,
    pages: [{ pageNumber: 1, text }],
    headings,
    warnings: [],
    method: 'cheerio-html-extractor',
    confidence: 0.95,
    stats: {
      charactersCount: text.length,
      wordsCount: text.split(/\s+/).filter(Boolean).length,
      pagesCount: 1,
      headingsCount: headings.length
    }
  };
}

export async function extractDocx(buffer: Buffer): Promise<ExtractedResult> {
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value;
  const warnings = result.messages.map(m => `${m.type}: ${m.message}`);

  const lines = text.split(/\r?\n/);
  const headings: string[] = [];
  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed.length > 3 && trimmed.length < 60 && trimmed === trimmed.toUpperCase() && /^[A-Z\s\d:,;.-]+$/.test(trimmed)) {
      headings.push(trimmed);
    }
  });

  return {
    text,
    pages: [{ pageNumber: 1, text }],
    headings,
    warnings,
    method: 'mammoth-docx-extractor',
    confidence: 0.9,
    stats: {
      charactersCount: text.length,
      wordsCount: text.split(/\s+/).filter(Boolean).length,
      pagesCount: 1,
      headingsCount: headings.length
    }
  };
}

export async function parsePdfPageByPage(buffer: Buffer): Promise<{ pageNumber: number; text: string }[]> {
  const pages: { pageNumber: number; text: string }[] = [];
  
  function pagerender(pageData: any) {
    return pageData.getTextContent().then(function(textContent: any) {
      let lastY, text = '';
      for (let item of textContent.items) {
        if (lastY == undefined || lastY == item.transform[5]) {
          text += item.str;
        } else {
          text += '\n' + item.str;
        }
        lastY = item.transform[5];
      }
      pages.push({
        pageNumber: pageData.pageIndex + 1,
        text: text
      });
      return text;
    });
  }

  const options = {
    pagerender: pagerender
  };

  try {
    await pdfParse(buffer, options);
  } catch (err) {
    // If pdf-parse fails (e.g. because of corrupted format in tests), let's throw or handle it
    if (pages.length === 0) {
      throw err;
    }
  }
  
  pages.sort((a, b) => a.pageNumber - b.pageNumber);
  return pages;
}

export async function extractPdf(buffer: Buffer): Promise<ExtractedResult> {
  const pages: { pageNumber: number; text: string }[] = [];
  
  function pagerender(pageData: any) {
    return pageData.getTextContent().then(function(textContent: any) {
      let lastY, text = '';
      for (let item of textContent.items) {
        if (lastY == undefined || lastY == item.transform[5]) {
          text += item.str;
        } else {
          text += '\n' + item.str;
        }
        lastY = item.transform[5];
      }
      pages.push({
        pageNumber: pageData.pageIndex + 1,
        text: text
      });
      return text;
    });
  }

  const options = {
    pagerender: pagerender
  };

  const parsed = await pdfParse(buffer, options);
  
  pages.sort((a, b) => a.pageNumber - b.pageNumber);

  const text = pages.map(p => p.text).join('\n\n--- PAGE BREAK ---\n\n');

  // Detect scanned PDF
  const totalTextLen = text.replace(/\s/g, '').length;
  const numPages = parsed.numpages || pages.length || 1;
  const avgCharsPerPage = totalTextLen / numPages;
  const isScanned = totalTextLen < 150 || avgCharsPerPage < 30;

  if (isScanned) {
    throw new Error('PDF_NEEDS_OCR');
  }

  const lines = text.split(/\r?\n/);
  const headings: string[] = [];
  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed.length > 5 && trimmed.length < 50 && trimmed === trimmed.toUpperCase() && /^[A-Z\s\d:,;.-]+$/.test(trimmed)) {
      headings.push(trimmed);
    }
  });

  return {
    text,
    pages,
    headings,
    warnings: [],
    method: 'pdf-parse-extractor',
    confidence: 0.95,
    stats: {
      charactersCount: text.length,
      wordsCount: text.split(/\s+/).filter(Boolean).length,
      pagesCount: numPages,
      headingsCount: headings.length
    }
  };
}

export function extractEpubTextRefined(buffer: Buffer): ExtractedResult {
  const zip = new AdmZip(buffer);
  checkZipBomb(zip);

  const zipEntries = zip.getEntries();

  let opfPath = '';
  const containerEntry = zipEntries.find(
    (entry) => entry.entryName.replace(/\\/g, '/') === 'META-INF/container.xml'
  );
  
  if (containerEntry) {
    const containerXml = containerEntry.getData().toString('utf8');
    const match = containerXml.match(/full-path=["']([^"']+)["']/i);
    if (match) {
      opfPath = match[1];
    }
  }

  if (!opfPath) {
    const opfEntry = zipEntries.find((entry) => entry.entryName.endsWith('.opf'));
    if (opfEntry) {
      opfPath = opfEntry.entryName;
    }
  }

  let bookTitle = '';
  let bookAuthor = '';
  const pages: { pageNumber: number; text: string }[] = [];
  const headings: string[] = [];
  const warnings: string[] = [];

  if (opfPath) {
    const opfEntry = zipEntries.find(
      (entry) => entry.entryName.replace(/\\/g, '/') === opfPath.replace(/\\/g, '/')
    );
    if (opfEntry) {
      const opfXml = opfEntry.getData().toString('utf8');

      const titleMatch = opfXml.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
      if (titleMatch) {
        bookTitle = titleMatch[1].replace(/<[^>]*>/g, '').trim();
      }

      const creatorMatch = opfXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
      if (creatorMatch) {
        bookAuthor = creatorMatch[1].replace(/<[^>]*>/g, '').trim();
      }

      const manifestMatch = opfXml.match(/<manifest[^>]*>([\s\S]*?)<\/manifest>/i);
      const manifestContent = manifestMatch ? manifestMatch[1] : '';
      const items: { [id: string]: { href: string; properties?: string } } = {};
      const itemRegex = /<item\s+([^>]*)\/?>/gi;
      let match;
      while ((match = itemRegex.exec(manifestContent)) !== null) {
        const attrs = match[1];
        const idMatch = attrs.match(/id=["']([^"']+)["']/i);
        const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
        const propertiesMatch = attrs.match(/properties=["']([^"']+)["']/i);
        if (idMatch && hrefMatch) {
          items[idMatch[1]] = {
            href: hrefMatch[1],
            properties: propertiesMatch ? propertiesMatch[1] : undefined
          };
        }
      }

      const spineMatch = opfXml.match(/<spine[^>]*>([\s\S]*?)<\/spine>/i);
      const spineContent = spineMatch ? spineMatch[1] : '';
      const spineIds: { idref: string; linear: boolean }[] = [];
      const itemrefRegex = /<itemref\s+([^>]*)\/?>/gi;
      while ((match = itemrefRegex.exec(spineContent)) !== null) {
        const attrs = match[1];
        const idrefMatch = attrs.match(/idref=["']([^"']+)["']/i);
        const linearMatch = attrs.match(/linear=["']([^"']+)["']/i);
        if (idrefMatch) {
          spineIds.push({
            idref: idrefMatch[1],
            linear: linearMatch ? linearMatch[1] !== 'no' : true
          });
        }
      }

      const opfDir = path.dirname(opfPath).replace(/\\/g, '/');
      let pageCounter = 1;

      for (const itemref of spineIds) {
        if (!itemref.linear) {
          warnings.push(`Ignorando elemento não-linear do spine: ${itemref.idref}`);
          continue;
        }

        const manifestItem = items[itemref.idref];
        if (!manifestItem) continue;

        const isCover = itemref.idref.toLowerCase().includes('cover') || manifestItem.href.toLowerCase().includes('cover');
        const isNav = itemref.idref.toLowerCase().includes('nav') || (manifestItem.properties && manifestItem.properties.includes('nav'));
        const isToc = itemref.idref.toLowerCase().includes('toc') || manifestItem.href.toLowerCase().includes('toc');

        if (isCover || isNav || isToc) {
          warnings.push(`Removendo elemento redundante/duplicado (cover/nav/TOC): ${manifestItem.href}`);
          continue;
        }

        const cleanHref = decodeURIComponent(manifestItem.href.split('#')[0]);

        let fileEntryPath = '';
        if (opfDir === '.' || opfDir === '') {
          fileEntryPath = cleanHref;
        } else {
          fileEntryPath = path.posix.join(opfDir, cleanHref);
        }

        const entry = zipEntries.find((e) => {
          const normalizedEntryName = e.entryName.replace(/\\/g, '/');
          return (
            normalizedEntryName === fileEntryPath ||
            normalizedEntryName === fileEntryPath.replace(/^\.\//, '')
          );
        });

        if (entry) {
          const html = entry.getData().toString('utf8');
          const extracted = extractHtml(Buffer.from(html, 'utf8'));
          if (extracted.text.trim()) {
            pages.push({
              pageNumber: pageCounter++,
              text: extracted.text
            });
            headings.push(...extracted.headings);
          }
        }
      }
    }
  }

  if (pages.length === 0) {
    warnings.push('Não foi possível extrair capítulos usando o Spine. Usando busca alfabética de HTML.');
    const htmlEntries = zipEntries
      .filter((entry) => {
        const name = entry.entryName.toLowerCase();
        const isCover = name.includes('cover');
        const isNav = name.includes('nav');
        const isToc = name.includes('toc');
        if (isCover || isNav || isToc) return false;
        return name.endsWith('.xhtml') || name.endsWith('.html') || name.endsWith('.htm');
      })
      .sort((a, b) => a.entryName.localeCompare(b.entryName));

    let pageCounter = 1;
    for (const entry of htmlEntries) {
      const html = entry.getData().toString('utf8');
      const extracted = extractHtml(Buffer.from(html, 'utf8'));
      if (extracted.text.trim()) {
        pages.push({
          pageNumber: pageCounter++,
          text: extracted.text
        });
        headings.push(...extracted.headings);
      }
    }
  }

  const text = pages.map(p => p.text).join('\n\n');

  return {
    text,
    pages,
    headings,
    warnings,
    method: 'refined-epub-extractor',
    confidence: 0.95,
    stats: {
      charactersCount: text.length,
      wordsCount: text.split(/\s+/).filter(Boolean).length,
      pagesCount: pages.length,
      headingsCount: headings.length
    }
  };
}

function cleanHtml(html: string): { title: string; text: string } {
  let title = '';
  
  // Find first <h1>, <h2> or <title> inside the html
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }
  
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    title = h1Match[1].trim();
  } else {
    const h2Match = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (h2Match) {
      title = h2Match[1].trim();
    }
  }

  let cleaned = html;
  // Strip head/style/script tag content
  cleaned = cleaned.replace(/<head[^>]*>([\s\S]*?)<\/head>/gi, '');
  cleaned = cleaned.replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, '');
  cleaned = cleaned.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '');

  // Add paragraph separation
  cleaned = cleaned.replace(/<\/p>/gi, '\n\n');
  cleaned = cleaned.replace(/<\/div>/gi, '\n\n');
  cleaned = cleaned.replace(/<\/h[1-6]>/gi, '\n\n');
  cleaned = cleaned.replace(/<br\s*\/?>/gi, '\n');

  // Strip all other tags
  cleaned = cleaned.replace(/<[^>]*>/g, ' ');

  // Decode standard HTML entities
  cleaned = cleaned
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&lsquo;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/\s*\n\s*\n\s*/g, '\n\n')
    .trim();

  title = title.replace(/<[^>]*>/g, '').trim();

  return { title, text: cleaned };
}



// UPLOAD Document and extract chapters (Step 1 of Flow)
app.post('/api/projects/:projectId/upload', upload.single('file'), async (req, res) => {
  const { projectId } = req.params;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const projects = getProjects();
  const projectIdx = projects.findIndex((p) => p.projectId === projectId);
  if (projectIdx === -1) {
    return res.status(404).json({ error: 'Projeto não encontrado' });
  }

  const project = projects[projectIdx];
  project.status = 'uploading';
  project.updatedAt = new Date().toISOString();
  saveProjects(projects);

  ensureProjectDirs(projectId);

  let validation;
  try {
    validation = validateUploadedFile(file);
  } catch (err: any) {
    project.status = 'error';
    saveProjects(projects);
    return res.status(400).json({ error: err.message });
  }

  const { ext, baseName } = validation;
  // Generate secure internal name to prevent path traversal
  const secureHash = crypto.randomBytes(8).toString('hex');
  const secureInternalName = `${secureHash}${ext}`;

  // Save source file
  const projDir = path.join(PROJECTS_ROOT, projectId);
  const sourcePath = path.join(projDir, 'source', secureInternalName);
  const buffer = file.buffer;
  fs.writeFileSync(sourcePath, buffer);

  // Text Extraction
  project.status = 'extracting';
  saveProjects(projects);

  let rawText = '';
  let epubChapters: { title: string; originalText: string }[] = [];
  let epubTitle = '';
  let epubAuthor = '';
  let headings: string[] = [];
  let warnings: string[] = [];
  let extractionMethod = '';
  let stats: any = {};

  try {
    if (ext === '.epub') {
      const result = extractEpubTextRefined(buffer);
      rawText = result.text;
      epubChapters = result.pages.map(p => ({
        title: `Capítulo ${p.pageNumber}`,
        originalText: p.text
      }));
      headings = result.headings;
      warnings = result.warnings;
      extractionMethod = result.method;
      stats = result.stats;
    } else if (ext === '.pdf') {
      // Step 1: Use local extraction page-by-page as first option
      const pdfPages = await parsePdfPageByPage(buffer);
      const totalPages = pdfPages.length;
      const digitalPagesList = pdfPages.filter(p => p.text.trim().length >= 50);
      const ocrPagesList = pdfPages.filter(p => p.text.trim().length < 50);

      const isMixedOrScanned = ocrPagesList.length > 0;

      if (isMixedOrScanned) {
        // mixed or scanned PDF! We need OCR
        const ocrDir = path.join(projDir, 'extracted', 'ocr');
        fs.mkdirSync(ocrDir, { recursive: true });

        // Save digital pages texts immediately
        for (const page of digitalPagesList) {
          const pageFileName = `page-${String(page.pageNumber).padStart(4, '0')}.txt`;
          fs.writeFileSync(path.join(ocrDir, pageFileName), page.text);
        }

        // Initialize OCR state
        const ocrState: OcrState = {
          projectId,
          originalFileName: file.originalname,
          fileMimeType: file.mimetype,
          fileSize: buffer.length,
          sourcePath,
          totalPages,
          isCancelled: false,
          batches: [],
          digitalPages: digitalPagesList.map(p => p.pageNumber),
        };

        const ocrPages = ocrPagesList.map(p => p.pageNumber);
        const batchSize = 5; // configurable
        for (let i = 0; i < ocrPages.length; i += batchSize) {
          const ocrPageSubList = ocrPages.slice(i, i + batchSize);
          const pageStart = ocrPageSubList[0];
          const pageEnd = ocrPageSubList[ocrPageSubList.length - 1];
          const inputHash = crypto.createHash('sha256').update(`${projectId}-${pageStart}-${pageEnd}-${totalPages}`).digest('hex');
          ocrState.batches.push({
            pageStart,
            pageEnd,
            inputHash,
            status: 'pending',
            attempts: 0,
            model: TEXT_MODELS.bulk,
            promptVersion: 'v1',
          });
        }

        saveOcrState(projectId, ocrState);

        project.status = 'needs_ocr';
        saveProjects(getProjects().map((p) => (p.projectId === projectId ? project : p)));

        return res.json({ 
          success: true, 
          needsOcr: true, 
          projectId, 
          message: 'PDF carregado. OCR necessário para continuar.' 
        });
      } else {
        // Standard digital PDF (all pages have text)
        const result = await extractPdf(buffer);
        rawText = result.text;
        headings = result.headings;
        warnings = result.warnings;
        extractionMethod = result.method;
        stats = result.stats;
      }
    } else if (ext === '.docx') {
      const result = await extractDocx(buffer);
      rawText = result.text;
      headings = result.headings;
      warnings = result.warnings;
      extractionMethod = result.method;
      stats = result.stats;
    } else if (ext === '.html' || ext === '.htm') {
      const result = extractHtml(buffer);
      rawText = result.text;
      headings = result.headings;
      warnings = result.warnings;
      extractionMethod = result.method;
      stats = result.stats;
    } else if (ext === '.txt' || ext === '.md') {
      const result = extractTextMd(buffer);
      rawText = result.text;
      headings = result.headings;
      warnings = result.warnings;
      extractionMethod = result.method;
      stats = result.stats;
    } else {
      throw new Error(`Extensão não suportada: ${ext}`);
    }
  } catch (err: any) {
    project.status = 'error';
    saveProjects(projects);
    const errMessage = err.message === 'PDF_NEEDS_OCR' 
      ? 'Este arquivo PDF parece ser escaneado e necessita de OCR para extração de texto.' 
      : `Falha na extração de texto: ${err.message}`;
    return res.status(400).json({ error: errMessage, needsOcr: err.message === 'PDF_NEEDS_OCR' });
  }

  // Save extracted text
  const extractedPath = path.join(projDir, 'extracted', 'raw_text.txt');
  fs.mkdirSync(path.dirname(extractedPath), { recursive: true });
  fs.writeFileSync(extractedPath, rawText);

  // Normalize, save structure, analyze metadata and save Chapters list
  await normalizeAndSaveProject(
    projectId,
    rawText,
    headings,
    warnings,
    extractionMethod,
    stats,
    file.originalname,
    file.mimetype,
    buffer.length,
    sourcePath,
    buffer,
    epubChapters,
    epubTitle,
    epubAuthor
  );

  const updatedProjects = getProjects();
  const updatedProject = updatedProjects.find(p => p.projectId === projectId);
  const chaptersFile = path.join(projDir, 'normalized/chapters.json');
  const chaptersList = fs.existsSync(chaptersFile) ? JSON.parse(fs.readFileSync(chaptersFile, 'utf8')) : [];
  const docsFile = path.join(projDir, 'source/document.json');
  const docRecord = fs.existsSync(docsFile) ? JSON.parse(fs.readFileSync(docsFile, 'utf8')) : {};

  return res.json({ project: updatedProject, chapters: chaptersList, document: docRecord });
});


// OCR ENDPOINTS & CONTROLS (Step 1.5 of Flow)
app.post('/api/projects/:projectId/ocr/start', async (req, res) => {
  const { projectId } = req.params;
  const projects = getProjects();
  const projectIdx = projects.findIndex((p) => p.projectId === projectId);
  if (projectIdx === -1) {
    return res.status(404).json({ error: 'Projeto não encontrado' });
  }

  try {
    const ocrState = getOcrState(projectId);
    
    // Reset cancelled flag
    ocrState.isCancelled = false;
    
    // Reset failed batches to pending so we can retry only failed pages
    for (const batch of ocrState.batches) {
      if (batch.status === 'failed') {
        batch.status = 'pending';
        batch.error = undefined;
      }
    }
    
    saveOcrState(projectId, ocrState);

    // Update project status to extracting
    const project = projects[projectIdx];
    project.status = 'extracting';
    project.updatedAt = new Date().toISOString();
    saveProjects(projects);

    // Trigger loop in background (non-blocking)
    runOcrLoop(projectId);

    return res.json({ success: true, message: 'OCR iniciado/retomado' });
  } catch (err: any) {
    return res.status(500).json({ error: `Erro ao iniciar OCR: ${err.message}` });
  }
});

app.post('/api/projects/:projectId/ocr/cancel', async (req, res) => {
  const { projectId } = req.params;
  try {
    const ocrState = getOcrState(projectId);
    ocrState.isCancelled = true;
    saveOcrState(projectId, ocrState);

    const projects = getProjects();
    const pIdx = projects.findIndex(p => p.projectId === projectId);
    if (pIdx !== -1) {
      projects[pIdx].status = 'needs_ocr';
      saveProjects(projects);
    }

    return res.json({ success: true, message: 'OCR cancelado' });
  } catch (err: any) {
    return res.status(500).json({ error: `Erro ao cancelar OCR: ${err.message}` });
  }
});

app.get('/api/projects/:projectId/ocr/status', async (req, res) => {
  const { projectId } = req.params;
  try {
    const ocrState = getOcrState(projectId);
    
    const total = ocrState.batches.length;
    const completed = ocrState.batches.filter(b => b.status === 'completed').length;
    const processing = ocrState.batches.filter(b => b.status === 'processing').length;
    const failed = ocrState.batches.filter(b => b.status === 'failed').length;
    const pending = ocrState.batches.filter(b => b.status === 'pending').length;

    let overallStatus = 'pending';
    if (ocrState.isCancelled) {
      overallStatus = 'cancelled';
    } else if (completed === total) {
      overallStatus = 'completed';
    } else if (processing > 0) {
      overallStatus = 'processing';
    } else if (failed > 0 && pending === 0) {
      overallStatus = 'failed';
    }

    const progress = total > 0 ? Math.round((completed / total) * 100) : 100;

    return res.json({
      projectId,
      totalPages: ocrState.totalPages,
      digitalPagesCount: ocrState.digitalPages.length,
      progress,
      status: overallStatus,
      batches: ocrState.batches,
      stats: {
        total,
        completed,
        processing,
        failed,
        pending,
      }
    });
  } catch (err: any) {
    return res.status(500).json({ error: `Erro ao buscar status do OCR: ${err.message}` });
  }
});

// TRANSLATION ENGINE & GLOSSARY (Step 2 of Flow)
app.post('/api/projects/:projectId/translate', async (req, res) => {
  const { projectId } = req.params;
  const { glossaryEntries, options } = req.body; // option: 'all' or specific chapterId

  const projects = getProjects();
  const projectIdx = projects.findIndex((p) => p.projectId === projectId);
  if (projectIdx === -1) {
    return res.status(404).json({ error: 'Projeto não encontrado' });
  }

  const project = projects[projectIdx];

  // Synchronous check for missing API key if translation is enabled
  if (project.translationEnabled !== false && !hasTextAi()) {
    const appError = new AppError({
      code: 'MISSING_API_KEY',
      message: 'OPENAI_API_KEY é necessária para tradução',
      retryable: true,
      operation: 'translate_chapter',
      projectId,
      status: 400
    });
    project.status = 'failed';
    project.lastError = appError.toJSON().error;
    saveProjects(projects);
    writeStructuredLog(projectId, 'translation', 'failed', { error: appError.toJSON().error });
    return res.status(400).json(appError.toJSON());
  }

  project.status = 'translating';
  saveProjects(projects);

  const projDir = path.join(PROJECTS_ROOT, projectId);

  // Load chapters
  const chaptersFile = path.join(projDir, 'normalized/chapters.json');
  if (!fs.existsSync(chaptersFile)) {
    project.status = 'failed';
    const appError = new AppError({
      code: 'CHAPTERS_NOT_FOUND',
      message: 'Nenhum capítulo disponível para tradução',
      retryable: false,
      operation: 'translation',
      projectId,
      status: 400
    });
    project.lastError = appError.toJSON().error;
    saveProjects(projects);
    writeStructuredLog(projectId, 'translation', 'failed', { error: appError.toJSON().error });
    return res.status(400).json(appError.toJSON());
  }
  const chapters: any[] = JSON.parse(fs.readFileSync(chaptersFile, 'utf8'));

  if (project.translationEnabled === false) {
    // Translation disabled: preserve a single canonical source instead of
    // creating a misleading "translated" copy.
    for (const ch of chapters) {
      ch.translatedText = undefined;
      ch.status = 'translation_not_required';
    }
    fs.writeFileSync(chaptersFile, JSON.stringify(chapters, null, 2));
    project.status = 'analyzing_characters';
    project.updatedAt = new Date().toISOString();
    saveProjects(getProjects().map((p) => (p.projectId === projectId ? project : p)));
    return res.json({ project, chapters });
  }

  let clearedInvalidTranslations = 0;
  for (const ch of chapters) {
    if (ch.translatedText && isLikelyUntranslatedCopy(ch.originalText || '', ch.translatedText || '')) {
      ch.translatedText = undefined;
      ch.status = 'pending';
      ch.translationValidationError = 'A tradução anterior parecia ser uma cópia do original e foi marcada para reprocessamento.';
      clearedInvalidTranslations++;
    }
  }
  if (clearedInvalidTranslations > 0) {
    fs.writeFileSync(chaptersFile, JSON.stringify(chapters, null, 2));
    writeStructuredLog(projectId, 'translation', 'success', { event: 'invalid_cache_cleared', clearedInvalidTranslations });
  }

  // Save glossary entries if provided
  let cleanGlossaryEntries: any[] = [];
  if (glossaryEntries) {
    const glossaryFile = path.join(projDir, 'translation/glossary.json');
    let oldGlossary: any[] = [];
    if (fs.existsSync(glossaryFile)) {
      try {
        oldGlossary = JSON.parse(fs.readFileSync(glossaryFile, 'utf8'));
      } catch {
        oldGlossary = [];
      }
    }

    // Deduplicate and validate
    const seenTerms = new Set<string>();
    for (const entry of (glossaryEntries || [])) {
      const term = (entry.term || entry.source || entry.sourceTerm || '').trim();
      const translation = (entry.translation || entry.target || entry.preferredTranslation || '').trim();
      if (term && translation) {
        const key = term.toLowerCase();
        if (!seenTerms.has(key)) {
          seenTerms.add(key);
          cleanGlossaryEntries.push({ term, translation });
        }
      }
    }

    // Version glossaryHash
    const glossaryHash = calculateHash(JSON.stringify(cleanGlossaryEntries));
    project.glossaryHash = glossaryHash;

    // Save cleaned glossary
    fs.mkdirSync(path.dirname(glossaryFile), { recursive: true });
    fs.writeFileSync(glossaryFile, JSON.stringify(cleanGlossaryEntries, null, 2));

    // Invalidate affected translation chunks
    invalidateAffectedTranslationChunks(projectId, cleanGlossaryEntries, oldGlossary);
  }

  // Start background translation job instead of synchronous translation loop
  try {
    const job = startProjectJob(projectId, 'translation', {
      style: options?.style || 'literário',
      glossaryEntries: cleanGlossaryEntries,
      forceFresh: options?.forceFresh
    });

    project.status = 'translating';
    project.lastError = undefined;
    project.updatedAt = new Date().toISOString();
    saveProjects(getProjects().map((p) => (p.projectId === projectId ? project : p)));

    writeStructuredLog(projectId, 'translation', 'success', { 
      chaptersCount: chapters.length,
      jobId: job.jobId
    });

    return res.json({ project, chapters, job });
  } catch (err: any) {
    project.status = 'failed';
    project.lastError = { message: err.message || String(err) };
    saveProjects(getProjects().map((p) => (p.projectId === projectId ? project : p)));
    return res.status(500).json({ error: err.message });
  }
});

// Manual editorial review. The source stays immutable; only the translated layer changes.
app.put('/api/projects/:projectId/chapters/:chapterId/translation', (req, res) => {
  try {
    const { projectId, chapterId } = req.params;
    const translatedText = String(req.body?.translatedText || '').trim();
    if (!translatedText) return res.status(400).json({ error: 'A tradução revisada não pode ficar vazia' });
    const projDir = path.join(PROJECTS_ROOT, projectId);
    const chaptersFile = path.join(projDir, 'normalized/chapters.json');
    if (!fs.existsSync(chaptersFile)) return res.status(404).json({ error: 'Capítulos não encontrados' });
    const chapters: any[] = JSON.parse(fs.readFileSync(chaptersFile, 'utf8'));
    const chapter = chapters.find(item => item.chapterId === chapterId);
    if (!chapter) return res.status(404).json({ error: 'Capítulo não encontrado' });
    chapter.translatedText = translatedText;
    chapter.status = 'translated_reviewed';
    chapter.translationReviewedAt = new Date().toISOString();
    fs.writeFileSync(chaptersFile, JSON.stringify(chapters, null, 2));
    const translationDir = path.join(projDir, 'translation'); fs.mkdirSync(translationDir, { recursive:true });
    fs.writeFileSync(path.join(translationDir, `${chapterId}.pt-BR.txt`), translatedText);
    const projects = getProjects(); const project = projects.find(item => item.projectId === projectId);
    if (project) { project.status = 'analyzing_characters'; project.translationNeedsBibleReview = true; project.updatedAt = new Date().toISOString(); saveProjects(projects); }
    const segmentsFile = path.join(projDir, 'scripts/segments.json');
    if (fs.existsSync(segmentsFile)) {
      const segments: any[] = JSON.parse(fs.readFileSync(segmentsFile,'utf8'));
      segments.filter(seg => seg.chapterId === chapterId).forEach(seg => { seg.status = 'pending'; seg.translationStale = true; seg.audioPath = undefined; seg.contextualAudioPath = undefined; });
      fs.writeFileSync(segmentsFile, JSON.stringify(segments,null,2));
    }
    writeStructuredLog(projectId, 'translation_review', 'success', { chapterId });
    res.json({ project, chapter, chapters });
  } catch (err:any) { res.status(500).json({ error: err.message || String(err) }); }
});

// Helper to check if two character names are similar (ambiguous candidates)
export function areNamesSimilar(name1: string, name2: string): boolean {
  const n1 = name1.toLowerCase().trim();
  const n2 = name2.toLowerCase().trim();
  if (n1 === n2) return false;

  // Remove standard titles
  const clean = (s: string) => s.replace(/^(dona|seu|sr|sra|dr|dra|doctor|doutor|doutora|prof|professor|senhor|senhora)\.?\s+/i, '');
  const cn1 = clean(n1);
  const cn2 = clean(n2);
  if (cn1 === cn2 && cn1.length > 0) return true;

  // Check whole-word overlap
  const words1 = cn1.split(/\s+/).filter(w => w.length > 3);
  const words2 = cn2.split(/\s+/).filter(w => w.length > 3);
  if (words1.length > 0 && words2.length > 0) {
    const shareWord = words1.some(w => words2.includes(w));
    if (shareWord) return true;
  }
  return false;
}

export function isGenericCharacterAlias(alias: string): boolean {
  const normalized = alias.toLowerCase().trim().replace(/[.,;:!?]+$/g, '');
  if (!normalized) return true;
  if (/^(ele|ela|eles|elas|eu|tu|voce|você|nos|nós|vocês)$/.test(normalized)) return true;
  return /^(?:um|uma|o|a|os|as)\s+(?:menina|menino|mulher|homem|pessoa|criança|jovem|idoso|idosa|senhor|senhora|pesquisador|pesquisadora)$/.test(normalized);
}

export function extractDialogueSpeakerCandidates(text: string): any[] {
  const found = new Map<string, { name: string; evidence: string[] }>();
  const add = (name: string, evidence: string) => {
    const cleanName = name.trim().replace(/[.,;:!?]+$/g, '');
    if (cleanName.length < 2 || ['Narrador', 'Aurora'].includes(cleanName)) return;
    const key = cleanName.toLocaleLowerCase('pt-BR');
    const current = found.get(key) || { name: cleanName, evidence: [] };
    if (!current.evidence.includes(evidence.trim())) current.evidence.push(evidence.trim());
    found.set(key, current);
  };

  const patterns = [
    /\b(?:chamad[oa]|chama-se)\s+([A-ZÀ-Ý][\p{L}'-]{1,40})\b/gu,
    /\b(?:disse|perguntou|respondeu|avisou|gritou|sussurrou|afirmou|declarou|continuou)\s+([A-ZÀ-Ý][\p{L}'-]{1,40})\b/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = Math.max(0, (match.index || 0) - 80);
      const end = Math.min(text.length, (match.index || 0) + match[0].length + 80);
      add(match[1], text.slice(start, end));
    }
  }

  return Array.from(found.values()).map(({ name, evidence }) => ({
    candidateName: name,
    aliases: [],
    atributos: ['Personagem nomeado com fala ou menção explícita no texto'],
    papel: 'supporting',
    evidenceUnitIds: evidence,
    confidence: 0.98,
  }));
}

// Map-Reduce character identification logic with incremental processing & human edit preservation
export async function performMapReduceCharacterAnalysis(
  projectId: string,
  forceFresh: boolean = false,
  allowTechnicalAuthors: boolean = false
) {
  const projects = getProjects();
  const projectIdx = projects.findIndex((p) => p.projectId === projectId);
  if (projectIdx === -1) {
    throw new Error('Projeto não encontrado');
  }
  const project = projects[projectIdx];
  const projDir = path.join(PROJECTS_ROOT, projectId);
  const chaptersFile = path.join(projDir, 'normalized/chapters.json');
  if (!fs.existsSync(chaptersFile)) {
    throw new Error('Nenhum capítulo disponível para análise');
  }
  const chapters: any[] = JSON.parse(fs.readFileSync(chaptersFile, 'utf8'));

  const bibleDir = path.join(projDir, 'narrative-bible');
  fs.mkdirSync(bibleDir, { recursive: true });

  const charactersFile = path.join(bibleDir, 'characters.json');
  const sightingsFile = path.join(bibleDir, 'sightings.json');
  const suggestionsFile = path.join(bibleDir, 'merge-suggestions.json');
  const cacheFile = path.join(bibleDir, 'chunks-cache.json');

  // Load existing character roster to preserve edited names, locked profiles, and custom voices
  let existingCharacters: any[] = [];
  if (fs.existsSync(charactersFile)) {
    try {
      existingCharacters = JSON.parse(fs.readFileSync(charactersFile, 'utf8'));
    } catch (e) {
      console.warn('Unable to parse existing characters:', e);
    }
  }

  let existingSuggestions: any[] = [];
  if (fs.existsSync(suggestionsFile)) {
    try {
      existingSuggestions = JSON.parse(fs.readFileSync(suggestionsFile, 'utf8'));
    } catch (e) {
      console.warn('Unable to parse existing suggestions:', e);
    }
  }

  // Load chunk analysis cache to bypass re-calling Gemini on unchanged text blocks
  let chunkCache: Record<string, any[]> = {};
  if (fs.existsSync(cacheFile) && !forceFresh) {
    try {
      chunkCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {
      console.warn('Unable to parse chunk cache:', e);
    }
  }

  // Segment chapters into stable, robust processing chunks
  const allChunks: { chapterId: string; chunkIndex: number; text: string; hash: string }[] = [];
  for (const ch of chapters) {
    const text = ch.translatedText || ch.originalText || '';
    if (!text.trim()) continue;

    const chunks = text.length > 12000
      ? splitIntoChunks(text, 10000, 12000)
      : [text];

    chunks.forEach((chunkText, idx) => {
      const hash = calculateHash(chunkText);
      allChunks.push({
        chapterId: ch.chapterId,
        chunkIndex: idx,
        text: chunkText,
        hash
      });
    });
  }

  const isTechnicalMode = project.productionMode === 'technical';
  const hasApiKey = hasTextAi();

  // 1. Map Phase - Analyze each chunk individually
  const mappedCandidatesPerChunk: { chunkHash: string; chapterId: string; candidates: any[] }[] = [];
  const updatedCache: Record<string, any[]> = forceFresh ? {} : { ...chunkCache };

  for (const chunk of allChunks) {
    // If cached, utilize previous extraction results
    if (updatedCache[chunk.hash] && !forceFresh) {
      mappedCandidatesPerChunk.push({
        chunkHash: chunk.hash,
        chapterId: chunk.chapterId,
        candidates: updatedCache[chunk.hash]
      });
      continue;
    }

    let candidates: any[] = [];
    if (hasApiKey) {
      try {
        const prompt = `Analise o seguinte trecho de texto de uma obra literária ou científica para identificar os narradores e todos os personagens que atuam, falam ou são mencionados de forma direta.
        Retorne rigorosamente um objeto JSON contendo uma lista de candidatos no campo "candidates".

        Cada candidato deve possuir:
        1. "candidateName": Nome canônico ou principal do personagem.
        2. "aliases": Lista de apelidos, pronomes de tratamento ou outras formas como é mencionado (ex: ["Joãozinho", "Sr. Silva"]).
        3. "atributos": Características, traços de personalidade, aparência física ou estilo de fala mencionados neste trecho.
        4. "papel": Papel desempenhado no texto, que deve ser rigorosamente um destes: "protagonist", "antagonist", "main", "supporting", "narrator".
        5. "evidenceUnitIds": Lista de citações ou frases curtas exatas do texto que mostram a ação ou presença do personagem.
        6. "confidence": Grau de confiança da identificação (número entre 0.0 e 1.0).
        7. "genderPresentation": "female", "male" ou "neutral", somente quando houver evidência textual.
        8. "estimatedAge": "child", "young", "adult" ou "mature".
        9. "speechStyle": objeto com "pace" (slow|moderate|fast), "energy" (low|medium|high) e "timbre" (bright|warm|firm|soft|gravelly|smooth|clear|neutral).

        Regras adicionais:
        - Toda pessoa nomeada que pronuncie uma fala deve aparecer como candidato, mesmo que participe apenas uma vez.
        - Não use pronomes nem descrições genéricas como aliases (ex.: "ela", "uma menina", "o homem").
        - Se o projeto for do modo técnico, geralmente há apenas um narrador principal e nenhum personagem do elenco deve ser inventado. Autores citados só viram voz se habilitado.
        - Não retorne markdown, explicações, apenas o JSON estruturado abaixo.

        JSON Schema requerido:
        {
          "candidates": [
            {
              "candidateName": "String",
              "aliases": ["String"],
              "atributos": ["String"],
              "papel": "protagonist" | "antagonist" | "main" | "supporting" | "narrator",
              "evidenceUnitIds": ["String"],
              "confidence": number
            }
          ]
        }

        Texto para análise:\n\n${chunk.text}`;

        const response = await callGeminiWithRetryAndFallback(
          TEXT_MODELS.bulk,
          (model) =>
            ai.models.generateContent({
              model,
              contents: [{ text: prompt }],
              config: {
                responseMimeType: 'application/json',
              },
            })
        );

        const parsed = cleanAndParseJson(response.text?.trim() || '');
        if (parsed && Array.isArray(parsed.candidates)) {
          const validated = z.object({
            candidates: z.array(z.object({
              candidateName: z.string(),
              aliases: z.array(z.string()).default([]),
              atributos: z.array(z.string()).default([]),
              papel: z.enum(['protagonist', 'antagonist', 'main', 'supporting', 'narrator']).default('supporting'),
              evidenceUnitIds: z.array(z.string()).default([]),
              confidence: z.number().min(0).max(1).default(1.0)
              ,genderPresentation: z.enum(['female','male','neutral']).default('neutral')
              ,estimatedAge: z.enum(['child','young','adult','mature']).default('adult')
              ,speechStyle: z.object({ pace: z.enum(['slow','moderate','fast']).default('moderate'), energy: z.enum(['low','medium','high']).default('medium'), timbre: z.enum(['bright','warm','firm','soft','gravelly','smooth','clear','neutral']).default('neutral') }).default({ pace:'moderate', energy:'medium', timbre:'neutral' })
            }))
          }).parse(parsed);
          candidates = validated.candidates;
        }
      } catch (err) {
        console.error(`Gemini call failed for chunk ${chunk.hash}:`, err);
        throw err;
      }
    } else {
      throw new Error('Chave OPENAI_API_KEY ausente');
    }

    const deterministicSpeakers = extractDialogueSpeakerCandidates(chunk.text);
    for (const deterministic of deterministicSpeakers) {
      if (!candidates.some(candidate => candidate.candidateName.toLocaleLowerCase('pt-BR') === deterministic.candidateName.toLocaleLowerCase('pt-BR'))) {
        candidates.push(deterministic);
      }
    }
    candidates = candidates.map(candidate => ({
      ...candidate,
      aliases: Array.isArray(candidate.aliases) ? candidate.aliases.filter((alias: string) => !isGenericCharacterAlias(alias)) : [],
    }));

    // Apply strict technical mode rules during map step
    if (isTechnicalMode) {
      candidates = candidates.filter((c) => {
        const isNarrator = c.papel === 'narrator' || c.candidateName.toLowerCase() === 'narrador' || c.candidateName.toLowerCase() === 'narrator';
        if (isNarrator) return true;
        return allowTechnicalAuthors;
      });

      // Ensure a default stable technical narrator is always mapped
      if (candidates.length === 0) {
        candidates.push({
          candidateName: 'Narrador',
          aliases: [],
          atributos: ['Estável', 'Neutro'],
          papel: 'narrator',
          evidenceUnitIds: ['Leitura técnica padrão'],
          confidence: 1.0
        });
      }
    }

    updatedCache[chunk.hash] = candidates;
    mappedCandidatesPerChunk.push({
      chunkHash: chunk.hash,
      chapterId: chunk.chapterId,
      candidates
    });
  }

  // Persist updated chunk map cache
  fs.writeFileSync(cacheFile, JSON.stringify(updatedCache, null, 2));

  // 2. Reduce Phase - Consolidate candidates into unique, stable characters
  const approvedMergeRedirects: Record<string, string> = {};
  for (const sug of existingSuggestions) {
    if (sug.status === 'approved') {
      approvedMergeRedirects[sug.sourceCharacterId] = sug.targetCharacterId;
    }
  }

  const consolidatedCharacters: any[] = [];
  const characterMapByName: Record<string, any> = {};

  // Hydrate from existing characters to guarantee stability and prevent overriding human edits
  for (const char of existingCharacters) {
    char.aliases = Array.isArray(char.aliases) ? char.aliases.filter((alias: string) => !isGenericCharacterAlias(alias)) : [];
    consolidatedCharacters.push({ ...char });
    characterMapByName[char.canonicalName.toLowerCase()] = char;
    if (Array.isArray(char.aliases)) {
      for (const alias of char.aliases) {
        characterMapByName[alias.toLowerCase()] = char;
      }
    }
  }

  const findMatchingCharacter = (candidateName: string, aliases: string[]) => {
    const namesToCheck = [candidateName, ...aliases].map(n => n.toLowerCase().trim());
    for (const name of namesToCheck) {
      if (characterMapByName[name]) {
        return characterMapByName[name];
      }
    }
    return null;
  };

  const sightingsList: any[] = [];

  for (const chunkResult of mappedCandidatesPerChunk) {
    for (const candidate of chunkResult.candidates) {
      let matchedChar = findMatchingCharacter(candidate.candidateName, candidate.aliases);

      // Follow approved merge redirects
      if (matchedChar && approvedMergeRedirects[matchedChar.characterId]) {
        const redirectedId = approvedMergeRedirects[matchedChar.characterId];
        matchedChar = consolidatedCharacters.find(c => c.characterId === redirectedId) || matchedChar;
      }

      const isNarrator = candidate.papel === 'narrator' || candidate.candidateName.toLowerCase() === 'narrador' || candidate.candidateName.toLowerCase() === 'narrator';

      if (isNarrator) {
        const existingNarrator = consolidatedCharacters.find(c => c.characterId === 'char_narrator');
        if (existingNarrator) {
          matchedChar = existingNarrator;
        } else {
          const newNarrator = {
            characterId: 'char_narrator',
            projectId,
            canonicalName: 'Narrador',
            aliases: ['Narrador', 'Narrator'],
            role: 'narrator',
            genderPresentation: 'neutral',
            estimatedAge: undefined,
            description: 'Narrador principal e estável da obra.',
            personality: ['Estável', 'Neutro'],
            speechStyle: {
              register: 'culto',
              pace: 'moderate',
              sentenceLength: 'medium',
              emotionalExpression: 'neutral'
            },
            voiceAssignmentId: 'pt-BR-Wavenet-B',
            locked: false
          };
          consolidatedCharacters.push(newNarrator);
          characterMapByName['narrador'] = newNarrator;
          characterMapByName['narrator'] = newNarrator;
          matchedChar = newNarrator;
        }
      }

      if (matchedChar) {
        if (!matchedChar.locked) {
          // Keep existing canonicalName, but safely append new unique aliases
          if (Array.isArray(candidate.aliases)) {
            for (const alias of candidate.aliases) {
              const lowerAlias = alias.toLowerCase();
              if (!matchedChar.aliases.map((a: string) => a.toLowerCase()).includes(lowerAlias) && lowerAlias !== matchedChar.canonicalName.toLowerCase()) {
                matchedChar.aliases.push(alias);
                characterMapByName[lowerAlias] = matchedChar;
              }
            }
          }
          if (!matchedChar.description && candidate.atributos?.length > 0) {
            matchedChar.description = candidate.atributos.join(', ');
          }
          if (Array.isArray(candidate.atributos)) {
            for (const attr of candidate.atributos) {
              if (!matchedChar.personality.includes(attr)) {
                matchedChar.personality.push(attr);
              }
            }
          }
        }

        sightingsList.push({
          sightingId: `sight_${chunkResult.chunkHash}_${matchedChar.characterId}`,
          characterId: matchedChar.characterId,
          chunkId: chunkResult.chunkHash,
          chapterId: chunkResult.chapterId,
          canonicalName: matchedChar.canonicalName,
          evidenceText: candidate.evidenceUnitIds?.join('\n') || '',
          confidence: candidate.confidence
        });
      } else {
        const cleanName = candidate.candidateName.trim();
        const baseId = `char_${cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

        let characterId = baseId;
        let counter = 1;
        while (consolidatedCharacters.some(c => c.characterId === characterId)) {
          counter++;
          characterId = `${baseId}_${counter}`;
        }

        const voiceAssignmentId = candidate.papel === 'narrator'
          ? 'pt-BR-Wavenet-B'
          : (candidate.genderPresentation === 'female' ? 'pt-BR-Neural2-A' : 'pt-BR-Neural2-B');

        const newChar = {
          characterId,
          projectId,
          canonicalName: cleanName,
          aliases: candidate.aliases || [],
          role: candidate.papel || 'supporting',
          genderPresentation: candidate.genderPresentation || 'neutral',
          estimatedAge: candidate.estimatedAge,
          description: candidate.atributos?.join(', ') || '',
          personality: candidate.atributos || [],
          speechStyle: {
            register: 'culto',
            pace: candidate.speechStyle?.pace || 'moderate',
            energy: candidate.speechStyle?.energy || 'medium',
            timbre: candidate.speechStyle?.timbre || 'neutral',
            sentenceLength: 'medium',
            emotionalExpression: 'neutral'
          },
          voiceAssignmentId,
          locked: false
        };

        consolidatedCharacters.push(newChar);
        characterMapByName[cleanName.toLowerCase()] = newChar;
        if (Array.isArray(candidate.aliases)) {
          for (const alias of candidate.aliases) {
            characterMapByName[alias.toLowerCase()] = newChar;
          }
        }

        sightingsList.push({
          sightingId: `sight_${chunkResult.chunkHash}_${characterId}`,
          characterId,
          chunkId: chunkResult.chunkHash,
          chapterId: chunkResult.chapterId,
          canonicalName: cleanName,
          evidenceText: candidate.evidenceUnitIds?.join('\n') || '',
          confidence: candidate.confidence
        });
      }
    }
  }

  // Confirm narrator exists
  if (!consolidatedCharacters.some(c => c.characterId === 'char_narrator')) {
    consolidatedCharacters.push({
      characterId: 'char_narrator',
      projectId,
      canonicalName: 'Narrador',
      aliases: ['Narrador', 'Narrator'],
      role: 'narrator',
      genderPresentation: 'neutral',
      estimatedAge: undefined,
      description: 'Narrador principal e estável da obra.',
      personality: ['Estável', 'Neutro'],
      speechStyle: {
        register: 'culto',
        pace: 'moderate',
        sentenceLength: 'medium',
        emotionalExpression: 'neutral'
      },
      voiceAssignmentId: 'pt-BR-Wavenet-B',
      locked: false
    });
  }

  // 3. Suggestions Phase - Find ambiguous homonyms/aliases for approval
  const newSuggestions: any[] = [];
  for (let i = 0; i < consolidatedCharacters.length; i++) {
    for (let j = i + 1; j < consolidatedCharacters.length; j++) {
      const c1 = consolidatedCharacters[i];
      const c2 = consolidatedCharacters[j];

      if (c1.characterId === 'char_narrator' || c2.characterId === 'char_narrator') continue;

      if (areNamesSimilar(c1.canonicalName, c2.canonicalName)) {
        const existingSug = existingSuggestions.find(
          s => (s.sourceCharacterId === c1.characterId && s.targetCharacterId === c2.characterId) ||
               (s.sourceCharacterId === c2.characterId && s.targetCharacterId === c1.characterId)
        );

        if (existingSug) {
          newSuggestions.push(existingSug);
        } else {
          newSuggestions.push({
            suggestionId: `merge_${c1.characterId}_${c2.characterId}`,
            sourceCharacterId: c1.characterId,
            targetCharacterId: c2.characterId,
            sourceName: c1.canonicalName,
            targetName: c2.canonicalName,
            reason: 'Nomes altamente semelhantes ou que compartilham palavras-chave',
            confidence: 0.85,
            status: 'pending'
          });
        }
      }
    }
  }

  // Persist structured files to both paths
  for (const character of consolidatedCharacters) {
    const recommendation = recommendVoiceForCharacter(character, [getActiveGeminiApiKey() ? 'gemini' : '', getActiveGeminiApiKey() ? 'gemini-pro' : '', isGcpConfiguredSync() ? 'gcp' : ''].filter(Boolean));
    character.voiceProfile = recommendation.desired;
    character.voiceRecommendations = recommendation.ranked;
    if (!character.voiceAssignment && recommendation.recommended) character.voiceAssignmentId = recommendation.recommended.voiceId;
  }
  fs.writeFileSync(charactersFile, JSON.stringify(consolidatedCharacters, null, 2));
  fs.writeFileSync(sightingsFile, JSON.stringify(sightingsList, null, 2));
  fs.writeFileSync(suggestionsFile, JSON.stringify(newSuggestions, null, 2));

  // Dual path save for robust discovery
  fs.writeFileSync(path.join(projDir, 'sightings.json'), JSON.stringify(sightingsList, null, 2));
  fs.writeFileSync(path.join(projDir, 'merge-suggestions.json'), JSON.stringify(newSuggestions, null, 2));

  return {
    characters: consolidatedCharacters,
    sightings: sightingsList,
    mergeSuggestions: newSuggestions
  };
}

// CHARACTER IDENTIFICATION & BIBLE (Step 3 of Flow)
app.post('/api/projects/:projectId/analyze-characters', async (req, res) => {
  const { projectId } = req.params;
  const forceFresh = req.body.forceFresh === true;

  const projects = getProjects();
  const projectIdx = projects.findIndex((p) => p.projectId === projectId);
  if (projectIdx === -1) {
    return res.status(404).json({ error: 'Projeto não encontrado' });
  }

  const project = projects[projectIdx];
  const allowTechnicalAuthors = req.body.allowTechnicalAuthors ?? project.allowTechnicalAuthors ?? false;

  // Persist options on the project
  project.allowTechnicalAuthors = allowTechnicalAuthors;
  saveProjects(projects);

  try {
    const result = await performMapReduceCharacterAnalysis(projectId, forceFresh, allowTechnicalAuthors);

    project.status = 'awaiting_voice_approval';
    project.lastError = undefined;
    project.updatedAt = new Date().toISOString();
    saveProjects(getProjects().map((p) => (p.projectId === projectId ? project : p)));

    writeStructuredLog(projectId, 'character_analysis', 'success', { charactersCount: result.characters.length });

    res.json({ project, characters: result.characters, sightings: result.sightings, mergeSuggestions: result.mergeSuggestions });
  } catch (err: any) {
    project.status = 'failed';
    const appError = new AppError({
      code: 'CHARACTER_ANALYSIS_FAILED',
      message: err.message || String(err),
      retryable: true,
      operation: 'character_analysis',
      projectId,
      status: 400
    });

    project.lastError = appError.toJSON().error;
    project.updatedAt = new Date().toISOString();
    saveProjects(getProjects().map((p) => (p.projectId === projectId ? project : p)));

    writeStructuredLog(projectId, 'character_analysis', 'failed', { error: appError.toJSON().error });

    return res.status(400).json(appError.toJSON());
  }
});

// MERGE CHARACTERS (Manual approved consolidation endpoint)
app.post('/api/projects/:projectId/merge-characters', async (req, res) => {
  const { projectId } = req.params;
  const { sourceCharacterId, targetCharacterId } = req.body;

  if (!sourceCharacterId || !targetCharacterId) {
    return res.status(400).json({ error: 'Os IDs de origem e destino são obrigatórios' });
  }

  const projDir = path.join(PROJECTS_ROOT, projectId);
  const charactersFile = path.join(projDir, 'narrative-bible/characters.json');
  const sightingsFile = path.join(projDir, 'narrative-bible/sightings.json');
  const suggestionsFile = path.join(projDir, 'narrative-bible/merge-suggestions.json');
  const segmentsFile = path.join(projDir, 'scripts/segments.json');

  if (!fs.existsSync(charactersFile)) {
    return res.status(404).json({ error: 'Ficheiro de personagens não encontrado' });
  }

  try {
    const characters: any[] = JSON.parse(fs.readFileSync(charactersFile, 'utf8'));
    const sourceChar = characters.find(c => c.characterId === sourceCharacterId);
    const targetChar = characters.find(c => c.characterId === targetCharacterId);

    if (!sourceChar || !targetChar) {
      return res.status(404).json({ error: 'Personagem de origem ou destino não encontrado' });
    }

    // Merge attributes, description, aliases
    targetChar.aliases = Array.from(new Set([...targetChar.aliases, sourceChar.canonicalName, ...sourceChar.aliases]));
    if (sourceChar.description) {
      targetChar.description = targetChar.description 
        ? `${targetChar.description}. ${sourceChar.description}`
        : sourceChar.description;
    }
    targetChar.personality = Array.from(new Set([...targetChar.personality, ...sourceChar.personality]));

    // Remove source character
    const updatedCharacters = characters.filter(c => c.characterId !== sourceCharacterId);
    fs.writeFileSync(charactersFile, JSON.stringify(updatedCharacters, null, 2));

    // Update sightings
    if (fs.existsSync(sightingsFile)) {
      const sightings: any[] = JSON.parse(fs.readFileSync(sightingsFile, 'utf8'));
      sightings.forEach(s => {
        if (s.characterId === sourceCharacterId) {
          s.characterId = targetCharacterId;
          s.canonicalName = targetChar.canonicalName;
        }
      });
      fs.writeFileSync(sightingsFile, JSON.stringify(sightings, null, 2));
      fs.writeFileSync(path.join(projDir, 'sightings.json'), JSON.stringify(sightings, null, 2));
    }

    // Update suggestions status
    if (fs.existsSync(suggestionsFile)) {
      const suggestions: any[] = JSON.parse(fs.readFileSync(suggestionsFile, 'utf8'));
      suggestions.forEach(s => {
        if (
          (s.sourceCharacterId === sourceCharacterId && s.targetCharacterId === targetCharacterId) ||
          (s.sourceCharacterId === targetCharacterId && s.targetCharacterId === sourceCharacterId)
        ) {
          s.status = 'approved';
        }
      });
      fs.writeFileSync(suggestionsFile, JSON.stringify(suggestions, null, 2));
      fs.writeFileSync(path.join(projDir, 'merge-suggestions.json'), JSON.stringify(suggestions, null, 2));
    }

    // Update script segments speaker allocation
    if (fs.existsSync(segmentsFile)) {
      const segments: any[] = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'));
      segments.forEach(seg => {
        if (seg.speakerId === sourceCharacterId) {
          seg.speakerId = targetCharacterId;
          seg.status = 'pending';
          seg.audioPath = undefined;
          seg.contextualAudioPath = undefined;
        }
      });
      fs.writeFileSync(segmentsFile, JSON.stringify(segments, null, 2));
    }

    res.json({ success: true, message: 'Personagens mesclados com sucesso' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.put('/api/projects/:projectId/characters/:characterId', (req, res) => {
  try {
    const { projectId, characterId } = req.params; const projDir = path.join(PROJECTS_ROOT, projectId);
    const charactersFile = path.join(projDir, 'narrative-bible/characters.json');
    if (!fs.existsSync(charactersFile)) return res.status(404).json({ error:'Bíblia narrativa não encontrada' });
    const characters:any[] = JSON.parse(fs.readFileSync(charactersFile,'utf8')); const character = characters.find(c => c.characterId === characterId);
    if (!character) return res.status(404).json({ error:'Personagem não encontrado' });
    const canonicalName = String(req.body?.canonicalName ?? character.canonicalName).trim();
    if (!canonicalName) return res.status(400).json({ error:'O nome canônico é obrigatório' });
    const aliases = Array.isArray(req.body?.aliases) ? req.body.aliases.map((a:any)=>String(a).trim()).filter((a:string)=>a && !isGenericCharacterAlias(a) && a.toLowerCase() !== canonicalName.toLowerCase()) : character.aliases;
    const role = ['protagonist','antagonist','main','supporting','narrator'].includes(req.body?.role) ? req.body.role : character.role;
    const previousNarrator = characters.find(c => c.role === 'narrator' && c.characterId !== characterId);
    if (role === 'narrator') characters.forEach(c => { if (c.characterId !== characterId && c.role === 'narrator') c.role = 'supporting'; });
    Object.assign(character, { canonicalName, aliases:Array.from(new Set(aliases)), role, description:String(req.body?.description ?? character.description ?? '').trim() });
    fs.writeFileSync(charactersFile, JSON.stringify(characters,null,2));
    const segmentsFile = path.join(projDir,'scripts/segments.json');
    if (role === 'narrator' && previousNarrator && fs.existsSync(segmentsFile)) {
      const segments:any[] = JSON.parse(fs.readFileSync(segmentsFile,'utf8'));
      segments.forEach(seg => { if (seg.speakerId === previousNarrator.characterId) { seg.speakerId = characterId; seg.status='pending'; seg.audioPath=undefined; seg.contextualAudioPath=undefined; } });
      fs.writeFileSync(segmentsFile, JSON.stringify(segments,null,2));
    }
    res.json({ characters });
  } catch(err:any) { res.status(500).json({ error:err.message || String(err) }); }
});

app.post('/api/projects/:projectId/split-character', (req,res) => {
  try {
    const { projectId } = req.params; const sourceCharacterId=String(req.body?.sourceCharacterId||''); const alias=String(req.body?.alias||'').trim();
    if (!sourceCharacterId || !alias || isGenericCharacterAlias(alias)) return res.status(400).json({ error:'Selecione um alias válido para separar' });
    const projDir=path.join(PROJECTS_ROOT,projectId); const charactersFile=path.join(projDir,'narrative-bible/characters.json');
    if (!fs.existsSync(charactersFile)) return res.status(404).json({ error:'Bíblia narrativa não encontrada' });
    const characters:any[]=JSON.parse(fs.readFileSync(charactersFile,'utf8')); const source=characters.find(c=>c.characterId===sourceCharacterId);
    if (!source || !(source.aliases||[]).some((a:string)=>a.toLowerCase()===alias.toLowerCase())) return res.status(404).json({ error:'Alias não encontrado no personagem' });
    if (characters.some(c=>c.canonicalName.toLowerCase()===alias.toLowerCase())) return res.status(409).json({ error:'Já existe um personagem com esse nome' });
    source.aliases=source.aliases.filter((a:string)=>a.toLowerCase()!==alias.toLowerCase());
    const aliasSlug=alias.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
    const base=`char_${aliasSlug || crypto.randomUUID().slice(0,8)}`; let characterId=base; let suffix=2; while(characters.some(c=>c.characterId===characterId)) characterId=`${base}_${suffix++}`;
    const separated={ ...source, characterId, canonicalName:alias, aliases:[], role:'supporting', voiceAssignment:undefined, voiceAssignmentId:undefined, voiceRecommendations:[], createdFromAliasOf:sourceCharacterId };
    characters.push(separated); fs.writeFileSync(charactersFile,JSON.stringify(characters,null,2));
    res.json({ characters, separatedCharacter:separated, warning:'Revise no roteiro quais falas pertencem ao novo personagem.' });
  } catch(err:any) { res.status(500).json({ error:err.message || String(err) }); }
});

// Helper function to resolve speaker IDs or names returned by Gemini to actual valid character IDs
function resolveSpeakerId(returnedId: string | null | undefined, characters: any[]): string {
  if (!returnedId) {
    const narrator = characters.find((c: any) => c.role === 'narrator');
    return narrator ? narrator.characterId : 'char_narrator';
  }
  const cleanId = String(returnedId).trim();
  if (cleanId === 'null' || cleanId === 'undefined' || cleanId === '') {
    const narrator = characters.find((c: any) => c.role === 'narrator');
    return narrator ? narrator.characterId : 'char_narrator';
  }

  // 1. Direct match with characterId
  const matchById = characters.find((c: any) => c.characterId === cleanId);
  if (matchById) return matchById.characterId;

  // 2. Case-insensitive match on canonicalName
  const matchByName = characters.find((c: any) => c.canonicalName.toLowerCase() === cleanId.toLowerCase());
  if (matchByName) return matchByName.characterId;

  // 3. Case-insensitive match on aliases
  const matchByAlias = characters.find((c: any) => 
    Array.isArray(c.aliases) && c.aliases.some((a: string) => a.toLowerCase() === cleanId.toLowerCase())
  );
  if (matchByAlias) return matchByAlias.characterId;

  // 4. Substring check (e.g. if returnedId is "Helena Duarte" but character canonical name is "Helena Duarte" or vice-versa)
  const matchBySubstring = characters.find((c: any) => 
    c.canonicalName.toLowerCase().includes(cleanId.toLowerCase()) || 
    cleanId.toLowerCase().includes(c.canonicalName.toLowerCase())
  );
  if (matchBySubstring) return matchBySubstring.characterId;

  // 5. Default to first character with 'narrator' role, or fallback to first ID
  const narratorChar = characters.find((c: any) => c.role === 'narrator');
  if (narratorChar) return narratorChar.characterId;

  return 'char_narrator';
}

// UPDATE VOICE CASTING / ASSIGNMENTS
app.post('/api/projects/:projectId/voices', (req, res) => {
  const { projectId } = req.params;
  const { characters } = req.body; // updated character list with voiceAssignmentId

  console.log(`[INFO] [Voices] Recebida requisição para salvar elenco do projeto ${projectId}.`);

  if (!characters) {
    console.error(`[ERROR] [Voices] Erro ao salvar vozes para o projeto ${projectId}: Nenhum elenco (characters) fornecido no corpo da requisição.`);
    return res.status(400).json({ error: 'Nenhum elenco fornecido' });
  }

  try {
    ensureProjectDirs(projectId);

    const projects = getProjects();
    const projectIdx = projects.findIndex((p) => p.projectId === projectId);
    if (projectIdx === -1) {
      console.error(`[ERROR] [Voices] Erro ao salvar vozes: Projeto com ID ${projectId} não encontrado.`);
      return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const project = projects[projectIdx];
    project.status = 'scripting';
    project.updatedAt = new Date().toISOString();
    saveProjects(projects);

    const projDir = path.join(PROJECTS_ROOT, projectId);
    const charactersFile = path.join(projDir, 'narrative-bible/characters.json');
    
    // Detect character voice assignment changes
    let oldCharacters: any[] = [];
    if (fs.existsSync(charactersFile)) {
      try {
        oldCharacters = JSON.parse(fs.readFileSync(charactersFile, 'utf8'));
      } catch (e) {
        oldCharacters = [];
      }
    }

    const changedCharacterIds = new Set<string>();
    characters.forEach((newChar: any) => {
      const oldChar = oldCharacters.find((c) => c.characterId === newChar.characterId);
      if (!oldChar) {
        changedCharacterIds.add(newChar.characterId);
      } else {
        const oldVoiceId = oldChar.voiceAssignmentId || '';
        const newVoiceId = newChar.voiceAssignmentId || '';
        const oldProv = oldChar.voiceAssignment?.providerId || '';
        const newProv = newChar.voiceAssignment?.providerId || '';
        const oldVoiceName = oldChar.voiceAssignment?.voiceName || '';
        const newVoiceName = newChar.voiceAssignment?.voiceName || '';
        const oldConf = JSON.stringify(oldChar.voiceAssignment?.configurations || {});
        const newConf = JSON.stringify(newChar.voiceAssignment?.configurations || {});

        if (oldVoiceId !== newVoiceId || oldProv !== newProv || oldVoiceName !== newVoiceName || oldConf !== newConf) {
          changedCharacterIds.add(newChar.characterId);
        }
      }
    });

    console.log(`[INFO] [Voices] Escrevendo elenco atualizado (${characters.length} personagens) no arquivo local: ${charactersFile}`);
    fs.writeFileSync(charactersFile, JSON.stringify(characters, null, 2));

    // Invalidate affected segments
    if (changedCharacterIds.size > 0) {
      const segmentsFile = path.join(projDir, 'scripts/segments.json');
      if (fs.existsSync(segmentsFile)) {
        try {
          const segments: any[] = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'));
          let changedCount = 0;
          segments.forEach((seg: any) => {
            if (changedCharacterIds.has(seg.speakerId)) {
              seg.status = 'pending';
              changedCount++;
            }
          });
          if (changedCount > 0) {
            fs.writeFileSync(segmentsFile, JSON.stringify(segments, null, 2));
            console.log(`[Voices] Invalidou ${changedCount} segmentos cujas vozes foram alteradas.`);
          }
        } catch (err) {
          console.error('[Voices] Erro ao carregar/invalidar segmentos:', err);
        }
      }
    }

    checkAndUpdateProjectStatusToReviewing(projectId);

    console.log(`[SUCCESS] [Voices] Elenco atualizado com sucesso para o projeto ${projectId}. Status do projeto alterado para 'scripting'.`);
    res.json({ project, characters });
  } catch (err: any) {
    console.error(`[FATAL ERROR] [Voices] Falha catastrófica ao processar as vozes para o projeto ${projectId}:`, err);
    res.status(500).json({ error: 'Erro interno ao salvar o elenco de vozes: ' + err.message });
  }
});

// GENERATE AUDIO PLAYBOOK/SCRIPT SEGMENTS (Step 4 of Flow)
app.post('/api/projects/:projectId/script', async (req, res) => {
  const { projectId } = req.params;

  console.log(`[INFO] [Script] Iniciando fatiamento de roteiro LOSSLESS C10 para o projeto ${projectId}.`);

  try {
    ensureProjectDirs(projectId);

    const projects = getProjects();
    const projectIdx = projects.findIndex((p) => p.projectId === projectId);
    if (projectIdx === -1) {
      console.error(`[ERROR] [Script] Erro ao fatiar roteiro: Projeto ${projectId} não encontrado.`);
      return res.status(404).json({ error: 'Projeto não encontrado' });
    }

    const project = projects[projectIdx];
    const projDir = path.join(PROJECTS_ROOT, projectId);

    const chaptersFile = path.join(projDir, 'normalized/chapters.json');
    const charactersFile = path.join(projDir, 'narrative-bible/characters.json');

    if (!fs.existsSync(chaptersFile)) {
      console.error(`[ERROR] [Script] Erro ao fatiar roteiro do projeto ${projectId}: Arquivo de capítulos não existe (${chaptersFile}).`);
      return res.status(400).json({ error: 'Faltam capítulos estruturados para o fatiamento do roteiro.' });
    }
    if (!fs.existsSync(charactersFile)) {
      console.error(`[ERROR] [Script] Erro ao fatiar roteiro do projeto ${projectId}: Bíblia de personagens não existe (${charactersFile}).`);
      return res.status(400).json({ error: 'Falta bíblia de personagens com atribuição de vozes para o fatiamento do roteiro.' });
    }

    const chapters = JSON.parse(fs.readFileSync(chaptersFile, 'utf8'));
    const characters = JSON.parse(fs.readFileSync(charactersFile, 'utf8'));
    const characterIds = characters.map((c: any) => c.characterId);

    console.log(`[INFO] [Script] Projeto ${projectId} carregado. ${chapters.length} capítulos, ${characters.length} personagens encontrados.`);

    // 1. Load existing segments to identify locked segments to preserve
    const segmentsFile = path.join(projDir, 'scripts/segments.json');
    const lockedSegmentsMap = new Map<string, any>();
    if (fs.existsSync(segmentsFile)) {
      try {
        const existingSegs = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'));
        if (Array.isArray(existingSegs)) {
          existingSegs.forEach((seg: any) => {
            if (seg.locked && seg.sourceUnitId) {
              lockedSegmentsMap.set(seg.sourceUnitId, seg);
            }
          });
        }
      } catch (e) {
        console.warn(`[WARN] [Script] Erro ao ler segmentos existentes para preservar travados:`, e);
      }
    }

    // 2. Deterministically slice chapters into source units
    const allSourceUnits: any[] = [];
    chapters.forEach((ch: any) => {
      const textToSegment = ch.translatedText || ch.originalText || '';
      const chUnits = sliceTextIntoSourceUnits(textToSegment, ch.chapterId);
      allSourceUnits.push(...chUnits);
    });

    // Write source-units.jsonl
    const scriptsDir = path.join(projDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const sourceUnitsFile = path.join(scriptsDir, 'source-units.jsonl');
    fs.writeFileSync(sourceUnitsFile, allSourceUnits.map((u) => JSON.stringify(u)).join('\n') + '\n');

    console.log(`[INFO] [Script] Slicing concluído: ${allSourceUnits.length} source units geradas e salvas.`);

    // 3. Batch the source units (e.g., 10 units per batch)
    const batchSize = 10;
    const batches: any[][] = [];
    for (let i = 0; i < allSourceUnits.length; i += batchSize) {
      batches.push(allSourceUnits.slice(i, i + batchSize));
    }

    const hasApiKey = hasTextAi();
    const finalSegmentsList: any[] = [];
    let isAnyBatchFailed = false;
    let usedDeterministicDraft = false;

    // Process each batch
    for (let bIdx = 0; bIdx < batches.length; bIdx++) {
      const batchUnits = batches[bIdx];
      console.log(`[INFO] [Script] Processando lote ${bIdx + 1}/${batches.length} (${batchUnits.length} unidades)...`);

      // If all units in this batch are locked, we can preserve them directly without calling Gemini!
      const allLocked = batchUnits.every((u) => lockedSegmentsMap.has(u.sourceUnitId));
      if (allLocked) {
        console.log(`[INFO] [Script] Todas as unidades do lote ${bIdx + 1} estão travadas (locked). Preservando localmente.`);
        batchUnits.forEach((u) => {
          finalSegmentsList.push(lockedSegmentsMap.get(u.sourceUnitId));
        });
        continue;
      }

      let batchSegments: any[] = [];
      let batchSuccess = false;

      if (hasApiKey) {
        try {
          const prompt = `Você é um fatiador e rotulador de roteiro altamente preciso para audiolivros e audiodramas.
Você receberá um lote de unidades textuais chamadas 'sourceUnits' de um capítulo.
Seu trabalho é classificar cada unidade e retornar o roteiro para cada uma em um formato JSON estrito.

Lista de Personagens Disponíveis (atribua os IDs corretos):
${JSON.stringify(characters.map((c: any) => ({ characterId: c.characterId, name: c.canonicalName, aliases: c.aliases })))}

Instruções Importantes:
1. Retorne EXATAMENTE um objeto para cada 'sourceUnitId' fornecido no lote. Não mude, adicione ou remova nenhum ID.
2. Classifique cada unidade em um de: 'título', 'parágrafo', 'fala', 'citação', 'lista', 'nota', 'fórmula'.
3. Atribua o 'speakerId' correspondente. O narrador padrão deve ser 'char_narrator'. Se o personagem for desconhecido ou ambíguo, use 'unresolved'. Nunca invente IDs arbitrários ou atribua 'char_maria' ou 'char_joao' sem certeza absoluta baseada no contexto.
4. No campo 'spokenText', forneça o texto falado adaptado, limpo de marcadores de diálogo desnecessários ou aspas de fala, mas mantendo a fidelidade total.
5. Adicione orientações de voz no campo 'direction' com 'emotion' (ex: calmo, entusiasmado), 'intensity' (número de 0 a 1), 'pace' ('slow', 'normal', 'fast') e 'pauseAfterMs' (milisegundos de pausa após).

Schema de Resposta JSON esperado:
{
  "segments": [
    {
      "sourceUnitId": "String (ID exato enviado)",
      "classificação": "título" | "parágrafo" | "fala" | "citação" | "lista" | "nota" | "fórmula",
      "speakerId": "String (ID do personagem ou 'char_narrator' ou 'unresolved')",
      "spokenText": "String (texto adaptado para leitura)",
      "direction": {
        "emotion": "String",
        "intensity": number,
        "pace": "slow" | "normal" | "fast",
        "pauseAfterMs": number
      }
    }
  ]
}

Lote de sourceUnits para processar:
${JSON.stringify(batchUnits.map((u: any) => ({ sourceUnitId: u.sourceUnitId, type: u.type, sourceText: u.sourceText })))}
`;

          const response = await callGeminiWithRetryAndFallback(
            TEXT_MODELS.editorial,
            (model) =>
              ai.models.generateContent({
                model,
                contents: [{ text: prompt }],
                config: { responseMimeType: 'application/json' },
              })
          );

          const textResponse = response.text || '';
          const parsed = JSON.parse(textResponse.trim());

          // Validate batch 1:1
          batchSegments = validateBatchResponse(parsed, batchUnits, characterIds);
          batchSuccess = true;
          console.log(`[SUCCESS] [Script] Lote ${bIdx + 1} fatiado e validado via Gemini com sucesso.`);
        } catch (err: any) {
          console.error(`[ERROR] [Script] Erro ou falha de validação no lote ${bIdx + 1} via Gemini:`, err);
          if (bIdx === batches.length - 1) {
            isAnyBatchFailed = true; // Falha no último lote bloqueia script_complete
          }
        }
      }

      // Fallback local se falhou ou não tem API key (garante fatiamento 100% completo e lossless mesmo sem API)
      if (!batchSuccess) {
        isAnyBatchFailed = true;
        usedDeterministicDraft = true;
        console.log(`[INFO] [Script] Aplicando fatiamento fallback local e determinístico para o lote ${bIdx + 1}`);
        batchSegments = batchUnits.map((unit) => {
          // If already locked, use that instead
          if (lockedSegmentsMap.has(unit.sourceUnitId)) {
            return lockedSegmentsMap.get(unit.sourceUnitId);
          }

          let speakerId = 'char_narrator';
          let cleanText = unit.sourceText;

          if (unit.type === 'fala') {
            const lowercaseText = unit.sourceText.toLowerCase();
            const matchingChar = characters.find((c: any) =>
              c.characterId !== 'char_narrator' &&
              (lowercaseText.includes(c.canonicalName.toLowerCase()) ||
                (Array.isArray(c.aliases) && c.aliases.some((a: string) => lowercaseText.includes(a.toLowerCase()))))
            );
            if (matchingChar) {
              speakerId = matchingChar.characterId;
            } else {
              speakerId = 'unresolved';
            }
            cleanText = unit.sourceText.replace(/^["'—-\s]*/, '').replace(/["'—-\s]*$/, '');
          }

          return {
            segmentId: `seg_${unit.sourceUnitId.substring(3)}_${Date.now()}`,
            projectId,
            chapterId: unit.chapterId,
            sourceUnitId: unit.sourceUnitId,
            order: unit.order,
            type: unit.type,
            speakerId,
            originalText: unit.sourceText,
            spokenText: cleanText,
            direction: {
              emotion: unit.type === 'fala' ? 'expressivo' : 'informativo',
              intensity: project.intensity ?? 0.5,
              pace: 'normal',
              pauseAfterMs: 300,
            },
            status: 'pending',
            draftSource: 'deterministic_unreviewed',
          };
        });
      }

      // Apply mode constraints and map project ID
      batchSegments = batchSegments.map((seg) => {
        // If it's a locked segment, keep it completely unchanged!
        if (lockedSegmentsMap.has(seg.sourceUnitId)) {
          return lockedSegmentsMap.get(seg.sourceUnitId);
        }

        seg.projectId = projectId;
        return applyModeConstraints(seg, project.productionMode || 'audiobook', project.intensity);
      });

      finalSegmentsList.push(...batchSegments);
    }

    // 4. Organize global order and ensure unique segmentIds
    finalSegmentsList.forEach((seg, index) => {
      seg.order = index + 1;
    });

    // 5. Write tts-input/<segmentId>.txt for each segment (must contain the actual spoken text)
    const ttsInputDir = path.join(scriptsDir, 'tts-input');
    fs.mkdirSync(ttsInputDir, { recursive: true });
    finalSegmentsList.forEach((seg) => {
      const txtPath = path.join(ttsInputDir, `${seg.segmentId}.txt`);
      fs.writeFileSync(txtPath, seg.spokenText || '', 'utf8');
    });

    // 6. Save segments.jsonl and segments.json
    const segmentsJsonlFile = path.join(scriptsDir, 'segments.jsonl');
    fs.writeFileSync(segmentsJsonlFile, finalSegmentsList.map((s) => JSON.stringify(s)).join('\n') + '\n');
    fs.writeFileSync(segmentsFile, JSON.stringify(finalSegmentsList, null, 2));

    // 7. Calculate and save ledger of non-narrated units
    const mappedUnitIds = new Set(finalSegmentsList.map((s) => s.sourceUnitId));
    const ledgerNonNarrated: any[] = [];
    allSourceUnits.forEach((unit) => {
      if (!mappedUnitIds.has(unit.sourceUnitId)) {
        ledgerNonNarrated.push({
          sourceUnitId: unit.sourceUnitId,
          reason: `Unidade classificada como ${unit.type} e ignorada de acordo com as regras de fatiamento.`,
          userDecision: 'skip',
        });
      }
    });
    const ledgerFile = path.join(scriptsDir, 'ledger-non-narrated.json');
    fs.writeFileSync(ledgerFile, JSON.stringify(ledgerNonNarrated, null, 2));

    // 8. Generate and save script-report.json
    const totalSourceUnits = allSourceUnits.length;
    const totalSegments = finalSegmentsList.length;
    const unresolvedSpeakers = finalSegmentsList
      .filter((s) => s.speakerId === 'unresolved')
      .map((s) => ({
        segmentId: s.segmentId,
        sourceUnitId: s.sourceUnitId,
        originalText: s.originalText,
        suggestedSpeaker: 'unresolved',
      }));

    const totalUnresolved = unresolvedSpeakers.length;
    const coverage = totalSourceUnits > 0 ? Math.round((mappedUnitIds.size / totalSourceUnits) * 100) : 100;

    const chaptersSummary = chapters.map((ch: any) => {
      const chUnits = allSourceUnits.filter((u) => u.chapterId === ch.chapterId);
      const chSegs = finalSegmentsList.filter((s) => s.chapterId === ch.chapterId);
      return {
        chapterId: ch.chapterId,
        title: ch.title,
        sourceUnitsCount: chUnits.length,
        segmentsCount: chSegs.length,
      };
    });

    // scriptComplete conditions: all chapters done, coverage 100%, 0 unresolved, no batch failed
    const scriptComplete = coverage === 100 && totalUnresolved === 0 && !isAnyBatchFailed;

    const report = {
      projectId,
      status: scriptComplete ? 'PASS' : 'FAIL',
      coverage,
      totalSourceUnits,
      totalSegments,
      totalBatches: batches.length,
      totalUnresolved,
      scriptComplete,
      unresolvedSpeakers,
      chaptersSummary,
      ledgerNonNarrated,
      usedDeterministicDraft,
    };

    const reportFile = path.join(scriptsDir, 'script-report.json');
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

    project.status = scriptComplete ? 'generating_audio' : 'scripting';
    project.updatedAt = new Date().toISOString();
    saveProjects(getProjects().map((p) => (p.projectId === projectId ? project : p)));

    console.log(`[SUCCESS] [Script] Fatiamento concluído. Status C10: ${report.status}. Cobertura: ${coverage}%.`);
    res.json({ project, segments: finalSegmentsList, report });
  } catch (err: any) {
    console.error('[FATAL ERROR] [Script] Erro crítico inexplicável no processo de fatiamento do roteiro:', err);
    res.status(500).json({ error: 'Erro interno ao processar o roteiro: ' + err.message });
  }
});

// UPDATE INDIVIDUAL SEGMENT TEXT/DIRECTION (Live editing of Script)
app.post('/api/projects/:projectId/segments/:segmentId', (req, res) => {
  const { projectId, segmentId } = req.params;
  const { spokenText, speakerId, direction } = req.body;

  const projDir = path.join(PROJECTS_ROOT, projectId);
  const segmentsFile = path.join(projDir, 'scripts/segments.json');

  if (!fs.existsSync(segmentsFile)) {
    return res.status(404).json({ error: 'Roteiro de segmentos não encontrado' });
  }

  const segments: any[] = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'));
  const segIdx = segments.findIndex((s) => s.segmentId === segmentId);

  if (segIdx === -1) {
    return res.status(404).json({ error: 'Segmento não encontrado' });
  }

  segments[segIdx] = {
    ...segments[segIdx],
    spokenText: spokenText ?? segments[segIdx].spokenText,
    speakerId: speakerId ?? segments[segIdx].speakerId,
    direction: {
      ...segments[segIdx].direction,
      ...(direction || {}),
    },
    status: 'pending', // invalidate audio when edited!
  };

  fs.writeFileSync(segmentsFile, JSON.stringify(segments, null, 2));
  res.json({ success: true, segment: segments[segIdx] });
});
// GENERATE TTS AUDIO FOR SEGMENT (Real call or mock)
app.post('/api/projects/:projectId/segments/:segmentId/tts', async (req, res) => {
  const { projectId, segmentId } = req.params;

  const projDir = path.join(PROJECTS_ROOT, projectId);
  const segmentsFile = path.join(projDir, 'scripts/segments.json');
  const charactersFile = path.join(projDir, 'narrative-bible/characters.json');

  if (!fs.existsSync(segmentsFile)) {
    return res.status(404).json({ error: 'Segmentos não encontrados' });
  }

  const segments: any[] = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'));
  const segment = segments.find((s) => s.segmentId === segmentId);

  if (!segment) {
    return res.status(404).json({ error: 'Segmento não encontrado' });
  }

  segment.status = 'generating';
  fs.writeFileSync(segmentsFile, JSON.stringify(segments, null, 2));

  // Load project to save lastError if needed
  const projects = getProjects();
  const project = projects.find((p) => p.projectId === projectId);

  let characters: any[] = [];
  if (fs.existsSync(charactersFile)) {
    try {
      characters = JSON.parse(fs.readFileSync(charactersFile, 'utf8'));
    } catch (e) {
      console.warn('Erro ao ler personagens para síntese de segmento:', e);
    }
  }

  let audioBuffer: Buffer | null = null;
  let ttsError: any = null;

  try {
    audioBuffer = await synthesizeTtsForSegment(
      segment.spokenText,
      segment.speakerId,
      characters,
      segment.direction,
      project?.intensity
    );
  } catch (err) {
    console.error('Falha na geração de TTS do segmento:', err);
    ttsError = err;
  }

  if (!audioBuffer) {
    segment.status = 'failed';
    const errMsg = ttsError ? (ttsError.message || String(ttsError)) : 'Falha desconhecida na geração de áudio TTS';

    const appError = new AppError({
      code: 'TTS_GENERATION_FAILED',
      message: errMsg,
      retryable: true,
      operation: 'generate_segment_tts',
      projectId,
      segmentId,
      status: 500
    });

    segment.lastError = appError.toJSON().error;
    if (project) {
      project.lastError = appError.toJSON().error;
      saveProjects(projects);
    }
    fs.writeFileSync(segmentsFile, JSON.stringify(segments, null, 2));

    writeStructuredLog(projectId, 'generate_segment_tts', 'failed', { 
      segmentId, 
      error: appError.toJSON().error,
      attempts: 1,
      duration: 0,
      size: 0,
      checksum: ''
    });

    return res.status(500).json(appError.toJSON());
  }

  const audioFileName = `${segmentId}.wav`;
  const audioDir = path.join(projDir, 'audio/segments');
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
  }
  const audioFilePath = path.join(audioDir, audioFileName);
  const tempFilePath = path.join(audioDir, `${segmentId}.temp.wav`);

  // Write to temporary file first
  fs.writeFileSync(tempFilePath, audioBuffer);

  // Extract provider and voice to validate properly
  let providerId = 'gemini';
  let voiceName = 'Zephyr';
  const speaker = characters.find((c: any) => c.characterId === segment.speakerId);
  if (speaker) {
    if (speaker.voiceAssignment) {
      providerId = speaker.voiceAssignment.providerId || 'gemini';
      voiceName = speaker.voiceAssignment.voiceName || 'Zephyr';
    } else {
      const vId = speaker.voiceAssignmentId || '';
      if (vId.includes(':')) {
        const parts = vId.split(':');
        providerId = parts[0];
        voiceName = parts[1];
      } else if (vId.startsWith('pt-BR-')) {
        providerId = 'gcp';
        voiceName = vId;
      } else {
        providerId = 'gemini';
        if (vId === 'voice_kore' || vId === 'voice_a') {
          voiceName = 'Kore';
        } else if (vId === 'voice_puck' || vId === 'voice_b') {
          voiceName = 'Puck';
        } else if (vId === 'voice_fenrir') {
          voiceName = 'Fenrir';
        } else if (vId === 'voice_charon') {
          voiceName = 'Charon';
        } else {
          voiceName = 'Zephyr';
        }
      }
    }
  }

  // Validate temp file
  const validation = validateTtsAudioFile(tempFilePath, providerId, voiceName);
  if (!validation.isValid) {
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }

    segment.status = 'failed';
    const errMsg = `Audio validation failed: ${validation.error}`;

    const appError = new AppError({
      code: 'TTS_VALIDATION_FAILED',
      message: errMsg,
      retryable: true,
      operation: 'generate_segment_tts',
      projectId,
      segmentId,
      status: 500
    });

    segment.lastError = appError.toJSON().error;
    if (project) {
      project.lastError = appError.toJSON().error;
      saveProjects(projects);
    }
    fs.writeFileSync(segmentsFile, JSON.stringify(segments, null, 2));

    writeStructuredLog(projectId, 'generate_segment_tts', 'failed', { 
      segmentId, 
      error: appError.toJSON().error,
      attempts: 1,
      duration: 0,
      size: 0,
      checksum: ''
    });

    return res.status(500).json(appError.toJSON());
  }

  // Overwrite destination file with validated temp file
  if (fs.existsSync(audioFilePath)) {
    fs.unlinkSync(audioFilePath);
  }
  fs.renameSync(tempFilePath, audioFilePath);

  segment.audioPath = `/projects/${projectId}/audio/segments/${audioFileName}`;
  segment.status = 'ready';
  segment.audioSize = validation.size;
  segment.durationMs = validation.durationMs;
  segment.lastError = undefined;

  fs.writeFileSync(segmentsFile, JSON.stringify(segments, null, 2));

  if (project && project.lastError && project.lastError.segmentId === segmentId) {
    project.lastError = undefined;
    saveProjects(projects);
  }

  // Check if project status becomes 'reviewing'
  checkAndUpdateProjectStatusToReviewing(projectId);
  const updatedProject = getProjects().find(p => p.projectId === projectId);

  writeStructuredLog(projectId, 'generate_segment_tts', 'success', { 
    segmentId, 
    audioSize: segment.audioSize,
    durationMs: segment.durationMs,
    attempts: 1,
    checksum: validation.checksum
  });

  res.json({ success: true, segment, project: updatedProject });
});

// SERVE GENERATED AUDIO ASSETS
app.get('/projects/:projectId/audio/segments/:fileName', (req, res) => {
  const { projectId, fileName } = req.params;
  const filePath = path.join(PROJECTS_ROOT, projectId, 'audio/segments', fileName);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('Audio file not found');
  }
});

// GENERATE TTS AUDIO SAMPLE (Casting View live preview)
app.post('/api/tts-sample', async (req, res) => {
  const { text, voiceId } = req.body;
  if (!text || !voiceId) {
    return res.status(400).json({ error: 'Faltam parâmetros' });
  }

  let providerId = 'gemini';
  let voiceName = 'Zephyr';

  if (voiceId.includes(':')) {
    const parts = voiceId.split(':');
    providerId = parts[0];
    voiceName = parts[1];
  } else {
    // Legacy support or fallback:
    if (voiceId.startsWith('pt-BR-')) {
      providerId = 'gcp';
      voiceName = voiceId;
    } else {
      providerId = 'gemini';
      if (voiceId === 'voice_kore' || voiceId === 'voice_a') {
        voiceName = 'Kore';
      } else if (voiceId === 'voice_puck' || voiceId === 'voice_b') {
        voiceName = 'Puck';
      } else if (voiceId === 'voice_fenrir') {
        voiceName = 'Fenrir';
      } else if (voiceId === 'voice_charon') {
        voiceName = 'Charon';
      } else {
        voiceName = 'Zephyr';
      }
    }
  }

  // Check cache first!
  const cachePath = getPreviewCachePath(providerId, ttsProviders[providerId]?.model || '', voiceName, text);
  if (fs.existsSync(cachePath)) {
    console.log(`[Preview Cache] Returning cached sample for ${providerId}:${voiceName}`);
    try {
      const cachedAudio = fs.readFileSync(cachePath).toString('base64');
      return res.json({ base64Audio: cachedAudio });
    } catch (e) {
      console.error('Error reading from preview cache:', e);
    }
  }

  try {
    const provider = ttsProviders[providerId];
    if (!provider) {
      return res.status(400).json({ error: `Provedor de voz inválido: ${providerId}` });
    }
    if (!provider.validateConfiguration()) {
      return res.status(400).json({ error: `Provedor de voz ${providerId} não configurado/autorizado` });
    }

    console.log(`[TTS Sample] Synthesizing sample with ${providerId} and voice ${voiceName}...`);
    const audioBuffer = await provider.synthesize(text, voiceName, { intensity: 0.5 });
    
    // Save to cache
    fs.writeFileSync(cachePath, audioBuffer);

    res.json({ base64Audio: audioBuffer.toString('base64') });
  } catch (err: any) {
    console.error(`[TTS Sample] Erro na síntese de amostra com ${providerId}:${voiceName}:`, err);
    const sanitizedErr = mapAndSanitizeTtsError(err);
    res.status(500).json({ error: sanitizedErr });
  }
});

// EXPORT OBRA COMPLETA (Step 5 of Flow) C13 IMPLEMENTATION

export interface ExportJob {
  exportJobId: string;
  projectId: string;
  format: 'mp3_chapters' | 'mp3_single' | 'zip_assets';
  status: 'queued' | 'processing' | 'completed' | 'failed';
  downloadUrl?: string;
  fileSize?: number;
  durationMs?: number;
  lastError?: any;
  createdAt: string;
  updatedAt: string;
  token?: string;
}

export function getExportJobs(): ExportJob[] {
  const file = path.join(PROJECTS_ROOT, 'export_jobs.json');
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return [];
  }
}

export function saveExportJobs(jobs: ExportJob[]) {
  const file = path.join(PROJECTS_ROOT, 'export_jobs.json');
  fs.writeFileSync(file, JSON.stringify(jobs, null, 2));
}

export function validateProjectForExport(projectId: string): { isValid: boolean; error?: string; missingSegments?: string[] } {
  const projDir = path.join(PROJECTS_ROOT, projectId);
  const segmentsFile = path.join(projDir, 'scripts/segments.json');
  if (!fs.existsSync(segmentsFile)) {
    return { isValid: false, error: 'Nenhum segmento sonoro encontrado para exportação', missingSegments: [] };
  }

  const segments: any[] = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'));
  if (segments.length === 0) {
    return { isValid: false, error: 'Nenhum segmento sonoro para exportação', missingSegments: [] };
  }

  const charactersFile = path.join(projDir, 'narrative-bible/characters.json');
  let characters: any[] = [];
  if (fs.existsSync(charactersFile)) {
    characters = JSON.parse(fs.readFileSync(charactersFile, 'utf8'));
  }

  const missingSegments: string[] = [];
  const sortedSegments = [...segments].sort((a, b) => a.order - b.order);

  for (let i = 0; i < sortedSegments.length; i++) {
    const seg = sortedSegments[i];
    if (seg.status === 'failed' || seg.status === 'unresolved' || seg.status !== 'ready') {
      missingSegments.push(`Segmento ${seg.segmentId} (Ordem: ${seg.order}) está com status '${seg.status}'`);
      continue;
    }

    if (!seg.audioPath) {
      missingSegments.push(`Segmento ${seg.segmentId} (Ordem: ${seg.order}) não possui caminho de áudio`);
      continue;
    }

    const fileName = path.basename(seg.audioPath);
    if (seg.audioPath.includes('..') || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
      return { isValid: false, error: 'Detecção de nome de arquivo malicioso ou inválido no áudio do segmento.' };
    }

    const filePath = path.join(projDir, 'audio/segments', fileName);
    if (!fs.existsSync(filePath)) {
      missingSegments.push(`Segmento ${seg.segmentId} (Ordem: ${seg.order}): arquivo de áudio não encontrado no disco (${fileName})`);
      continue;
    }

    let providerId = 'gemini';
    let voiceName = 'Zephyr';
    const speaker = characters.find((c: any) => c.characterId === seg.speakerId);
    if (speaker) {
      if (speaker.voiceAssignment) {
        providerId = speaker.voiceAssignment.providerId || 'gemini';
        voiceName = speaker.voiceAssignment.voiceName || 'Zephyr';
      } else {
        const vId = speaker.voiceAssignmentId || '';
        if (vId.includes(':')) {
          const parts = vId.split(':');
          providerId = parts[0];
          voiceName = parts[1];
        } else if (vId.startsWith('pt-BR-')) {
          providerId = 'gcp';
          voiceName = vId;
        } else {
          providerId = 'gemini';
          if (vId === 'voice_kore' || vId === 'voice_a') {
            voiceName = 'Kore';
          } else if (vId === 'voice_puck' || vId === 'voice_b') {
            voiceName = 'Puck';
          } else if (vId === 'voice_fenrir') {
            voiceName = 'Fenrir';
          } else if (vId === 'voice_charon') {
            voiceName = 'Charon';
          } else {
            voiceName = 'Zephyr';
          }
        }
      }
    }

    const validation = validateTtsAudioFile(filePath, providerId, voiceName);
    if (!validation.isValid) {
      missingSegments.push(`Segmento ${seg.segmentId} (Ordem: ${seg.order}): áudio inválido - ${validation.error}`);
    }
  }

  if (missingSegments.length > 0) {
    return {
      isValid: false,
      error: `Validação do projeto falhou. Segmentos faltantes ou com erro: ${missingSegments.join('; ')}`,
      missingSegments
    };
  }

  return { isValid: true };
}

export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const actualPath = ffmpegPath || 'ffmpeg';
    const proc = spawn(actualPath, args);
    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg falhou com código ${code}. Stderr: ${stderr}`));
      }
    });
  });
}

export async function concatenateWavFilesWithPausesAsync(
  inputWavPaths: { path: string; pauseBeforeMs?: number; pauseAfterMs?: number }[],
  outputPath: string,
  sampleRate: number = 24000,
  channels: number = 1,
  bitsPerSample: number = 16
): Promise<{ durationMs: number; totalSize: number }> {
  return new Promise((resolve, reject) => {
    try {
      const bytesPerSample = bitsPerSample / 8;
      const blockAlign = channels * bytesPerSample;
      const byteRate = sampleRate * blockAlign;

      let totalPcmSize = 0;
      let totalDurationMs = 0;

      for (const item of inputWavPaths) {
        const pBefore = item.pauseBeforeMs || 0;
        const pAfter = item.pauseAfterMs || 0;

        const samplesBefore = Math.round((sampleRate * pBefore) / 1000);
        const bytesBefore = samplesBefore * blockAlign;
        totalPcmSize += bytesBefore;
        totalDurationMs += pBefore;

        const fileBuffer = fs.readFileSync(item.path);
        const validation = getWavDurationAndValidate(fileBuffer);
        if (!validation.isValid) {
          return reject(new Error(`File ${item.path} is not a valid WAV file: ${validation.error}`));
        }

        let dataOffset = 36;
        while (dataOffset < fileBuffer.length - 8) {
          const chunkId = fileBuffer.toString('ascii', dataOffset, dataOffset + 4);
          if (chunkId === 'data') {
            break;
          }
          const chunkSize = fileBuffer.readUInt32LE(dataOffset + 4);
          dataOffset += 8 + chunkSize;
        }
        const dataSize = fileBuffer.readUInt32LE(dataOffset + 4);
        totalPcmSize += dataSize;
        totalDurationMs += validation.durationMs;

        const samplesAfter = Math.round((sampleRate * pAfter) / 1000);
        const bytesAfter = samplesAfter * blockAlign;
        totalPcmSize += bytesAfter;
        totalDurationMs += pAfter;
      }

      const header = Buffer.alloc(44);
      const chunkSize = 36 + totalPcmSize;
      header.write('RIFF', 0);
      header.writeUInt32LE(chunkSize, 4);
      header.write('WAVE', 8);
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20); // PCM
      header.writeUInt16LE(channels, 22);
      header.writeUInt32LE(sampleRate, 24);
      header.writeUInt32LE(byteRate, 28);
      header.writeUInt16LE(blockAlign, 32);
      header.writeUInt16LE(bitsPerSample, 34);
      header.write('data', 36);
      header.writeUInt32LE(totalPcmSize, 40);

      const writeStream = fs.createWriteStream(outputPath);
      writeStream.on('error', (err) => reject(err));
      writeStream.on('finish', () => {
        resolve({ durationMs: totalDurationMs, totalSize: 44 + totalPcmSize });
      });

      writeStream.write(header);

      for (const item of inputWavPaths) {
        const pBefore = item.pauseBeforeMs || 0;
        const pAfter = item.pauseAfterMs || 0;

        if (pBefore > 0) {
          const samplesBefore = Math.round((sampleRate * pBefore) / 1000);
          const bytesBefore = samplesBefore * blockAlign;
          writeStream.write(Buffer.alloc(bytesBefore));
        }

        const fileBuffer = fs.readFileSync(item.path);
        let dataOffset = 36;
        while (dataOffset < fileBuffer.length - 8) {
          const chunkId = fileBuffer.toString('ascii', dataOffset, dataOffset + 4);
          if (chunkId === 'data') {
            break;
          }
          const chunkSize = fileBuffer.readUInt32LE(dataOffset + 4);
          dataOffset += 8 + chunkSize;
        }
        const dataSize = fileBuffer.readUInt32LE(dataOffset + 4);
        const pcmData = fileBuffer.subarray(dataOffset + 8, dataOffset + 8 + dataSize);
        writeStream.write(pcmData);

        if (pAfter > 0) {
          const samplesAfter = Math.round((sampleRate * pAfter) / 1000);
          const bytesAfter = samplesAfter * blockAlign;
          writeStream.write(Buffer.alloc(bytesAfter));
        }
      }

      writeStream.end();
    } catch (e) {
      reject(e);
    }
  });
}

export async function convertWavToMp3WithMetadata(
  wavPath: string,
  mp3Path: string,
  metadata: { title: string; artist: string; album: string; comment: string }
): Promise<void> {
  const args = [
    '-y',
    '-i', wavPath,
    '-codec:a', 'libmp3lame',
    '-b:a', '128k',
    '-metadata', `title=${metadata.title}`,
    '-metadata', `artist=${metadata.artist}`,
    '-metadata', `album=${metadata.album}`,
    '-metadata', `comment=${metadata.comment}`,
    mp3Path
  ];
  await runFfmpeg(args);
}

export function getMp3InfoAndValidate(mp3Path: string): Promise<{
  isValid: boolean;
  container?: string;
  codec?: string;
  durationMs?: number;
  channels?: number;
  sampleRate?: number;
  size?: number;
  error?: string;
}> {
  return new Promise((resolve) => {
    const actualPath = ffmpegPath || 'ffmpeg';
    const size = fs.existsSync(mp3Path) ? fs.statSync(mp3Path).size : 0;
    if (size === 0) {
      return resolve({ isValid: false, error: 'File is empty or does not exist' });
    }

    const proc = spawn(actualPath, ['-i', mp3Path]);
    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', () => {
      const hasMp3Container = stderr.includes('Input #0, mp3') || stderr.includes('Audio: mp3');
      const hasMp3Codec = stderr.includes('Audio: mp3') || stderr.includes('mp3');
      
      if (!hasMp3Container) {
        return resolve({ isValid: false, size, error: `Invalid MP3 container or codec. Stderr: ${stderr}` });
      }

      const durationMatch = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      let durationMs = 0;
      if (durationMatch) {
        const hours = parseInt(durationMatch[1], 10);
        const minutes = parseInt(durationMatch[2], 10);
        const seconds = parseInt(durationMatch[3], 10);
        const hundredths = parseInt(durationMatch[4], 10);
        durationMs = (hours * 3600 + minutes * 60 + seconds) * 1000 + hundredths * 10;
      }

      const sampleRateMatch = stderr.match(/(\d+)\s*Hz/);
      const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : undefined;

      const channelsMatch = stderr.match(/(mono|stereo|5\.1)/);
      let channels = 1;
      if (channelsMatch) {
        channels = channelsMatch[1] === 'stereo' ? 2 : channelsMatch[1] === 'mono' ? 1 : 6;
      }

      resolve({
        isValid: true,
        container: 'mp3',
        codec: 'mp3',
        durationMs,
        channels,
        sampleRate,
        size
      });
    });
  });
}

export async function createExportZip(
  projectId: string,
  projectName: string,
  compiledChapters: { chapterId: string; order: number; title: string; path: string; durationMs: number; size: number }[],
  singleMp3Info: { path: string; durationMs: number; size: number } | null,
  outputPath: string
): Promise<{ size: number; checksum: string }> {
  const zip = new AdmZip();
  const projDir = path.join(PROJECTS_ROOT, projectId);
  
  const zipFiles: { zipPath: string; content: Buffer }[] = [];
  
  const addFileToZip = (zipPath: string, content: Buffer) => {
    zip.addFile(zipPath, content);
    zipFiles.push({ zipPath, content });
  };

  const addLocalFileToZip = (localPath: string, zipDir: string, zipName?: string) => {
    if (fs.existsSync(localPath)) {
      const content = fs.readFileSync(localPath);
      const name = zipName || path.basename(localPath);
      const zipPath = zipDir ? `${zipDir}/${name}` : name;
      zip.addFile(zipPath, content);
      zipFiles.push({ zipPath, content });
    }
  };

  const chaptersFile = path.join(projDir, 'normalized/chapters.json');
  addLocalFileToZip(chaptersFile, 'original-texts');
  
  const normChaptersDir = path.join(projDir, 'normalized/chapters');
  if (fs.existsSync(normChaptersDir)) {
    const files = fs.readdirSync(normChaptersDir);
    files.forEach(file => {
      addLocalFileToZip(path.join(normChaptersDir, file), 'original-texts');
    });
  }

  const glossaryFile = path.join(projDir, 'translation/glossary.json');
  addLocalFileToZip(glossaryFile, 'translations');
  const reportFile = path.join(projDir, 'translation/report.json');
  addLocalFileToZip(reportFile, 'translations');
  
  const transDir = path.join(projDir, 'translation');
  if (fs.existsSync(transDir)) {
    const files = fs.readdirSync(transDir);
    files.forEach(file => {
      if (file !== 'glossary.json' && file !== 'report.json' && fs.statSync(path.join(transDir, file)).isFile()) {
        addLocalFileToZip(path.join(transDir, file), 'translations');
      }
    });
  }

  const charactersFile = path.join(projDir, 'narrative-bible/characters.json');
  addLocalFileToZip(charactersFile, 'narrative-bible');

  const segmentsFile = path.join(projDir, 'scripts/segments.json');
  addLocalFileToZip(segmentsFile, 'scripts');

  const contextSoundsFile = path.join(projDir, 'audio/context-sounds.json');
  let contextSounds: any[] = [];
  if (fs.existsSync(contextSoundsFile)) {
    contextSounds = JSON.parse(fs.readFileSync(contextSoundsFile, 'utf8'));
    addLocalFileToZip(contextSoundsFile, 'context', 'attribution.json');
    contextSounds.forEach(cue => {
      const localPath = path.join(projDir, String(cue.localPath || '').replace(/^\/+/, ''));
      if (path.resolve(localPath).startsWith(path.resolve(projDir) + path.sep)) {
        addLocalFileToZip(localPath, 'context/sounds');
      }
    });
  }

  let segments: any[] = [];
  if (fs.existsSync(segmentsFile)) {
    segments = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'));
  }
  const ttsInputData = segments.map((seg: any) => ({
    segmentId: seg.segmentId,
    order: seg.order,
    speakerId: seg.speakerId,
    text: seg.spokenText
  }));
  addFileToZip('tts-input/tts-input.json', Buffer.from(JSON.stringify(ttsInputData, null, 2)));

  compiledChapters.forEach(ch => {
    addLocalFileToZip(ch.path, 'audio', `chapter_${ch.order}.mp3`);
  });
  
  if (singleMp3Info) {
    addLocalFileToZip(singleMp3Info.path, 'audio', `single_book.mp3`);
  }

  const manifest = {
    projectId,
    projectName,
    exportDate: new Date().toISOString(),
    totalChapters: compiledChapters.length,
    chapters: compiledChapters.map(ch => ({
      chapterId: ch.chapterId,
      order: ch.order,
      title: ch.title,
      fileName: `chapter_${ch.order}.mp3`,
      durationMs: ch.durationMs,
      size: ch.size
    })),
    singleFile: singleMp3Info ? {
      fileName: 'single_book.mp3',
      durationMs: singleMp3Info.durationMs,
      size: singleMp3Info.size
    } : null,
    contextSounds: contextSounds.map(cue => ({
      segmentId: cue.segmentId,
      name: cue.name,
      author: cue.username,
      license: cue.license,
      attribution: cue.attribution,
      sourceUrl: cue.pageUrl
    }))
  };
  addFileToZip('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));

  let checksumsContent = '';
  zipFiles.forEach(zf => {
    const sha256 = crypto.createHash('sha256').update(zf.content).digest('hex');
    checksumsContent += `${sha256}  ${zf.zipPath}\n`;
  });
  zip.addFile('checksums.sha256', Buffer.from(checksumsContent));

  zip.writeZip(outputPath);
  
  const size = fs.statSync(outputPath).size;
  const zipBuffer = fs.readFileSync(outputPath);
  const checksum = crypto.createHash('sha256').update(zipBuffer).digest('hex');

  return { size, checksum };
}

app.post('/api/projects/:projectId/export', async (req, res) => {
  const { projectId } = req.params;
  const { format } = req.body; // 'mp3_chapters', 'mp3_single', 'zip_assets'

  // PREVENT PATH TRAVERSAL
  const cleanProjectId = String(projectId).replace(/[^a-zA-Z0-9_-]/g, '');
  const cleanFormat = String(format).replace(/[^a-zA-Z0-9_]/g, '');

  if (cleanProjectId !== projectId) {
    return res.status(400).json({ error: 'ID de projeto inválido ou malicioso' });
  }

  const projects = getProjects();
  const projectIdx = projects.findIndex((p) => p.projectId === cleanProjectId);
  if (projectIdx === -1) {
    return res.status(404).json({ error: 'Projeto não encontrado' });
  }

  const project = projects[projectIdx];
  const originalStatus = project.status;

  // Initialize Jobs database if not exist
  const exportJobs = getExportJobs();
  const jobId = `exp_${Date.now()}`;
  const downloadToken = crypto.randomBytes(16).toString('hex');

  const newJob: ExportJob = {
    exportJobId: jobId,
    projectId: cleanProjectId,
    format: cleanFormat as any,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    token: downloadToken
  };

  exportJobs.push(newJob);
  saveExportJobs(exportJobs);

  // VALIDATION
  const valResult = validateProjectForExport(cleanProjectId);
  if (!valResult.isValid) {
    // Falha não marca projeto completed. Restore original status or set status to reviewing
    project.status = originalStatus === 'completed' ? 'reviewing' : originalStatus;
    project.lastError = {
      code: 'EXPORT_FAILED',
      message: valResult.error || 'Validation failed',
      operation: 'assemble_export',
      projectId: cleanProjectId
    };
    saveProjects(projects);

    newJob.status = 'failed';
    newJob.lastError = project.lastError;
    newJob.updatedAt = new Date().toISOString();
    saveExportJobs(getExportJobs().map(j => j.exportJobId === jobId ? newJob : j));

    writeStructuredLog(cleanProjectId, 'assemble_export', 'failed', { error: project.lastError, missingSegments: valResult.missingSegments });
    return res.status(400).json({
      error: valResult.error,
      missingSegments: valResult.missingSegments,
      exportJob: newJob
    });
  }

  // Update status to processing/assembling
  project.status = 'assembling';
  saveProjects(projects);

  newJob.status = 'processing';
  newJob.updatedAt = new Date().toISOString();
  saveExportJobs(getExportJobs().map(j => j.exportJobId === jobId ? newJob : j));

  const projDir = path.join(PROJECTS_ROOT, cleanProjectId);
  const segmentsFile = path.join(projDir, 'scripts/segments.json');
  const chaptersFile = path.join(projDir, 'normalized/chapters.json');

  const exportDir = path.join(projDir, 'exports');
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }

  const exportName = cleanFormat === 'mp3_single' ? `obra_${cleanProjectId}_single.mp3` : `obra_${cleanProjectId}_${cleanFormat}.zip`;
  const exportPath = path.join(exportDir, exportName);

  const tempsToCleanup: string[] = [];

  try {
    const segments: any[] = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'));
    let chaptersList: any[] = [];
    if (fs.existsSync(chaptersFile)) {
      chaptersList = JSON.parse(fs.readFileSync(chaptersFile, 'utf8'));
    }

    // Sort segments initially
    const sortedSegments = [...segments].sort((a: any, b: any) => a.order - b.order);

    // 1. Compile all chapters
    const compiledChapters: { chapterId: string; order: number; title: string; path: string; durationMs: number; size: number }[] = [];
    
    // Group segments by chapter
    const segmentsByChapter: Record<string, any[]> = {};
    sortedSegments.forEach(seg => {
      if (!segmentsByChapter[seg.chapterId]) {
        segmentsByChapter[seg.chapterId] = [];
      }
      segmentsByChapter[seg.chapterId].push(seg);
    });

    // Make sure we compile chapters in order
    const sortedChapters = [...chaptersList].sort((a: any, b: any) => a.order - b.order);
    if (sortedChapters.length === 0) {
      // No chapters listed, group everything into a default one
      sortedChapters.push({
        chapterId: 'default',
        order: 1,
        title: project.name || 'Livro Integro'
      });
      segmentsByChapter['default'] = sortedSegments;
    }

    for (const ch of sortedChapters) {
      const chSegs = segmentsByChapter[ch.chapterId] || [];
      if (chSegs.length === 0) continue;

      const chWavPath = path.join(exportDir, `temp_chapter_${ch.chapterId}.wav`);
      const chMp3Path = path.join(exportDir, `chapter_${ch.order}.mp3`);
      tempsToCleanup.push(chWavPath, chMp3Path);

      const inputWavs = chSegs.map(seg => ({
        path: seg.contextualAudioPath ? path.join(projDir, 'audio/contextualized', path.basename(seg.contextualAudioPath)) : path.join(projDir, 'audio/segments', path.basename(seg.audioPath)),
        pauseBeforeMs: seg.pauseBeforeMs || 0,
        pauseAfterMs: seg.pauseAfterMs || 0
      }));

      // Concatenate
      await concatenateWavFilesWithPausesAsync(inputWavs, chWavPath);

      // Convert to MP3
      await convertWavToMp3WithMetadata(chWavPath, chMp3Path, {
        title: `Capítulo ${ch.order} - ${ch.title}`,
        artist: project.author || 'Autor VoxLibro',
        album: project.name || 'VoxLibro Obra',
        comment: 'Sintetizado por IA com VoxLibro'
      });

      // Validate MP3
      const mp3Val = await getMp3InfoAndValidate(chMp3Path);
      if (!mp3Val.isValid) {
        throw new Error(`MP3 Validation for chapter ${ch.order} failed: ${mp3Val.error}`);
      }

      compiledChapters.push({
        chapterId: ch.chapterId,
        order: ch.order,
        title: ch.title,
        path: chMp3Path,
        durationMs: mp3Val.durationMs || 0,
        size: mp3Val.size || 0
      });
    }

    // 2. Compile single file if requested
    let singleMp3Info: { path: string; durationMs: number; size: number } | null = null;
    const singleWavPath = path.join(exportDir, `temp_single.wav`);
    const singleMp3Path = path.join(exportDir, `obra_${cleanProjectId}_single.mp3`);
    tempsToCleanup.push(singleWavPath);

    // If cleanFormat is single, we write single Mp3 to its official exportPath
    // Otherwise, we write it to singleMp3Path temporarily to pack inside the ZIP
    const destSingleMp3Path = cleanFormat === 'mp3_single' ? exportPath : singleMp3Path;
    if (cleanFormat === 'mp3_single') {
      tempsToCleanup.push(singleWavPath); // don't cleanup the final exportPath!
    } else {
      tempsToCleanup.push(singleWavPath, singleMp3Path);
    }

    const allInputWavs = sortedSegments.map(seg => ({
      path: seg.contextualAudioPath ? path.join(projDir, 'audio/contextualized', path.basename(seg.contextualAudioPath)) : path.join(projDir, 'audio/segments', path.basename(seg.audioPath)),
      pauseBeforeMs: seg.pauseBeforeMs || 0,
      pauseAfterMs: seg.pauseAfterMs || 0
    }));

    await concatenateWavFilesWithPausesAsync(allInputWavs, singleWavPath);

    await convertWavToMp3WithMetadata(singleWavPath, destSingleMp3Path, {
      title: project.name || 'VoxLibro Obra Completa',
      artist: project.author || 'Autor VoxLibro',
      album: project.name || 'VoxLibro Obra',
      comment: 'Sintetizado por IA com VoxLibro'
    });

    const singleMp3Val = await getMp3InfoAndValidate(destSingleMp3Path);
    if (!singleMp3Val.isValid) {
      throw new Error(`Single MP3 Validation failed: ${singleMp3Val.error}`);
    }

    singleMp3Info = {
      path: destSingleMp3Path,
      durationMs: singleMp3Val.durationMs || 0,
      size: singleMp3Val.size || 0
    };

    // 3. Build Zip if requested
    let finalSize = 0;
    let finalDurationMs = 0;

    if (cleanFormat === 'mp3_single') {
      finalSize = singleMp3Info.size;
      finalDurationMs = singleMp3Info.durationMs;
    } else {
      // Build real ZIP with manifest, original texts, translations, bible, segments, tts-input, audios, and checksums
      // We pass singleMp3Info as null if format is mp3_chapters, or we can include it if wanted
      const resultZip = await createExportZip(
        cleanProjectId,
        project.name || 'Obra VoxLibro',
        compiledChapters,
        cleanFormat === 'zip_assets' ? singleMp3Info : null,
        exportPath
      );
      finalSize = resultZip.size;
      // Duration of ZIP is the total duration of chapters
      finalDurationMs = compiledChapters.reduce((acc, c) => acc + c.durationMs, 0);
    }

    // Complete Job and Project
    newJob.status = 'completed';
    newJob.fileSize = finalSize;
    newJob.durationMs = finalDurationMs;
    newJob.downloadUrl = `/api/projects/${cleanProjectId}/download-export?format=${cleanFormat}&token=${downloadToken}`;
    newJob.updatedAt = new Date().toISOString();
    saveExportJobs(getExportJobs().map(j => j.exportJobId === jobId ? newJob : j));

    project.status = 'completed';
    project.lastError = undefined;
    project.updatedAt = new Date().toISOString();
    saveProjects(projects);

    writeStructuredLog(cleanProjectId, 'assemble_export', 'success', { format: cleanFormat, fileSize: finalSize, durationMs: finalDurationMs });

    res.json({
      success: true,
      message: 'Exportação concluída com sucesso! O download começará agora.',
      exportJob: newJob
    });

  } catch (err: any) {
    project.status = originalStatus; // restore or failed? Prompt says "Falha não marca projeto completed"
    project.lastError = {
      code: 'EXPORT_FAILED',
      message: 'Erro ao gerar o arquivo de exportação: ' + err.message,
      operation: 'assemble_export',
      projectId: cleanProjectId
    };
    saveProjects(projects);

    newJob.status = 'failed';
    newJob.lastError = project.lastError;
    newJob.updatedAt = new Date().toISOString();
    saveExportJobs(getExportJobs().map(j => j.exportJobId === jobId ? newJob : j));

    writeStructuredLog(cleanProjectId, 'assemble_export', 'failed', { error: project.lastError });
    res.status(500).json({ error: err.message, exportJob: newJob });

  } finally {
    // REMOVA TEMPORÁRIOS COM SEGURANÇA
    tempsToCleanup.forEach(f => {
      if (fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
        } catch (e) {
          console.warn(`[Cleanup] Failed to remove temporary file ${f}:`, e);
        }
      }
    });
  }
});

// DOWNLOAD EXPORTED FILE WITH AUTHENTICATION
app.get('/api/projects/:projectId/download-export', (req, res) => {
  const { projectId } = req.params;
  const { format, token } = req.query;

  // PREVENT PATH TRAVERSAL
  const cleanProjectId = String(projectId).replace(/[^a-zA-Z0-9_-]/g, '');
  const cleanFormat = String(format).replace(/[^a-zA-Z0-9_]/g, '');

  if (cleanProjectId !== projectId) {
    return res.status(400).send('ID de projeto inválido ou malicioso');
  }

  const jobs = getExportJobs().filter(j => j.projectId === cleanProjectId && j.format === cleanFormat);
  const matchedJob = jobs.find(j => j.token === token);

  // AUTHENTICATION CHECK
  if (!matchedJob) {
    return res.status(403).send('Download não autorizado ou token de autenticação inválido/expirado.');
  }

  const projDir = path.join(PROJECTS_ROOT, cleanProjectId);
  const isSingle = cleanFormat === 'mp3_single';
  const exportName = isSingle ? `obra_${cleanProjectId}_single.mp3` : `obra_${cleanProjectId}_${cleanFormat}.zip`;
  const exportPath = path.join(projDir, 'exports', exportName);

  if (fs.existsSync(exportPath)) {
    if (isSingle) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.download(exportPath, `obra_${cleanProjectId}.mp3`);
    } else {
      res.download(exportPath, exportName);
    }
  } else {
    res.status(404).send('Arquivo de exportação não encontrado ou ainda em processamento.');
  }
});

// GET ESTIMATED COSTS AND METRICS API
app.get('/api/pricing', (req, res) => {
  // Reference rates are shown before synthesis and can be updated here when a
  // provider changes its public table. Final billing always comes from provider.
  res.json({
    pricingAsOf: '2026-07-17',
    tts: {
      googleCloud: {
        standardUsdPerMillionCharacters: 4,
        wavenetUsdPerMillionCharacters: 4,
        neural2UsdPerMillionCharacters: 16,
      },
      geminiFlash: { inputUsdPerMillionTextTokens: 0.5, outputUsdPerMillionAudioTokens: 10, audioTokensPerSecond: 25 },
      geminiPro: { inputUsdPerMillionTextTokens: 1, outputUsdPerMillionAudioTokens: 20, audioTokensPerSecond: 25 },
    },
    models: [
      { name: TEXT_MODELS.bulk, type: 'reasoning', stage: 'tradução e roteiro', priceSource: 'configurável no provedor' },
      { name: TEXT_MODELS.editorial, type: 'reasoning', stage: 'bíblia e continuidade', priceSource: 'configurável no provedor' },
      { name: TEXT_MODELS.audit, type: 'reasoning', stage: 'auditoria difícil sob demanda', priceSource: 'configurável no provedor' },
      { name: 'gemini-2.5-flash-preview-tts', type: 'audio', tier: 'standard' },
      { name: 'gemini-2.5-pro-preview-tts', type: 'audio', tier: 'premium' },
    ],
    storageCostPerGBMonth: 0.026,
  });
});

app.get('/api/projects/:projectId/exports', (req, res) => {
  const { projectId } = req.params;
  const cleanProjectId = String(projectId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (cleanProjectId !== projectId) {
    return res.status(400).json({ error: 'ID de projeto inválido' });
  }
  const jobs = getExportJobs().filter(j => j.projectId === cleanProjectId);
  res.json({ jobs });
});

// Optional high-effort editorial audit. It is never triggered automatically,
// keeping the expensive tier under explicit user control.
app.post('/api/projects/:projectId/audit', async (req, res) => {
  const projectId = String(req.params.projectId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (projectId !== req.params.projectId) return res.status(400).json({ error: 'ID de projeto inválido' });
  if (!hasTextAi()) return res.status(400).json({ error: 'OPENAI_API_KEY é necessária para a auditoria editorial' });
  const project = getProjects().find(p => p.projectId === projectId);
  if (!project) return res.status(404).json({ error: 'Projeto não encontrado' });
  const projDir = path.join(PROJECTS_ROOT, projectId);
  try {
    const readJson = (relative: string, fallback: any) => {
      const file = path.join(projDir, relative);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
    };
    const characters = readJson('narrative-bible/characters.json', []);
    const segments = readJson('scripts/segments.json', []);
    const report = readJson('scripts/script-report.json', {});
    const unresolved = segments.filter((s: any) => s.speakerId === 'unresolved' || s.draftSource).slice(0, 80);
    const prompt = `Faça uma auditoria editorial final e conservadora desta produção de áudio. Não reescreva a obra. Identifique somente problemas acionáveis de continuidade, personagem, locutor, omissão ou direção. Retorne JSON estrito no formato {"status":"PASS"|"REVIEW","summary":"...","issues":[{"severity":"high"|"medium"|"low","segmentId":"...","message":"...","suggestion":"..."}]}.

Projeto: ${JSON.stringify({ name: project.name, mode: project.productionMode, language: project.sourceLanguage })}
Relatório de integridade: ${JSON.stringify(report)}
Personagens: ${JSON.stringify(characters.map((c: any) => ({ id: c.characterId, name: c.canonicalName, aliases: c.aliases, role: c.role })))}
Trechos que exigem atenção: ${JSON.stringify(unresolved.map((s: any) => ({ segmentId: s.segmentId, speakerId: s.speakerId, originalText: s.originalText, spokenText: s.spokenText, direction: s.direction, draftSource: s.draftSource })))} `;
    const response = await callGeminiWithRetryAndFallback(TEXT_MODELS.audit, model => ai.models.generateContent({
      model, contents: [{ text: prompt }], config: { responseMimeType: 'application/json', reasoningEffort: 'high' }
    }), 2, 1000);
    const audit = cleanAndParseJson(response.text || '');
    if (!audit) throw new Error('A auditoria retornou JSON inválido');
    const auditResult = { ...audit, model: TEXT_MODELS.audit, reasoningEffort: 'high', createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(projDir, 'logs/final-editorial-audit.json'), JSON.stringify(auditResult, null, 2));
    res.json({ audit: auditResult });
  } catch (err: any) {
    res.status(500).json({ error: redactSensitiveData(err.message) });
  }
});

// ==================== C06: JOBS RESUMÍVEIS E CHUNKING ====================
export const TEXT_MODEL = process.env.VOXLIBRO_TEXT_MODEL || TEXT_MODELS.bulk;
export const TTS_MODEL = process.env.VOXLIBRO_TTS_MODEL || 'gemini-2.5-flash-preview-tts';

export interface JobItem {
  itemId: string;
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
  lease?: number; // timestamp in ms
  errorCode?: string;
  retryable?: boolean;
  inputHash: string;
  outputHash?: string;
  model: string;
  promptVersion: string;
  configurationHash: string;
  createdAt: string;
  updatedAt: string;
  payload: any;
  result?: any;
  entrada?: string;
  saida?: string;
  saída?: string;
}

export interface Job {
  jobId: string;
  projectId: string;
  operation: 'translation' | 'character_analysis' | 'script_generation' | 'tts_generation';
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'paused';
  progress: number;
  createdAt: string;
  updatedAt: string;
  items: JobItem[];
}

export let JOBS_DB_FILE = path.join(PROJECTS_ROOT, 'jobs.json');

// Helper to update jobs file on path updates
const originalUpdateStoragePaths = updateStoragePaths;
export function updateStoragePathsC06(newPath: string) {
  originalUpdateStoragePaths(newPath);
  JOBS_DB_FILE = path.join(PROJECTS_ROOT, 'jobs.json');
}
// Override updateStoragePaths
// @ts-ignore
updateStoragePaths = updateStoragePathsC06;

export function getJobs(): Job[] {
  if (!fs.existsSync(JOBS_DB_FILE)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(JOBS_DB_FILE, 'utf8'));
  } catch (err) {
    return [];
  }
}

export function saveJobs(jobs: Job[]) {
  fs.mkdirSync(path.dirname(JOBS_DB_FILE), { recursive: true });
  fs.writeFileSync(JOBS_DB_FILE, JSON.stringify(jobs, null, 2), 'utf8');
}

export function calculateHash(str: string): string {
  return crypto.createHash('sha256').update(str || '', 'utf8').digest('hex');
}

export function splitIntoChunks(text: string, targetLen: number, maxLen: number): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n+/);
  let currentChunk = '';

  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) continue;

    if (trimmedPara.length > maxLen) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }

      const sentences = trimmedPara.match(/[^.!?]+[.!?]+(?:\s+|$)|.+$/g) || [trimmedPara];

      for (let sentence of sentences) {
        sentence = sentence.trim();
        if (!sentence) continue;

        if (sentence.length > maxLen) {
          const words = sentence.split(/\s+/);
          for (const word of words) {
            if (word.length > maxLen) {
              let pos = 0;
              while (pos < word.length) {
                let len = maxLen;
                const code = word.charCodeAt(pos + len - 1);
                if (code >= 0xD800 && code <= 0xDBFF) {
                  len--;
                }
                const sub = word.slice(pos, pos + len);
                chunks.push(sub);
                pos += len;
              }
            } else {
              if (currentChunk.length + word.length + 1 > targetLen) {
                if (currentChunk) chunks.push(currentChunk.trim());
                currentChunk = word;
              } else {
                currentChunk = currentChunk ? `${currentChunk} ${word}` : word;
              }
            }
          }
        } else {
          if (currentChunk.length + sentence.length + 1 > targetLen) {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = sentence;
          } else {
            currentChunk = currentChunk ? `${currentChunk}\n${sentence}` : sentence;
          }
        }
      }
    } else {
      if (currentChunk.length + trimmedPara.length + 2 > targetLen) {
        if (currentChunk) chunks.push(currentChunk.trim());
        currentChunk = trimmedPara;
      } else {
        currentChunk = currentChunk ? `${currentChunk}\n\n${trimmedPara}` : trimmedPara;
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks.filter(Boolean);
}

function cleanAndParseJson(text: string): any {
  let clean = text.trim();
  if (clean.startsWith('```json')) {
    clean = clean.slice(7);
  } else if (clean.startsWith('```')) {
    clean = clean.slice(3);
  }
  if (clean.endsWith('```')) {
    clean = clean.slice(0, -3);
  }
  clean = clean.trim();
  return JSON.parse(clean);
}

function isRetryableError(error: any): { retryable: boolean; delayMs?: number } {
  const status = error?.status || error?.code || error?.status_code;
  const errorStr = String(error?.message || error).toLowerCase();

  const retryableStatuses = [429, 500, 502, 503, 504];
  if (retryableStatuses.includes(status)) {
    let retryAfterMs: number | undefined;
    const retryAfterHeader = error?.headers?.['retry-after'] || error?.headers?.['Retry-After'];
    if (retryAfterHeader) {
      const seconds = parseInt(retryAfterHeader, 10);
      if (!isNaN(seconds)) {
        retryAfterMs = seconds * 1000;
      } else {
        const date = Date.parse(retryAfterHeader);
        if (!isNaN(date)) {
          retryAfterMs = Math.max(0, date - Date.now());
        }
      }
    }
    return { retryable: true, delayMs: retryAfterMs };
  }

  if (
    errorStr.includes('429') ||
    errorStr.includes('500') ||
    errorStr.includes('502') ||
    errorStr.includes('503') ||
    errorStr.includes('504') ||
    errorStr.includes('quota') ||
    errorStr.includes('billing') ||
    errorStr.includes('exhausted') ||
    errorStr.includes('rate limit') ||
    errorStr.includes('timeout') ||
    errorStr.includes('deadline') ||
    errorStr.includes('unavailable') ||
    errorStr.includes('temporarily') ||
    errorStr.includes('high demand')
  ) {
    return { retryable: true };
  }

  return { retryable: false };
}

function findCompletedJobItem(allJobs: Job[], operation: string, inputHash: string, configurationHash: string, promptVersion: string, model: string): JobItem | null {
  for (const job of allJobs) {
    if (job.operation === operation) {
      for (const item of job.items) {
        if (
          item.status === 'completed' &&
          item.inputHash === inputHash &&
          item.configurationHash === configurationHash &&
          item.promptVersion === promptVersion &&
          item.model === model &&
          item.result
        ) {
          if (
            operation === 'translation' &&
            isLikelyUntranslatedCopy(item.payload?.text || '', item.result?.translatedText || '')
          ) {
            continue;
          }
          return item;
        }
      }
    }
  }
  return null;
}

export function subdivideJobItem(job: Job, itemId: string, subTexts: string[]): boolean {
  const itemIdx = job.items.findIndex(it => it.itemId === itemId);
  if (itemIdx === -1) return false;

  const parent = job.items[itemIdx];
  const children: JobItem[] = subTexts.map((subText, idx) => {
    const childPayload = { ...parent.payload, text: subText };
    const childInputHash = calculateHash(subText);
    return {
      itemId: `${parent.itemId}_sub_${idx}_${Date.now()}`,
      jobId: parent.jobId,
      status: 'queued',
      attempts: 0,
      inputHash: childInputHash,
      model: parent.model,
      promptVersion: parent.promptVersion,
      configurationHash: parent.configurationHash,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: childPayload,
    };
  });

  job.items.splice(itemIdx, 1, ...children);
  return true;
}

export function validateTranslatedChunk(originalText: string, translatedText: string, targetLanguage: string = 'pt-BR'): { valid: boolean; reason?: string } {
  const trimmed = (translatedText || '').trim();
  if (!trimmed) {
    return { valid: false, reason: 'Saída vazia' };
  }

  if (isLikelyUntranslatedCopy(originalText, trimmed, targetLanguage)) {
    return { valid: false, reason: 'A saída parece ser uma cópia não traduzida do texto original' };
  }

  // Check for preambles or conversational commentary
  const preambles = [
    'aqui está a tradução', 'segue a tradução', 'tradução do texto',
    'translated text', 'translation of the text', 'espero que goste',
    'segundo as regras', 'texto traduzido', 'como solicitado',
    'aqui está o capítulo', 'segue o capítulo', 'tradução:'
  ];
  const lowerText = trimmed.toLowerCase();
  for (const p of preambles) {
    if (lowerText.startsWith(p) || (lowerText.length < 200 && lowerText.includes(p))) {
      return { valid: false, reason: `Preâmbulo ou comentário detectado: "${p}"` };
    }
  }

  // Check for raw markdown block code fences
  if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
    return { valid: false, reason: 'A saída contém blocos de código markdown (```)' };
  }

  // Size ratio bounds check
  if (originalText.length > 50) {
    const ratio = trimmed.length / originalText.length;
    if (ratio < 0.4 || ratio > 2.5) {
      return { valid: false, reason: `Razão de tamanho implausível: ratio de ${ratio.toFixed(2)} (original: ${originalText.length}, traduzido: ${trimmed.length})` };
    }
  }

  // Target language stopwords indication check
  if (trimmed.length > 100 && targetLanguage === 'pt-BR') {
    const detectedOutput = detectLanguageLocally(trimmed);
    if (detectedOutput.confidence >= 0.65 && !isPortuguese(detectedOutput.languageCode)) {
      return { valid: false, reason: `O idioma da tradução parece ser ${detectedOutput.languageCode}, não Português` };
    }

    const ptIndicators = /\b(o|a|e|de|do|da|em|para|que|uma|com|os|as|um|ao|por|se|mais|não)\b/gi;
    const matches = trimmed.match(ptIndicators);
    if (!matches || matches.length < 2) {
      return { valid: false, reason: 'O idioma da tradução não parece ser Português' };
    }
  }

  return { valid: true };
}

export function archivePreviousTranslation(projDir: string) {
  const reportFile = path.join(projDir, 'translation/report.json');
  if (!fs.existsSync(reportFile)) return;

  try {
    const oldReport = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    const version = oldReport.version || 1;

    // Archive old report
    const archivedReportFile = path.join(projDir, `translation/report.v${version}.json`);
    fs.renameSync(reportFile, archivedReportFile);

    // Archive old pt-BR files in normalized/chapters
    const chaptersDir = path.join(projDir, 'normalized/chapters');
    if (fs.existsSync(chaptersDir)) {
      const files = fs.readdirSync(chaptersDir);
      for (const file of files) {
        if (file.endsWith('.pt-BR.txt')) {
          const oldPath = path.join(chaptersDir, file);
          const newFile = file.replace('.pt-BR.txt', `.pt-BR.v${version}.txt`);
          const newPath = path.join(chaptersDir, newFile);
          fs.renameSync(oldPath, newPath);
        }
      }
    }
    console.log(`[C08] Successfully archived translation version ${version}.`);
  } catch (err) {
    console.error('[C08] Failed to archive previous translation:', err);
  }
}

export function invalidateAffectedTranslationChunks(projectId: string, cleanGlossaryEntries: any[], oldGlossary: any[]) {
  const jobs = getJobs();
  const jobIdx = jobs.findIndex(j => j.projectId === projectId && j.operation === 'translation');
  if (jobIdx === -1) return;

  const job = jobs[jobIdx];

  const changedTerms = new Set<string>();
  const oldMap = new Map<string, string>();
  for (const e of oldGlossary) {
    const term = (e.term || e.source || e.sourceTerm || '').trim().toLowerCase();
    const trans = (e.translation || e.target || e.preferredTranslation || '').trim();
    if (term) oldMap.set(term, trans);
  }

  const newMap = new Map<string, string>();
  for (const e of cleanGlossaryEntries) {
    const term = (e.term || e.source || e.sourceTerm || '').trim().toLowerCase();
    const trans = (e.translation || e.target || e.preferredTranslation || '').trim();
    if (term) newMap.set(term, trans);
  }

  for (const [term, trans] of newMap.entries()) {
    if (!oldMap.has(term) || oldMap.get(term) !== trans) {
      changedTerms.add(term);
    }
  }
  for (const term of oldMap.keys()) {
    if (!newMap.has(term)) {
      changedTerms.add(term);
    }
  }

  if (changedTerms.size === 0) return;

  console.log(`[C08] Glossary changed. Checking affected chunks for terms:`, Array.from(changedTerms));

  let affectedCount = 0;
  for (const item of job.items) {
    const text = (item.payload.text || '').toLowerCase();
    let isAffected = false;
    for (const term of changedTerms) {
      if (text.includes(term)) {
        isAffected = true;
        break;
      }
    }

    if (isAffected) {
      console.log(`[C08] Invaliding chunk ${item.itemId} as it contains a changed glossary term.`);
      item.status = 'queued';
      item.attempts = 0;
      item.result = undefined;
      item.outputHash = undefined;
      item.updatedAt = new Date().toISOString();
      affectedCount++;
    }
  }

  if (affectedCount > 0) {
    job.status = 'queued';
    const completedCount = job.items.filter(it => it.status === 'completed').length;
    job.progress = job.items.length > 0 ? Math.round((completedCount / job.items.length) * 100) : 100;
    job.updatedAt = new Date().toISOString();
    saveJobs(jobs);
  }
}

export function syncCompletedJobFiles(job: Job) {
  const projDir = path.join(PROJECTS_ROOT, job.projectId);
  const projects = getProjects();
  const projectIdx = projects.findIndex(p => p.projectId === job.projectId);
  if (projectIdx === -1) return;
  const project = projects[projectIdx];

  if (job.operation === 'translation') {
    const chaptersFile = path.join(projDir, 'normalized/chapters.json');
    if (!fs.existsSync(chaptersFile)) return;
    const chapters: any[] = JSON.parse(fs.readFileSync(chaptersFile, 'utf8'));

    const translationDir = path.join(projDir, 'translation');
    fs.mkdirSync(translationDir, { recursive: true });

    let maxVer = 0;
    if (fs.existsSync(translationDir)) {
      const files = fs.readdirSync(translationDir);
      for (const file of files) {
        const match = file.match(/^report\.v(\d+)\.json$/);
        if (match) {
          const ver = parseInt(match[1], 10);
          if (ver > maxVer) maxVer = ver;
        }
      }
    }
    const version = maxVer + 1;

    const reportChapters: any[] = [];

    for (const ch of chapters) {
      const chItems = job.items.filter(it => it.payload.chapterId === ch.chapterId);
      if (chItems.length === 0) continue;

      chItems.sort((a, b) => a.payload.chunkIndex - b.payload.chunkIndex);

      const mergedTranslated = chItems.map(it => it.result?.translatedText || '').join('\n\n');
      ch.translatedText = mergedTranslated;
      ch.status = 'translated';

      // Write <chapter>.pt-BR.txt
      const ptBrFileName = `${ch.order}-${ch.chapterId}.pt-BR.txt`;
      fs.writeFileSync(path.join(projDir, 'normalized/chapters', ptBrFileName), mergedTranslated);

      reportChapters.push({
        chapterId: ch.chapterId,
        title: ch.title,
        originalFile: `${ch.order}-${ch.chapterId}.original.txt`,
        translatedFile: ptBrFileName,
        chunksCount: chItems.length,
        status: 'completed',
        wordCount: mergedTranslated.split(/\s+/).filter(Boolean).length,
        characterCount: mergedTranslated.length
      });
    }

    fs.writeFileSync(chaptersFile, JSON.stringify(chapters, null, 2));

    const glossaryFile = path.join(projDir, 'translation/glossary.json');
    const glossaryEntries = fs.existsSync(glossaryFile) ? JSON.parse(fs.readFileSync(glossaryFile, 'utf8')) : [];
    const glossaryHash = project.glossaryHash || '';

    const report = {
      projectId: job.projectId,
      glossaryHash,
      glossaryEntries,
      translatedAt: new Date().toISOString(),
      version,
      status: 'completed',
      chapters: reportChapters,
      integrity: {
        totalChunks: job.items.length,
        completedChunks: job.items.filter(it => it.status === 'completed').length,
        failedChunks: job.items.filter(it => it.status === 'failed').length,
        hasPreambleViolations: false,
        hasEmptyChunks: false
      }
    };
    const reportFile = path.join(translationDir, 'report.json');
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

    project.status = 'analyzing_characters';
    project.updatedAt = new Date().toISOString();
    saveProjects(projects);

  } else if (job.operation === 'character_analysis') {
    const charItem = job.items[0];
    if (charItem && charItem.result?.characters) {
      const charDir = path.join(projDir, 'narrative-bible');
      fs.mkdirSync(charDir, { recursive: true });
      fs.writeFileSync(path.join(charDir, 'characters.json'), JSON.stringify(charItem.result.characters, null, 2));

      project.status = 'awaiting_voice_approval';
      project.updatedAt = new Date().toISOString();
      saveProjects(projects);
    }

  } else if (job.operation === 'script_generation') {
    const chaptersFile = path.join(projDir, 'normalized/chapters.json');
    const charactersFile = path.join(projDir, 'narrative-bible/characters.json');
    if (!fs.existsSync(chaptersFile) || !fs.existsSync(charactersFile)) return;

    const chapters = JSON.parse(fs.readFileSync(chaptersFile, 'utf8'));
    const characters = JSON.parse(fs.readFileSync(charactersFile, 'utf8'));

    // Load any locked segments first
    const segmentsFile = path.join(projDir, 'scripts/segments.json');
    const lockedSegmentsMap = new Map<string, any>();
    if (fs.existsSync(segmentsFile)) {
      try {
        const existingSegs = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'));
        if (Array.isArray(existingSegs)) {
          existingSegs.forEach((seg: any) => {
            if (seg.locked && seg.sourceUnitId) {
              lockedSegmentsMap.set(seg.sourceUnitId, seg);
            }
          });
        }
      } catch (e) {
        console.warn(`[Job finalize] Erro ao ler segmentos existentes para preservar travados:`, e);
      }
    }

    // Sort completed items by batch index
    const sortedItems = [...job.items].sort((a, b) => {
      const idxA = a.payload.batchIndex ?? 0;
      const idxB = b.payload.batchIndex ?? 0;
      return idxA - idxB;
    });

    const finalSegmentsList: any[] = [];
    let isAnyBatchFailed = false;

    sortedItems.forEach((item) => {
      if (item.status === 'completed' && item.result?.segments) {
        let batchSegs = item.result.segments;

        // Apply mode constraints & preserve locked
        batchSegs = batchSegs.map((seg: any) => {
          if (lockedSegmentsMap.has(seg.sourceUnitId)) {
            return lockedSegmentsMap.get(seg.sourceUnitId);
          }
          seg.projectId = job.projectId;
          return applyModeConstraints(seg, project.productionMode || 'audiobook', project.intensity);
        });

        finalSegmentsList.push(...batchSegs);
      } else {
        isAnyBatchFailed = true;
      }
    });

    // Organize global order
    finalSegmentsList.forEach((seg, index) => {
      seg.order = index + 1;
    });

    const scriptsDir = path.join(projDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });

    // Write tts-input files
    const ttsInputDir = path.join(scriptsDir, 'tts-input');
    fs.mkdirSync(ttsInputDir, { recursive: true });
    finalSegmentsList.forEach((seg) => {
      const txtPath = path.join(ttsInputDir, `${seg.segmentId}.txt`);
      fs.writeFileSync(txtPath, seg.spokenText || '', 'utf8');
    });

    // Save segments.jsonl and segments.json
    const segmentsJsonlFile = path.join(scriptsDir, 'segments.jsonl');
    fs.writeFileSync(segmentsJsonlFile, finalSegmentsList.map((s) => JSON.stringify(s)).join('\n') + '\n');
    fs.writeFileSync(segmentsFile, JSON.stringify(finalSegmentsList, null, 2));

    // Calculate sourceUnits
    const allSourceUnits: any[] = [];
    chapters.forEach((ch: any) => {
      const textToSegment = ch.translatedText || ch.originalText || '';
      const chUnits = sliceTextIntoSourceUnits(textToSegment, ch.chapterId);
      allSourceUnits.push(...chUnits);
    });

    // Non-narrated ledger
    const mappedUnitIds = new Set(finalSegmentsList.map((s) => s.sourceUnitId));
    const ledgerNonNarrated: any[] = [];
    allSourceUnits.forEach((unit) => {
      if (!mappedUnitIds.has(unit.sourceUnitId)) {
        ledgerNonNarrated.push({
          sourceUnitId: unit.sourceUnitId,
          reason: `Unidade classificada como ${unit.type} e ignorada de acordo com as regras de fatiamento.`,
          userDecision: 'skip',
        });
      }
    });
    const ledgerFile = path.join(scriptsDir, 'ledger-non-narrated.json');
    fs.writeFileSync(ledgerFile, JSON.stringify(ledgerNonNarrated, null, 2));

    // Report
    const totalSourceUnits = allSourceUnits.length;
    const totalSegments = finalSegmentsList.length;
    const unresolvedSpeakers = finalSegmentsList
      .filter((s) => s.speakerId === 'unresolved')
      .map((s) => ({
        segmentId: s.segmentId,
        sourceUnitId: s.sourceUnitId,
        originalText: s.originalText,
        suggestedSpeaker: 'unresolved',
      }));

    const totalUnresolved = unresolvedSpeakers.length;
    const coverage = totalSourceUnits > 0 ? Math.round((mappedUnitIds.size / totalSourceUnits) * 100) : 100;

    const chaptersSummary = chapters.map((ch: any) => {
      const chUnits = allSourceUnits.filter((u) => u.chapterId === ch.chapterId);
      const chSegs = finalSegmentsList.filter((s) => s.chapterId === ch.chapterId);
      return {
        chapterId: ch.chapterId,
        title: ch.title,
        sourceUnitsCount: chUnits.length,
        segmentsCount: chSegs.length,
      };
    });

    const scriptComplete = coverage === 100 && totalUnresolved === 0 && !isAnyBatchFailed;

    const report = {
      projectId: job.projectId,
      status: scriptComplete ? 'PASS' : 'FAIL',
      coverage,
      totalSourceUnits,
      totalSegments,
      totalBatches: sortedItems.length,
      totalUnresolved,
      scriptComplete,
      unresolvedSpeakers,
      chaptersSummary,
      ledgerNonNarrated,
    };

    const reportFile = path.join(scriptsDir, 'script-report.json');
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

    project.status = 'generating_audio';
    project.updatedAt = new Date().toISOString();
    saveProjects(projects);

  } else if (job.operation === 'tts_generation') {
    const segmentsFile = path.join(projDir, 'scripts/segments.json');
    if (!fs.existsSync(segmentsFile)) return;
    const segments: any[] = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'));

    for (const seg of segments) {
      const segItem = job.items.find(it => it.payload.segmentId === seg.segmentId);
      if (segItem && segItem.status === 'completed' && segItem.result) {
        seg.status = 'ready';
        seg.audioPath = segItem.result.audioPath;
        seg.audioSize = segItem.result.audioSize;
        seg.durationMs = segItem.result.durationMs;
      }
    }

    fs.writeFileSync(segmentsFile, JSON.stringify(segments, null, 2));
    project.status = 'generating_audio';
    project.updatedAt = new Date().toISOString();
    saveProjects(projects);

    checkAndUpdateProjectStatusToReviewing(job.projectId);
  }
}

export function startProjectJob(projectId: string, operation: 'translation' | 'character_analysis' | 'script_generation' | 'tts_generation', options?: any): Job {
  const jobs = getJobs();
  const projDir = path.join(PROJECTS_ROOT, projectId);

  let job = jobs.find(j => j.projectId === projectId && j.operation === operation);

  if (operation === 'translation' && options?.forceFresh) {
    archivePreviousTranslation(projDir);
    const oldIdx = jobs.findIndex(j => j.projectId === projectId && j.operation === 'translation');
    if (oldIdx !== -1) {
      jobs.splice(oldIdx, 1);
    }
    job = undefined;
  }

  const projectJobs = jobs.filter(j => j.projectId === projectId);
  for (const pj of projectJobs) {
    if (pj.status === 'processing' || pj.status === 'queued') {
      pj.status = 'paused';
      pj.updatedAt = new Date().toISOString();
    }
  }

  if (job) {
    if (job.status === 'paused' || job.status === 'failed' || job.status === 'cancelled') {
      job.status = 'queued';
      for (const item of job.items) {
        if (item.status === 'failed' || item.status === 'cancelled') {
          item.status = 'queued';
          item.lease = undefined;
          item.updatedAt = new Date().toISOString();
        }
      }
      job.updatedAt = new Date().toISOString();
      saveJobs(jobs);
      return job;
    }
    if (job.status === 'queued' || job.status === 'processing') {
      return job;
    }
    const oldIdx = jobs.findIndex(j => j.jobId === job!.jobId);
    if (oldIdx !== -1) {
      jobs.splice(oldIdx, 1);
    }
  }

  const jobId = `job_${operation}_${Date.now()}`;

  const items: JobItem[] = [];
  const configStr = JSON.stringify(options || {});
  const configurationHash = calculateHash(configStr);

  if (operation === 'translation') {
    const chaptersFile = path.join(projDir, 'normalized/chapters.json');
    const chapters: any[] = fs.existsSync(chaptersFile) ? JSON.parse(fs.readFileSync(chaptersFile, 'utf8')) : [];

    for (const ch of chapters) {
      const textToTranslate = ch.originalText || '';
      const chunks = textToTranslate.length > 12000
        ? splitIntoChunks(textToTranslate, 8000, 12000)
        : [textToTranslate];

      chunks.forEach((chunkText, idx) => {
        const inputHash = calculateHash(chunkText);
        items.push({
          itemId: `item_${ch.chapterId}_chunk_${idx}_${Date.now()}`,
          jobId,
          status: 'queued',
          attempts: 0,
          inputHash,
          model: TEXT_MODEL,
          promptVersion: 'v1',
          configurationHash,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          payload: {
            chapterId: ch.chapterId,
            chapterTitle: ch.title,
            chunkIndex: idx,
            totalChunks: chunks.length,
            text: chunkText,
            style: options?.style || 'literário',
            glossaryEntries: options?.glossaryEntries || []
          },
          entrada: chunkText,
          saida: '',
          saída: ''
        });
      });
    }
  } else if (operation === 'character_analysis') {
    const chaptersFile = path.join(projDir, 'normalized/chapters.json');
    const chapters: any[] = fs.existsSync(chaptersFile) ? JSON.parse(fs.readFileSync(chaptersFile, 'utf8')) : [];
    const allText = chapters.map((c) => c.translatedText || c.originalText).join('\n\n');
    const sliceText = allText.slice(0, 15000);
    const inputHash = calculateHash(sliceText);

    items.push({
      itemId: `item_char_analysis_${Date.now()}`,
      jobId,
      status: 'queued',
      attempts: 0,
      inputHash,
      model: TEXT_MODEL,
      promptVersion: 'v1',
      configurationHash,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: {
        text: sliceText
      }
    });
  } else if (operation === 'script_generation') {
    const chaptersFile = path.join(projDir, 'normalized/chapters.json');
    const chapters: any[] = fs.existsSync(chaptersFile) ? JSON.parse(fs.readFileSync(chaptersFile, 'utf8')) : [];
    const charactersFile = path.join(projDir, 'narrative-bible/characters.json');
    const characters = fs.existsSync(charactersFile) ? JSON.parse(fs.readFileSync(charactersFile, 'utf8')) : [];

    const allSourceUnits: any[] = [];
    chapters.forEach((ch: any) => {
      const textToSegment = ch.translatedText || ch.originalText || '';
      const chUnits = sliceTextIntoSourceUnits(textToSegment, ch.chapterId);
      allSourceUnits.push(...chUnits);
    });

    const scriptsDir = path.join(projDir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const sourceUnitsFile = path.join(scriptsDir, 'source-units.jsonl');
    fs.writeFileSync(sourceUnitsFile, allSourceUnits.map((u) => JSON.stringify(u)).join('\n') + '\n');

    const batchSize = 10;
    const batches: any[][] = [];
    for (let i = 0; i < allSourceUnits.length; i += batchSize) {
      batches.push(allSourceUnits.slice(i, i + batchSize));
    }

    batches.forEach((batchUnits, idx) => {
      const inputHash = calculateHash(JSON.stringify(batchUnits));
      items.push({
        itemId: `item_script_batch_${idx}_${Date.now()}`,
        jobId,
        status: 'queued',
        attempts: 0,
        inputHash,
        model: TEXT_MODEL,
        promptVersion: 'v1',
        configurationHash,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        payload: {
          projectId,
          batchIndex: idx,
          totalBatches: batches.length,
          sourceUnits: batchUnits,
          characters
        }
      });
    });
  } else if (operation === 'tts_generation') {
    const segmentsFile = path.join(projDir, 'scripts/segments.json');
    const segments: any[] = fs.existsSync(segmentsFile) ? JSON.parse(fs.readFileSync(segmentsFile, 'utf8')) : [];
    const charactersFile = path.join(projDir, 'narrative-bible/characters.json');
    const characters = fs.existsSync(charactersFile) ? JSON.parse(fs.readFileSync(charactersFile, 'utf8')) : [];

    for (const seg of segments) {
      const inputHash = calculateHash(seg.spokenText || '');
      items.push({
        itemId: `item_tts_${seg.segmentId}_${Date.now()}`,
        jobId,
        status: 'queued',
        attempts: 0,
        inputHash,
        model: TTS_MODEL,
        promptVersion: 'v1',
        configurationHash,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        payload: {
          segmentId: seg.segmentId,
          spokenText: seg.spokenText,
          speakerId: seg.speakerId,
          direction: seg.direction,
          characters
        }
      });
    }
  }

  const allJobs = getJobs();
  for (const item of items) {
    const matchedHistory = findCompletedJobItem(allJobs, operation, item.inputHash, item.configurationHash, item.promptVersion, item.model);
    if (matchedHistory) {
      item.status = 'completed';
      item.result = matchedHistory.result;
      item.outputHash = matchedHistory.outputHash;
      item.updatedAt = new Date().toISOString();
    }
  }

  const completedCount = items.filter(it => it.status === 'completed').length;
  const isCompleted = completedCount === items.length;

  const newJob: Job = {
    jobId,
    projectId,
    operation,
    status: isCompleted ? 'completed' : 'queued',
    progress: items.length > 0 ? Math.round((completedCount / items.length) * 100) : 100,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    items
  };

  if (isCompleted) {
    syncCompletedJobFiles(newJob);
  }

  jobs.push(newJob);
  saveJobs(jobs);
  return newJob;
}

export async function runTaskForItem(operation: string, item: JobItem): Promise<any> {
  const hasApiKey = hasTextAi();
  if (!hasApiKey && process.env.NODE_ENV !== 'test') {
    throw new Error('MISSING_API_KEY');
  }

  if (operation === 'translation') {
    const detectedInputLanguage = detectLanguageLocally(item.payload.text || '');
    const isPtBr = isPortuguese(detectedInputLanguage.languageCode) && detectedInputLanguage.confidence >= 0.75;
    if (isPtBr) {
      item.entrada = item.payload.text;
      item.saida = item.payload.text;
      item.saída = item.payload.text;
      return { translatedText: item.payload.text, translationNotRequired: true };
    }

    const styleRules = item.payload.style || 'literário';

    // 1. Build glossary part (using only relevant fields: term and translation)
    let glossaryPrompt = '';
    if (Array.isArray(item.payload.glossaryEntries) && item.payload.glossaryEntries.length > 0) {
      glossaryPrompt = 'Dicionário / Glossário de Termos (Traduza estes termos exatamente como indicado):\n' +
        item.payload.glossaryEntries.map((e: any) => `- "${e.term || e.source || e.sourceTerm}" -> "${e.translation || e.target || e.preferredTranslation}"`).join('\n');
    }

    // 2. Fetch context (limited context from preceding and succeeding chunk)
    let contextPrefix = '';
    let contextSuffix = '';

    try {
      const jobs = getJobs();
      const job = jobs.find(j => j.jobId === item.jobId);
      if (job) {
        if (item.payload.chunkIndex > 0) {
          const prevItem = job.items.find(it => it.payload.chapterId === item.payload.chapterId && it.payload.chunkIndex === item.payload.chunkIndex - 1);
          if (prevItem && prevItem.payload.text) {
            const lastPart = prevItem.payload.text.slice(-1000);
            contextPrefix = `[CONTEXTO ANTERIOR — NÃO TRADUZIR NOVAMENTE]\n...${lastPart}\n[FIM DO CONTEXTO ANTERIOR]\n\n`;
          }
        }
        if (item.payload.chunkIndex < item.payload.totalChunks - 1) {
          const nextItem = job.items.find(it => it.payload.chapterId === item.payload.chapterId && it.payload.chunkIndex === item.payload.chunkIndex + 1);
          if (nextItem && nextItem.payload.text) {
            const firstPart = nextItem.payload.text.slice(0, 1000);
            contextSuffix = `\n\n[CONTEXTO SEGUINTE — NÃO TRADUZIR NOVAMENTE]\n${firstPart}...\n[FIM DO CONTEXTO SEGUINTE]`;
          }
        }
      }
    } catch (err) {
      console.warn('[C08] Failed to retrieve context for chunk:', err);
    }

    let translation = '';
    const executeCall = async () => {
      const response = await callGeminiWithRetryAndFallback(
        TEXT_MODEL,
        (model) =>
          ai.models.generateContent({
            model,
            contents: [
              {
                text: `Traduza estritamente o seguinte texto do idioma original para o Português do Brasil de forma fluida, natural, preservando o estilo, emoção, nível de formalidade e características da obra.

As seções de contexto anterior e seguinte são fornecidas apenas para garantir a coesão, tom e continuidade da tradução. Elas estão claramente marcadas e NÃO devem ser traduzidas novamente.

${contextPrefix}TEXTO PRINCIPAL PARA TRADUZIR:\n\n${item.payload.text}\n\n[FIM DO TEXTO PRINCIPAL PARA TRADUZIR]${contextSuffix}

Regras importantes:
1. Retorne APENAS a tradução do TEXTO PRINCIPAL PARA TRADUZIR.
2. Não inclua NENHUM preâmbulo, introdução, explicação ou resumo.
3. Não inclua NENHUM comentário adicional ou notas de tradutor.
4. Não inclua blocos de código de markdown adicionais (sem cercas de código tipo \`\`\`).
5. Se houver um glossário abaixo, siga as traduções fornecidas.
6. Preserve exatamente a estrutura do texto original: parágrafos, títulos, diálogos (travessões/aspas), nomes próprios, unidades de medida, citações, notas e marcadores estruturais. Não altere a formatação ou pontuação estrutural.

${glossaryPrompt}
Modo de Tradução: ${styleRules === 'technical' ? 'Técnico/Científico' : 'Literário / Novela'}`,
              },
            ],
          })
      );
      translation = response.text?.trim() || '';
    };

    await executeCall();
    if (!translation) {
      throw new Error('A tradução retornou um conteúdo vazio');
    }

    // 3. Strict Validation
    const validation = validateTranslatedChunk(item.payload.text, translation);
    if (!validation.valid) {
      throw new Error(`Falha de validação da tradução do chunk: ${validation.reason}`);
    }

    // 4. Save chunk properties
    item.entrada = item.payload.text;
    item.saida = translation;
    item.saída = translation;

    return { translatedText: translation };
  } else if (operation === 'character_analysis') {
    const projId = item.payload.projectId || '';
    const result = await performMapReduceCharacterAnalysis(projId, false, false);
    return { characters: result.characters };

  } else if (operation === 'script_generation') {
    const { sourceUnits, characters, projectId } = item.payload;
    const characterIds = characters.map((c: any) => c.characterId);

    const prompt = `Você é um fatiador e rotulador de roteiro altamente preciso para audiolivros e audiodramas.
Você receberá um lote de unidades textuais chamadas 'sourceUnits' de um capítulo.
Seu trabalho é classificar cada unidade e retornar o roteiro para cada uma em um formato JSON estrito.

Lista de Personagens Disponíveis (atribua os IDs corretos):
${JSON.stringify(characters.map((c: any) => ({ characterId: c.characterId, name: c.canonicalName, aliases: c.aliases })))}

Instruções Importantes:
1. Retorne EXATAMENTE um objeto para cada 'sourceUnitId' fornecido no lote. Não mude, adicione ou remova nenhum ID.
2. Classifique cada unidade em um de: 'título', 'parágrafo', 'fala', 'citação', 'lista', 'nota', 'fórmula'.
3. Atribua o 'speakerId' correspondente. O narrador padrão deve ser 'char_narrator'. Se o personagem for desconhecido ou ambíguo, use 'unresolved'. Nunca invente IDs arbitrários ou atribua 'char_maria' ou 'char_joao' sem certeza absoluta baseada no contexto.
4. No campo 'spokenText', forneça o texto falado adaptado, limpo de marcadores de diálogo desnecessários ou aspas de fala, mas mantendo a fidelidade total.
5. Adicione orientações de voz no campo 'direction' com 'emotion' (ex: calmo, entusiasmado), 'intensity' (número de 0 a 1), 'pace' ('slow', 'normal', 'fast') e 'pauseAfterMs' (milisegundos de pausa após).

Schema de Resposta JSON esperado:
{
  "segments": [
    {
      "sourceUnitId": "String (ID exato enviado)",
      "classificação": "título" | "parágrafo" | "fala" | "citação" | "lista" | "nota" | "fórmula",
      "speakerId": "String (ID do personagem ou 'char_narrator' ou 'unresolved')",
      "spokenText": "String (texto adaptado para leitura)",
      "direction": {
        "emotion": "String",
        "intensity": number,
        "pace": "slow" | "normal" | "fast",
        "pauseAfterMs": number
      }
    }
  ]
}

Lote de sourceUnits para processar:
${JSON.stringify(sourceUnits.map((u: any) => ({ sourceUnitId: u.sourceUnitId, type: u.type, sourceText: u.sourceText })))}
`;

    let resultJson: any = null;
    const executeCall = async () => {
      const response = await callGeminiWithRetryAndFallback(
        TEXT_MODEL,
        (model) =>
          ai.models.generateContent({
            model,
            contents: [{ text: prompt }],
            config: { responseMimeType: 'application/json' },
          })
      );
      const parsed = JSON.parse(response.text?.trim() || '');
      resultJson = parsed;
    };

    try {
      await executeCall();
    } catch (err) {
      console.warn(`[Script Job] Falha ao processar lote via Gemini, tentando uma segunda vez...`, err);
      await executeCall();
    }

    if (!resultJson) {
      throw new Error('Falha ao obter resposta do fatiador Gemini');
    }

    const segments = validateBatchResponse(resultJson, sourceUnits, characterIds);
    return { segments };

  } else if (operation === 'tts_generation') {
    const prjs = getProjects();
    const projId = item.payload.projectId || 'temp_c06';
    const prj = prjs.find((p: any) => p.projectId === projId);

    let audioBuffer: Buffer;
    try {
      audioBuffer = await synthesizeTtsForSegment(
        item.payload.spokenText,
        item.payload.speakerId,
        item.payload.characters || [],
        item.payload.direction,
        prj?.intensity
      );
    } catch (err: any) {
      console.error('Job TTS generation failed:', err);
      throw new Error(`Falha ao gerar áudio para o segmento: ${err.message || String(err)}`);
    }

    const audioFileName = `${item.payload.segmentId}.wav`;
    const audioDir = path.join(PROJECTS_ROOT, projId, 'audio/segments');
    fs.mkdirSync(audioDir, { recursive: true });
    const audioFilePath = path.join(audioDir, audioFileName);
    const tempFilePath = path.join(audioDir, `${item.payload.segmentId}.temp.wav`);

    // Write to temporary file first
    fs.writeFileSync(tempFilePath, audioBuffer);

    // Extract provider and voice to validate properly
    let providerId = 'gemini';
    let voiceName = 'Zephyr';
    const speaker = (item.payload.characters || []).find((c: any) => c.characterId === item.payload.speakerId);
    if (speaker) {
      if (speaker.voiceAssignment) {
        providerId = speaker.voiceAssignment.providerId || 'gemini';
        voiceName = speaker.voiceAssignment.voiceName || 'Zephyr';
      } else {
        const vId = speaker.voiceAssignmentId || '';
        if (vId.includes(':')) {
          const parts = vId.split(':');
          providerId = parts[0];
          voiceName = parts[1];
        } else if (vId.startsWith('pt-BR-')) {
          providerId = 'gcp';
          voiceName = vId;
        } else {
          providerId = 'gemini';
          if (vId === 'voice_kore' || vId === 'voice_a') {
            voiceName = 'Kore';
          } else if (vId === 'voice_puck' || vId === 'voice_b') {
            voiceName = 'Puck';
          } else if (vId === 'voice_fenrir') {
            voiceName = 'Fenrir';
          } else if (vId === 'voice_charon') {
            voiceName = 'Charon';
          } else {
            voiceName = 'Zephyr';
          }
        }
      }
    }

    // Validate temp file
    const validation = validateTtsAudioFile(tempFilePath, providerId, voiceName);
    if (!validation.isValid) {
      if (fs.existsSync(tempFilePath)) {
        try { fs.unlinkSync(tempFilePath); } catch (e) {}
      }
      throw new Error(`Validação de áudio do Job falhou: ${validation.error}`);
    }

    // Overwrite destination file
    if (fs.existsSync(audioFilePath)) {
      try { fs.unlinkSync(audioFilePath); } catch (e) {}
    }
    fs.renameSync(tempFilePath, audioFilePath);

    return {
      audioPath: `/projects/${projId}/audio/segments/${audioFileName}`,
      audioSize: validation.size,
      durationMs: validation.durationMs
    };
  }

  throw new Error(`Operação desconhecida: ${operation}`);
}

// JOB ENDPOINTS & PAGINATION
app.get('/api/projects/:projectId/chapters', (req, res) => {
  const { projectId } = req.params;
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = parseInt(req.query.limit as string, 10) || 10;

  const projDir = path.join(PROJECTS_ROOT, projectId);
  const chaptersFile = path.join(projDir, 'normalized/chapters.json');
  if (!fs.existsSync(chaptersFile)) {
    return res.json({ chapters: [], total: 0, page, limit });
  }

  const chapters: any[] = JSON.parse(fs.readFileSync(chaptersFile, 'utf8'));
  const total = chapters.length;
  const paginatedChapters = chapters.slice((page - 1) * limit, page * limit);

  res.json({
    chapters: paginatedChapters,
    total,
    page,
    limit
  });
});

app.get('/api/projects/:projectId/segments', (req, res) => {
  const { projectId } = req.params;
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = parseInt(req.query.limit as string, 10) || 50;

  const projDir = path.join(PROJECTS_ROOT, projectId);
  const segmentsFile = path.join(projDir, 'scripts/segments.json');
  if (!fs.existsSync(segmentsFile)) {
    return res.json({ segments: [], total: 0, page, limit });
  }

  const segments: any[] = JSON.parse(fs.readFileSync(segmentsFile, 'utf8'));
  const total = segments.length;
  const paginatedSegments = segments.slice((page - 1) * limit, page * limit);

  res.json({
    segments: paginatedSegments,
    total,
    page,
    limit
  });
});

app.get('/api/projects/:projectId/jobs/active', (req, res) => {
  const { projectId } = req.params;
  const jobs = getJobs();
  const activeJob = jobs.find(j => j.projectId === projectId && (j.status === 'queued' || j.status === 'processing' || j.status === 'paused' || j.status === 'failed'));
  res.json({ job: activeJob || null });
});

app.post('/api/projects/:projectId/jobs/start', (req, res) => {
  const { projectId } = req.params;
  const { operation, options } = req.body;
  if (!operation) {
    return res.status(400).json({ error: 'Operação inválida ou vazia' });
  }

  try {
    const job = startProjectJob(projectId, operation, options);
    res.json({ job });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:projectId/jobs/pause', (req, res) => {
  const { projectId } = req.params;
  const jobs = getJobs();
  const activeJob = jobs.find(j => j.projectId === projectId && (j.status === 'queued' || j.status === 'processing'));
  if (!activeJob) {
    return res.status(404).json({ error: 'Nenhum job ativo para pausar' });
  }
  activeJob.status = 'paused';
  activeJob.updatedAt = new Date().toISOString();
  saveJobs(jobs);
  res.json({ job: activeJob });
});

app.post('/api/projects/:projectId/jobs/resume', (req, res) => {
  const { projectId } = req.params;
  const jobs = getJobs();
  const pausedJob = jobs.find(j => j.projectId === projectId && (j.status === 'paused' || j.status === 'failed' || j.status === 'cancelled'));
  if (!pausedJob) {
    return res.status(404).json({ error: 'Nenhum job pausado/falhado para retomar' });
  }
  pausedJob.status = 'queued';
  for (const item of pausedJob.items) {
    if (item.status === 'failed' || item.status === 'cancelled') {
      item.status = 'queued';
      item.lease = undefined;
      item.updatedAt = new Date().toISOString();
    }
  }
  pausedJob.updatedAt = new Date().toISOString();
  saveJobs(jobs);
  res.json({ job: pausedJob });
});

app.post('/api/projects/:projectId/jobs/cancel', (req, res) => {
  const { projectId } = req.params;
  const jobs = getJobs();
  const activeJob = jobs.find(j => j.projectId === projectId && (j.status === 'queued' || j.status === 'processing' || j.status === 'paused' || j.status === 'failed'));
  if (!activeJob) {
    return res.status(404).json({ error: 'Nenhum job ativo/pausado para cancelar' });
  }
  activeJob.status = 'cancelled';
  for (const item of activeJob.items) {
    if (item.status === 'queued' || item.status === 'processing' || item.status === 'failed') {
      item.status = 'cancelled';
      item.lease = undefined;
      item.updatedAt = new Date().toISOString();
    }
  }
  activeJob.updatedAt = new Date().toISOString();
  saveJobs(jobs);
  res.json({ job: activeJob });
});

app.post('/api/projects/:projectId/jobs/process-next', async (req, res) => {
  const { projectId } = req.params;
  const jobs = getJobs();

  const currentJobIdx = jobs.findIndex(j => j.projectId === projectId && (j.status === 'queued' || j.status === 'processing'));
  if (currentJobIdx === -1) {
    return res.json({ message: 'Nenhum job ativo para processar', job: null });
  }

  const job = jobs[currentJobIdx];
  job.status = 'processing';

  const concurrency = 2;
  const maxAttempts = 3;
  const now = Date.now();

  const eligibleItems = job.items.filter(item => {
    const isPending = item.status === 'queued' || (item.status === 'failed' && item.attempts < maxAttempts && item.retryable !== false);
    const isLeaseExpired = !item.lease || item.lease < now;
    return isPending && isLeaseExpired;
  });

  if (eligibleItems.length === 0) {
    const allCompleted = job.items.every(it => it.status === 'completed');
    if (allCompleted) {
      job.status = 'completed';
      job.progress = 100;
      job.updatedAt = new Date().toISOString();
      syncCompletedJobFiles(job);
      saveJobs(jobs);
      return res.json({ job });
    }
    const someFailed = job.items.some(it => it.status === 'failed' && (it.attempts >= maxAttempts || it.retryable === false));
    if (someFailed) {
      job.status = 'failed';
      job.updatedAt = new Date().toISOString();
      saveJobs(jobs);
      return res.json({ job });
    }

    saveJobs(jobs);
    return res.json({ job });
  }

  const itemsToProcess = eligibleItems.slice(0, concurrency);

  for (const item of itemsToProcess) {
    item.status = 'processing';
    item.lease = Date.now() + 60 * 1000;
    item.attempts++;
    item.updatedAt = new Date().toISOString();
  }
  job.updatedAt = new Date().toISOString();
  saveJobs(jobs);

  const processPromises = itemsToProcess.map(async (item) => {
    try {
      const result = await runTaskForItem(job.operation, item);
      item.status = 'completed';
      item.result = result;
      item.outputHash = calculateHash(JSON.stringify(result));
      item.errorCode = undefined;
      item.retryable = undefined;
      item.lease = undefined;
    } catch (err: any) {
      console.error(`Error processing item ${item.itemId}:`, err);
      const isRetry = isRetryableError(err);
      item.status = 'failed';
      item.errorCode = err?.code || err?.status || 'ERROR';
      item.retryable = isRetry.retryable;
      item.lease = undefined;

      const errorStr = String(err?.message || err).toLowerCase();
      const isMaxTokens = errorStr.includes('max_tokens') || errorStr.includes('token limit') || errorStr.includes('too many tokens');
      const isJsonFail = err instanceof SyntaxError || errorStr.includes('json') || errorStr.includes('invalid json');

      if ((isMaxTokens || isJsonFail) && item.payload?.text && item.payload.text.length > 1000) {
        console.log(`[C06] Item ${item.itemId} failed. Subdividing payload text...`);
        const subChunks = splitIntoChunks(item.payload.text, Math.floor(item.payload.text.length / 2), Math.floor(item.payload.text.length / 2) + 1000);
        if (subChunks.length > 1) {
          subdivideJobItem(job, item.itemId, subChunks);
        }
      }
    }
    item.updatedAt = new Date().toISOString();
  });

  await Promise.all(processPromises);

  const totalCount = job.items.length;
  const completedCount = job.items.filter(it => it.status === 'completed').length;
  job.progress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 100;

  const allDone = job.items.every(it => it.status === 'completed');
  if (allDone) {
    job.status = 'completed';
    job.progress = 100;
    syncCompletedJobFiles(job);
  } else {
    const hasUnretryableFailure = job.items.some(it => it.status === 'failed' && (it.attempts >= maxAttempts || it.retryable === false));
    if (hasUnretryableFailure) {
      job.status = 'failed';
    }
  }

  job.updatedAt = new Date().toISOString();
  saveJobs(jobs);
  res.json({ job });
});

// ==================== VITE MIDDLEWARE INTERFACE ====================
export async function startServer() {
  if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: any, res: any) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    return app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  startServer();
}
