import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';

// Spy on express application listen BEFORE importing server.ts to catch any startup calls
const listenSpy = vi.spyOn(express.application, 'listen');

import request from 'supertest';
import fs from 'fs';
import path from 'path';
import {
  app,
  updateStoragePaths,
  setLogger,
  setAiClient,
  validateUploadedFile,
  checkZipBomb,
  extractTextMd,
  extractHtml,
  extractDocx,
  extractPdf,
  extractEpubTextRefined,
  setMockOcrHandler,
  getOcrState,
  saveOcrState,
  runOcrLoop,
  subdivideBatch,
  normalizeAndSaveProject,
  splitIntoChunks,
  startProjectJob,
  getJobs,
  saveJobs,
  calculateHash,
  subdivideJobItem,
  validateTranslatedChunk,
  isLikelyUntranslatedCopy,
  detectLanguageLocally,
  extractDialogueSpeakerCandidates,
  isGenericCharacterAlias,
  recommendVoiceForCharacter,
  type OcrState,
  type OcrBatch
} from './server.ts';

describe('Regressões da auditoria funcional', () => {
  it('combina sexo, idade, timbre e energia do personagem com o perfil da voz', () => {
    const result = recommendVoiceForCharacter({
      canonicalName: 'Helena', role: 'character', genderPresentation: 'female',
      estimatedAge: 'jovem adulta', description: 'jovem firme e brilhante',
      personality: ['intensa'], speechStyle: { energy: 'high', timbre: 'bright' }
    }, ['gemini']);
    expect(result.recommended.profile.gender).toBe('female');
    expect(result.recommended.score).toBeGreaterThanOrEqual(75);
    expect(result.recommended.reasons).toContain('voz feminina');
  });

  it('favorece estabilidade e energia baixa para narradores maduros', () => {
    const result = recommendVoiceForCharacter({
      canonicalName: 'Narrador', role: 'narrator', genderPresentation: 'male',
      estimatedAge: 'maduro', description: 'voz grave, calma e pausada'
    }, ['gemini']);
    expect(result.recommended.profile.gender).toBe('male');
    expect(result.recommended.profile.energy).not.toBe('high');
    expect(result.recommended.reasons).toContain('estabilidade para narração');
  });

  it('preserva personagens nomeados que pronunciam falas isoladas', () => {
    const text = '— Não abra a porta — avisou Clara com voz firme. Uma menina chamada Clara apareceu na escada.';
    expect(extractDialogueSpeakerCandidates(text).map(candidate => candidate.candidateName)).toContain('Clara');
  });

  it('remove pronomes e descrições genéricas da lista de aliases', () => {
    expect(isGenericCharacterAlias('ela')).toBe(true);
    expect(isGenericCharacterAlias('uma menina')).toBe(true);
    expect(isGenericCharacterAlias('Dona Clara')).toBe(false);
  });
  it('detecta português localmente quando a IA ainda não está configurada', () => {
    const result = detectLanguageLocally('Na pequena cidade, Helena chegou à antiga casa durante uma tempestade. Ela abriu o diário e perguntou se havia alguém ali.');
    expect(result.languageCode).toBe('pt-BR');
    expect(result.confidence).toBeGreaterThanOrEqual(0.65);
  });

  it('detecta inglês localmente sem confundir com português', () => {
    const result = detectLanguageLocally('The old house was silent, but she opened the door and walked into the room with her brother.');
    expect(result.languageCode).toBe('en');
  });

  it('rejeita como falso sucesso uma tradução idêntica ao original em inglês', () => {
    const original = 'The Last Light of Aurora Station. A short mystery novella created to test AI audiobook applications.';
    expect(isLikelyUntranslatedCopy(original, original)).toBe(true);
    expect(validateTranslatedChunk(original, original).valid).toBe(false);
  });

  it('mantém amostras insuficientes como indeterminadas', () => {
    expect(detectLanguageLocally('Aurora').languageCode).toBe('und');
  });
});

// Silence logging in tests
beforeAll(() => {
  setLogger({
    info: () => {},
    log: () => {},
    warn: () => {},
    error: () => {},
  });
});

// Configure mock Gemini client to prevent real external API calls
const mockAi = {
  models: {
    generateContent: async (args?: any) => {
      const prompt = JSON.stringify(args || '').toLowerCase();

      // 1. Language Detection
      if (prompt.includes('language') || prompt.includes('bcp-47') || prompt.includes('idioma') || prompt.includes('detect')) {
        let languageCode = 'pt-BR';
        let confidence = 0.99;
        let evidence = 'O texto está claramente escrito em português brasileiro.';

        if (prompt.includes('beautifully')) {
          languageCode = 'und';
          confidence = 0.85;
          evidence = 'This text contains strong English indicators and is written in English language';
        } else if (prompt.includes('garbage')) {
          throw new Error('API Rate Limit Exceeded');
        }

        const resObj = { languageCode, confidence, evidence };
        return {
          text: JSON.stringify(resObj),
          candidates: [{
            content: {
              parts: [{ text: JSON.stringify(resObj) }]
            }
          }]
        };
      }

      // Default: Book Outline or generic outline
      return {
        text: '{"title": "Mocked Project", "chapters": []}',
        candidates: [{
          content: {
            parts: [{ text: '{"title": "Mocked Project", "chapters": []}' }]
          }
        }]
      };
    }
  }
};
setAiClient(mockAi);

describe.sequential('VoxLibro C00 - Base de Testes e Servidor Testável', () => {
  let tempDirs: string[] = [];

  // Helper to create and track a unique temp directory
  function createTempDir(): string {
    const dir = path.join(process.cwd(), `temp_test_data_${Math.random().toString(36).substring(2, 10)}`);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    tempDirs.push(dir);
    return dir;
  }

  // Cleanup all tracked temp directories
  afterAll(() => {
    for (const dir of tempDirs) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  });

  it('deve inicializar a aplicação com sucesso e ter as variáveis básicas expostas', () => {
    expect(app).toBeDefined();
    expect(typeof updateStoragePaths).toBe('function');
  });

  it('deve responder com sucesso no endpoint de saúde (GET /api/pricing)', async () => {
    const res = await request(app).get('/api/pricing');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('models');
  });

  it('deve garantir que o VoxLibro aceita a criação e leitura de projetos usando armazenamento temporário', async () => {
    const tempDir = createTempDir();
    updateStoragePaths(tempDir);

    // Initial project DB should be empty
    const listRes1 = await request(app).get('/api/projects');
    expect(listRes1.status).toBe(200);
    expect(listRes1.body.projects).toEqual([]);

    // Create a new project
    const createRes = await request(app)
      .post('/api/projects')
      .send({
        name: 'Projeto Teste C00',
        ownerId: 'owner_test_123',
        productionMode: 'solo',
        sourceLanguage: 'en',
        targetLanguage: 'pt-BR',
        translationEnabled: true,
        copyrightDeclared: true
      });

    expect(createRes.status).toBe(201); // 201 Created is returned on success
    expect(createRes.body).toHaveProperty('project');
    expect(createRes.body.project.name).toBe('Projeto Teste C00');

    // List projects again - should contain our newly created project
    const listRes2 = await request(app).get('/api/projects');
    expect(listRes2.status).toBe(200);
    expect(listRes2.body.projects).toHaveLength(1);
    expect(listRes2.body.projects[0].name).toBe('Projeto Teste C00');
  });

  it('deve provar o isolamento absoluto de dados entre duas execuções de teste diferentes', async () => {
    // Run 1: Set Path A, create Project A
    const pathA = createTempDir();
    updateStoragePaths(pathA);

    const createResA = await request(app)
      .post('/api/projects')
      .send({
        name: 'Project Alpha',
        ownerId: 'owner_alpha',
      });
    expect(createResA.status).toBe(201);

    const listResA = await request(app).get('/api/projects');
    expect(listResA.body.projects).toHaveLength(1);
    expect(listResA.body.projects[0].name).toBe('Project Alpha');

    // Run 2: Set Path B, should be empty, create Project B
    const pathB = createTempDir();
    updateStoragePaths(pathB);

    const listResB1 = await request(app).get('/api/projects');
    expect(listResB1.body.projects).toHaveLength(0); // Isolated! No Alpha project visible here.

    const createResB = await request(app)
      .post('/api/projects')
      .send({
        name: 'Project Beta',
        ownerId: 'owner_beta',
      });
    expect(createResB.status).toBe(201);

    const listResB2 = await request(app).get('/api/projects');
    expect(listResB2.body.projects).toHaveLength(1);
    expect(listResB2.body.projects[0].name).toBe('Project Beta');
  });

  it('deve garantir que importar o servidor NÃO escuta na porta 3000 de forma automática em ambiente de teste', () => {
    expect(listenSpy).not.toHaveBeenCalled();
  });
});

describe('VoxLibro C01 - Eliminação de Falsos Sucessos', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = path.join(process.cwd(), `temp_test_data_c01_${Math.random().toString(36).substring(2, 10)}`);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    updateStoragePaths(tempDir);
  });

  afterAll(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (e) {}
  });

  it('deve responder com sucesso no endpoint de capacidades (GET /api/capabilities)', async () => {
    const res = await request(app).get('/api/capabilities');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('translation');
    expect(res.body).toHaveProperty('tts');
  });

  it('deve falhar de forma transparente e tipada na tradução caso as chaves estejam ausentes', async () => {
    // Isolate OPENAI_API_KEY to guarantee missing key behavior
    const oldKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      // Create a project first
      const createRes = await request(app)
        .post('/api/projects')
        .send({
          name: 'Projeto Traducao Falha',
          ownerId: 'owner_test_123',
        });
      const projectId = createRes.body.project.projectId;

      // Create chapters file in project dir so it passes the chapters exist check
      const projDir = path.join(tempDir, projectId);
      const normalizedDir = path.join(projDir, 'normalized');
      if (!fs.existsSync(normalizedDir)) {
        fs.mkdirSync(normalizedDir, { recursive: true });
      }
      fs.writeFileSync(
        path.join(normalizedDir, 'chapters.json'),
        JSON.stringify([{ chapterId: 'ch1', title: 'Capítulo 1', originalText: 'Era uma vez...', status: 'pending' }])
      );

      // Call translate route
      const translateRes = await request(app)
        .post(`/api/projects/${projectId}/translate`)
        .send({ targetLanguage: 'es' });

      expect(translateRes.status).toBe(400);
      expect(translateRes.body).toHaveProperty('error');
      expect(translateRes.body.error).toHaveProperty('code');
      expect(translateRes.body.error).toHaveProperty('operation', 'translate_chapter');
      expect(translateRes.body.error.retryable).toBe(true);
    } finally {
      process.env.OPENAI_API_KEY = oldKey;
    }
  });
});

describe('VoxLibro C03 - Upload Seguro e Extração Real', () => {
  it('deve validar arquivos corretamente com validateUploadedFile', () => {
    // Test too large size
    const mockFileLarge = {
      fieldname: 'file',
      originalname: 'test.txt',
      encoding: '7bit',
      mimetype: 'text/plain',
      size: 100 * 1024 * 1024, // 100MB
      buffer: Buffer.from('hello'),
    } as any;
    expect(() => validateUploadedFile(mockFileLarge)).toThrow('excede o tamanho máximo');

    // Test invalid mime
    const mockFileMime = {
      fieldname: 'file',
      originalname: 'test.exe',
      encoding: '7bit',
      mimetype: 'application/x-msdownload',
      size: 100,
      buffer: Buffer.from('hello'),
    } as any;
    expect(() => validateUploadedFile(mockFileMime)).toThrow('Extensão de arquivo não permitida');

    // Test path traversal
    const mockFileTraversal = {
      fieldname: 'file',
      originalname: '../../test.txt',
      encoding: '7bit',
      mimetype: 'text/plain',
      size: 100,
      buffer: Buffer.from('hello'),
    } as any;
    expect(() => validateUploadedFile(mockFileTraversal)).toThrow('tentativa de path traversal');
  });

  it('deve extrair texto de arquivos TXT/MD com detecção de BOM', () => {
    const txtBuffer = Buffer.from('Olá Mundo!');
    const result = extractTextMd(txtBuffer);
    expect(result.text).toBe('Olá Mundo!');
    expect(result.stats.charactersCount).toBe(10);
    expect(result.stats.wordsCount).toBe(2);

    // With UTF-8 BOM
    const bomBuffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Bom Dia!')]);
    const bomResult = extractTextMd(bomBuffer);
    expect(bomResult.text).toBe('Bom Dia!');
  });

  it('deve extrair texto e remover scripts/styles de HTML', () => {
    const htmlContent = '<html><head><style>body { color: red; }</style></head><body><h1>Título Principal</h1><script>console.log("no");</script><p>Parágrafo Real.</p></body></html>';
    const result = extractHtml(Buffer.from(htmlContent, 'utf8'));
    expect(result.text).toContain('Título Principal');
    expect(result.text).toContain('Parágrafo Real.');
    expect(result.text).not.toContain('color: red');
    expect(result.text).not.toContain('console.log');
    expect(result.headings).toContain('Título Principal');
  });

  it('deve rejeitar PDFs escaneados ou inválidos', async () => {
    const dummyPdf = Buffer.from('25504446-dummy-pdf-without-text-content-so-it-is-considered-scanned-and-fails-ocr-check');
    await expect(extractPdf(dummyPdf)).rejects.toThrow();
  });
});

describe('VoxLibro C04 - OCR para PDFs Escaneados', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = path.join(process.cwd(), `temp_test_data_c04_${Math.random().toString(36).substring(2, 10)}`);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    updateStoragePaths(tempDir);
  });

  afterAll(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (e) {}
    setMockOcrHandler(null);
  });

  it('deve processar e salvar páginas de OCR válidas com sucesso', async () => {
    const projectId = 'proj_ocr_valido';
    const projDir = path.join(tempDir, projectId);
    fs.mkdirSync(projDir, { recursive: true });

    // Mock project DB
    const projectsFile = path.join(tempDir, 'projects.json');
    const mockProject = {
      projectId,
      name: 'Test Project OCR',
      ownerId: 'owner_test_ocr',
      status: 'extracting',
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(projectsFile, JSON.stringify([mockProject], null, 2));

    const sourcePath = path.join(projDir, 'source', 'document.pdf');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, 'pdf-dummy-content');

    const ocrState: OcrState = {
      projectId,
      originalFileName: 'document.pdf',
      fileMimeType: 'application/pdf',
      fileSize: 1000,
      sourcePath,
      totalPages: 2,
      isCancelled: false,
      digitalPages: [],
      batches: [
        {
          pageStart: 1,
          pageEnd: 2,
          inputHash: 'hash-1-2',
          status: 'pending',
          attempts: 0,
          model: 'gemini-3.5-flash',
          promptVersion: 'v1',
        },
      ],
    };
    saveOcrState(projectId, ocrState);

    // Setup mock OCR handler that returns valid structured JSON
    setMockOcrHandler(async (pId, batch, pagesToExtract) => {
      return JSON.stringify({
        pages: pagesToExtract.map(pNum => ({
          pageNumber: pNum,
          text: `Texto extraído da página ${pNum}`,
        })),
      });
    });

    await runOcrLoop(projectId);

    // Verify state was saved and is completed
    const state = getOcrState(projectId);
    expect(state.batches[0].status).toBe('completed');
    expect(state.batches[0].error).toBeUndefined();

    // Verify page files are written individually
    const ocrDir = path.join(projDir, 'extracted', 'ocr');
    expect(fs.existsSync(path.join(ocrDir, 'page-0001.txt'))).toBe(true);
    expect(fs.existsSync(path.join(ocrDir, 'page-0002.txt'))).toBe(true);

    // Verify reconstruction full.txt
    expect(fs.existsSync(path.join(ocrDir, 'full.txt'))).toBe(true);
    const fullText = fs.readFileSync(path.join(ocrDir, 'full.txt'), 'utf8');
    expect(fullText).toContain('Texto extraído da página 1');
    expect(fullText).toContain('Texto extraído da página 2');
  });

  it('deve acusar falha de validação e subdividir o lote se faltarem páginas', async () => {
    const projectId = 'proj_ocr_missing_page';
    const projDir = path.join(tempDir, projectId);
    fs.mkdirSync(projDir, { recursive: true });

    const sourcePath = path.join(projDir, 'source', 'document.pdf');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, 'pdf-dummy-content');

    const ocrState: OcrState = {
      projectId,
      originalFileName: 'document.pdf',
      fileMimeType: 'application/pdf',
      fileSize: 1000,
      sourcePath,
      totalPages: 3,
      isCancelled: false,
      digitalPages: [],
      batches: [
        {
          pageStart: 1,
          pageEnd: 3,
          inputHash: 'hash-1-3',
          status: 'pending',
          attempts: 0,
          model: 'gemini-3.5-flash',
          promptVersion: 'v1',
        },
      ],
    };
    saveOcrState(projectId, ocrState);

    // Setup mock OCR handler that misses page 2
    setMockOcrHandler(async (pId, batch, pagesToExtract) => {
      // Return only pages 1 and 3, skip page 2
      const pagesToReturn = pagesToExtract.filter(pNum => pNum !== 2);
      return JSON.stringify({
        pages: pagesToReturn.map(pNum => ({
          pageNumber: pNum,
          text: `Texto da página ${pNum}`,
        })),
      });
    });

    await runOcrLoop(projectId);

    // Verify batch was subdivided because it failed validation
    const state = getOcrState(projectId);
    // Batch 1-3 should be replaced by subdivided smaller batches recursively
    expect(state.batches).toHaveLength(3); // Subdivided into 1-1, 2-2, 3-3
    expect(state.batches[0].pageStart).toBe(1);
    expect(state.batches[0].pageEnd).toBe(1);
    expect(state.batches[0].status).toBe('completed');
    expect(state.batches[1].pageStart).toBe(2);
    expect(state.batches[1].pageEnd).toBe(2);
    expect(state.batches[1].status).toBe('failed');
    expect(state.batches[2].pageStart).toBe(3);
    expect(state.batches[2].pageEnd).toBe(3);
    expect(state.batches[2].status).toBe('completed');
  });

  it('deve acusar falha de validação e subdividir o lote se houver duplicidade de páginas', async () => {
    const projectId = 'proj_ocr_duplicate_page';
    const projDir = path.join(tempDir, projectId);
    fs.mkdirSync(projDir, { recursive: true });

    const sourcePath = path.join(projDir, 'source', 'document.pdf');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, 'pdf-dummy-content');

    const ocrState: OcrState = {
      projectId,
      originalFileName: 'document.pdf',
      fileMimeType: 'application/pdf',
      fileSize: 1000,
      sourcePath,
      totalPages: 2,
      isCancelled: false,
      digitalPages: [],
      batches: [
        {
          pageStart: 1,
          pageEnd: 2,
          inputHash: 'hash-1-2',
          status: 'pending',
          attempts: 0,
          model: 'gemini-3.5-flash',
          promptVersion: 'v1',
        },
      ],
    };
    saveOcrState(projectId, ocrState);

    // Setup mock OCR handler that returns duplicates
    setMockOcrHandler(async (pId, batch, pagesToExtract) => {
      return JSON.stringify({
        pages: [
          { pageNumber: 1, text: 'texto page 1' },
          { pageNumber: 1, text: 'duplicate text page 1' },
        ],
      });
    });

    await runOcrLoop(projectId);

    const state = getOcrState(projectId);
    expect(state.batches).toHaveLength(2); // Subdivided into 1-1 and 2-2
    expect(state.batches[0].pageStart).toBe(1);
    expect(state.batches[0].pageEnd).toBe(1);
  });

  it('deve subdividir o lote se estourar o limite de MAX_TOKENS', async () => {
    const projectId = 'proj_ocr_max_tokens';
    const projDir = path.join(tempDir, projectId);
    fs.mkdirSync(projDir, { recursive: true });

    const sourcePath = path.join(projDir, 'source', 'document.pdf');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, 'pdf-dummy-content');

    const ocrState: OcrState = {
      projectId,
      originalFileName: 'document.pdf',
      fileMimeType: 'application/pdf',
      fileSize: 1000,
      sourcePath,
      totalPages: 4,
      isCancelled: false,
      digitalPages: [],
      batches: [
        {
          pageStart: 1,
          pageEnd: 4,
          inputHash: 'hash-1-4',
          status: 'pending',
          attempts: 0,
          model: 'gemini-3.5-flash',
          promptVersion: 'v1',
        },
      ],
    };
    saveOcrState(projectId, ocrState);

    // Setup mock OCR handler that throws MAX_TOKENS error only on large batches
    setMockOcrHandler(async (pId, batch, pagesToExtract) => {
      if (pagesToExtract.length > 2) {
        throw new Error('Google GenAI Error: MAX_TOKENS exceeded limit on this batch payload.');
      }
      return JSON.stringify({
        pages: pagesToExtract.map(pNum => ({
          pageNumber: pNum,
          text: `Texto da página ${pNum}`,
        })),
      });
    });

    await runOcrLoop(projectId);

    // Verify batch subdivided dynamically on MAX_TOKENS
    const state = getOcrState(projectId);
    expect(state.batches).toHaveLength(2); // Split 1-4 into 1-2 and 3-4, and both completed
    expect(state.batches[0].pageStart).toBe(1);
    expect(state.batches[0].pageEnd).toBe(2);
    expect(state.batches[0].status).toBe('completed');
    expect(state.batches[1].pageStart).toBe(3);
    expect(state.batches[1].pageEnd).toBe(4);
    expect(state.batches[1].status).toBe('completed');
  });

  it('deve respeitar cancelamento no meio do processamento e retomar apenas pendentes/falhos', async () => {
    const projectId = 'proj_ocr_cancel_resume';
    const projDir = path.join(tempDir, projectId);
    fs.mkdirSync(projDir, { recursive: true });

    // Mock project DB
    const projectsFile = path.join(tempDir, 'projects.json');
    const mockProject = {
      projectId,
      name: 'Cancel Resume Test Project',
      ownerId: 'owner_ocr_cancel_resume',
      status: 'extracting',
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(projectsFile, JSON.stringify([mockProject], null, 2));

    const sourcePath = path.join(projDir, 'source', 'document.pdf');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, 'pdf-dummy-content');

    const ocrState: OcrState = {
      projectId,
      originalFileName: 'document.pdf',
      fileMimeType: 'application/pdf',
      fileSize: 1000,
      sourcePath,
      totalPages: 4,
      isCancelled: false,
      digitalPages: [],
      batches: [
        {
          pageStart: 1,
          pageEnd: 2,
          inputHash: 'hash-1-2',
          status: 'completed',
          attempts: 1,
          model: 'gemini-3.5-flash',
          promptVersion: 'v1',
        },
        {
          pageStart: 3,
          pageEnd: 4,
          inputHash: 'hash-3-4',
          status: 'pending',
          attempts: 0,
          model: 'gemini-3.5-flash',
          promptVersion: 'v1',
        },
      ],
    };
    saveOcrState(projectId, ocrState);

    // Create the page text files for already completed batch 1-2 to avoid finalizer missing files error
    const ocrDir = path.join(projDir, 'extracted', 'ocr');
    fs.mkdirSync(ocrDir, { recursive: true });
    fs.writeFileSync(path.join(ocrDir, 'page-0001.txt'), 'page 1 text');
    fs.writeFileSync(path.join(ocrDir, 'page-0002.txt'), 'page 2 text');

    // Setup mock OCR handler to cancel inside execution to simulate mid-loop cancellation
    let firstCall = true;
    setMockOcrHandler(async (pId, batch, pagesToExtract) => {
      if (firstCall) {
        firstCall = false;
        // Trigger cancel inside state
        const state = getOcrState(projectId);
        state.isCancelled = true;
        saveOcrState(projectId, state);
      }
      return JSON.stringify({
        pages: pagesToExtract.map(pNum => ({
          pageNumber: pNum,
          text: `Texto extraído da página ${pNum}`,
        })),
      });
    });

    await runOcrLoop(projectId);

    // State should stop processing and batch 3-4 should be processing or cancelled
    const stateAfterCancel = getOcrState(projectId);
    expect(stateAfterCancel.isCancelled).toBe(true);

    // Now resume by posting to start endpoint
    const startRes = await request(app).post(`/api/projects/${projectId}/ocr/start`);
    expect(startRes.status).toBe(200);

    // Verify cancelled reset
    const resumedState = getOcrState(projectId);
    expect(resumedState.isCancelled).toBe(false);
  });
});

describe('VoxLibro C05 - Pipeline Textual Lossless', () => {
  const tempDir = path.join('/tmp', 'voxlibro-tests-' + Date.now());

  beforeAll(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    updateStoragePaths(tempDir);
  });

  it('deve realizar normalização determinística, salvar artefatos e gerar relatório de integridade perfeito', async () => {
    const projectId = 'proj_c05_test';
    const projDir = path.join(tempDir, projectId);
    fs.mkdirSync(projDir, { recursive: true });

    // Mock projects database
    const projectsFile = path.join(tempDir, 'projects.json');
    const mockProject = {
      projectId,
      name: 'Test Project C05',
      ownerId: 'owner_c05',
      status: 'extracting',
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(projectsFile, JSON.stringify([mockProject], null, 2));

    const sampleBuffer = Buffer.from('Original File Buffer Content PDF/DOCX');
    const sampleRawText = 'Capa e Introducao do Livro\nCapítulo 1: O Comeco de Tudo\nEste é o corpo do primeiro capítulo com texto real.\nReferências Bibliográficas\nLivro do Autor, 2026.';

    // Execute normalization
    await normalizeAndSaveProject(
      projectId,
      sampleRawText,
      ['Capítulo 1: O Comeco de Tudo'],
      [],
      'pdf-local',
      { pagesCount: 1 },
      'test-book.pdf',
      'application/pdf',
      sampleBuffer.length,
      path.join(projDir, 'source', 'document.pdf'),
      sampleBuffer
    );

    // 1. Verify subdirectories
    expect(fs.existsSync(path.join(projDir, 'source'))).toBe(true);
    expect(fs.existsSync(path.join(projDir, 'extracted'))).toBe(true);
    expect(fs.existsSync(path.join(projDir, 'normalized/chapters'))).toBe(true);
    expect(fs.existsSync(path.join(projDir, 'integrity'))).toBe(true);

    // 2. Verify source/original has raw buffer
    const savedOriginal = fs.readFileSync(path.join(projDir, 'source', 'original'));
    expect(savedOriginal.toString()).toBe('Original File Buffer Content PDF/DOCX');

    // 3. Verify extracted/full.txt has full text
    const savedFullText = fs.readFileSync(path.join(projDir, 'extracted', 'full.txt'), 'utf8');
    expect(savedFullText).toBe(sampleRawText);

    // 4. Verify book-manifest.json
    const savedBookManifest = JSON.parse(fs.readFileSync(path.join(projDir, 'normalized', 'book-manifest.json'), 'utf8'));
    expect(savedBookManifest.title).toBeDefined();
    expect(savedBookManifest.totalSourceChars).toBe(sampleRawText.length);

    // 5. Verify integrity report math and hashes
    const savedReport = JSON.parse(fs.readFileSync(path.join(projDir, 'integrity', 'report.json'), 'utf8'));
    expect(savedReport.totalSourceChars).toBe(sampleRawText.length);
    expect(savedReport.percentual).toBe(100);
    expect(savedReport.normalized_complete).toBe(true);
    expect(savedReport.missingChars).toBe(0);
    expect(savedReport.duplicatedChars).toBe(0);

    // 6. Verify GET integrity API endpoint
    const res = await request(app).get(`/api/projects/${projectId}/integrity`);
    expect(res.status).toBe(200);
    expect(res.body.report.totalSourceChars).toBe(sampleRawText.length);
    expect(res.body.report.percentual).toBe(100);
  });
});

describe('VoxLibro C06 - Jobs Resumíveis e Chunking', () => {
  const tempDir = path.join('/tmp', 'voxlibro-tests-c06-' + Date.now());

  beforeAll(() => {
    fs.mkdirSync(tempDir, { recursive: true });
    updateStoragePaths(tempDir);
  });

  it('deve fatiar texto respeitando limites e estruturas (Chunker)', () => {
    const text = 'Esta é uma sentença simples. Aqui temos outra sentença curta.\n\nE aqui um novo parágrafo completo.';
    
    // Chunk with small limit to force splitting
    const chunks = splitIntoChunks(text, 30, 45);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toBeDefined();
    
    // Check that standard sentence boundaries or paragraph boundaries are kept
    const longText = 'A'.repeat(50);
    const splitLong = splitIntoChunks(longText, 10, 15);
    expect(splitLong.length).toBeGreaterThan(2);
    expect(splitLong[0].length).toBeLessThanOrEqual(15);
  });

  it('deve criar um Job e seus JobItems e garantir idempotência por hash', () => {
    const projectId = 'proj_c06_idempotency';
    const projDir = path.join(tempDir, projectId);
    fs.mkdirSync(path.join(projDir, 'normalized'), { recursive: true });

    // Mock project DB
    const projectsFile = path.join(tempDir, 'projects.json');
    const mockProject = {
      projectId,
      name: 'Idempotency Project',
      status: 'extracting',
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(projectsFile, JSON.stringify([mockProject], null, 2));

    // Mock chapters
    const chaptersFile = path.join(projDir, 'normalized/chapters.json');
    const mockChapters = [
      { chapterId: 'ch1', title: 'Capítulo 1', originalText: 'Texto curto para tradução.' }
    ];
    fs.writeFileSync(chaptersFile, JSON.stringify(mockChapters, null, 2));

    // Start translation job
    const job1 = startProjectJob(projectId, 'translation', { style: 'literário' });
    expect(job1).toBeDefined();
    expect(job1.items.length).toBe(1);
    expect(job1.items[0].status).toBe('queued');

    // Simulate completion
    job1.items[0].status = 'completed';
    job1.items[0].result = { translatedText: 'Texto curto traduzido.' };
    job1.items[0].outputHash = calculateHash(JSON.stringify(job1.items[0].result));
    saveJobs(getJobs().map(j => j.jobId === job1.jobId ? job1 : j));

    // Start another job with same input/config to verify idempotency/reuse of completed items
    const job2 = startProjectJob(projectId, 'translation', { style: 'literário' });
    expect(job2.items[0].status).toBe('completed');
    expect(job2.items[0].result?.translatedText).toBe('Texto curto traduzido.');
  });

  it('não deve reutilizar cache de tradução quando a saída é cópia do original em inglês', () => {
    const projectId = 'proj_c06_invalid_translation_cache';
    const projDir = path.join(tempDir, projectId);
    fs.mkdirSync(path.join(projDir, 'normalized'), { recursive: true });

    const originalText = 'The Last Light of Aurora Station. A short mystery novella created to test AI audiobook applications.';
    const projectsFile = path.join(tempDir, 'projects.json');
    const projects = fs.existsSync(projectsFile) ? JSON.parse(fs.readFileSync(projectsFile, 'utf8')) : [];
    projects.push({
      projectId,
      name: 'Invalid Cache Project',
      status: 'translating',
      updatedAt: new Date().toISOString(),
    });
    fs.writeFileSync(projectsFile, JSON.stringify(projects, null, 2));

    fs.writeFileSync(path.join(projDir, 'normalized/chapters.json'), JSON.stringify([
      { chapterId: 'ch1', title: 'Chapter 1', originalText, status: 'pending' }
    ], null, 2));

    const staleJob = startProjectJob(projectId, 'translation', { style: 'literário' });
    staleJob.items[0].status = 'completed';
    staleJob.items[0].result = { translatedText: originalText };
    staleJob.items[0].outputHash = calculateHash(JSON.stringify(staleJob.items[0].result));
    staleJob.status = 'completed';
    saveJobs(getJobs().map(j => j.jobId === staleJob.jobId ? staleJob : j));

    const freshJob = startProjectJob(projectId, 'translation', { style: 'literário' });
    expect(freshJob.items[0].status).toBe('queued');
    expect(freshJob.items[0].result).toBeUndefined();
  });

  it('deve subdividir um JobItem que falhou (auto-subdivisão por tokens)', () => {
    const projectId = 'proj_c06_subdivision';
    const job = {
      jobId: 'job_sub',
      projectId,
      operation: 'translation' as const,
      status: 'processing' as const,
      progress: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items: [
        {
          itemId: 'item_parent',
          jobId: 'job_sub',
          status: 'failed' as const,
          attempts: 1,
          inputHash: 'hash_parent',
          model: 'gemini-3.5-flash',
          promptVersion: 'v1',
          configurationHash: 'hash_config',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          payload: { text: 'Parágrafo um do texto longo.\n\nParágrafo dois do texto longo.' }
        }
      ]
    };

    const success = subdivideJobItem(job, 'item_parent', [
      'Parágrafo um do texto longo.',
      'Parágrafo dois do texto longo.'
    ]);

    expect(success).toBe(true);
    expect(job.items.length).toBe(2);
    expect(job.items[0].itemId).toContain('item_parent_sub_0');
    expect(job.items[0].payload.text).toBe('Parágrafo um do texto longo.');
  });

  it('deve suportar controle de concorrência, pausa, retomada e cancelamento por endpoints', async () => {
    const projectId = 'proj_c06_control';
    const projDir = path.join(tempDir, projectId);
    fs.mkdirSync(path.join(projDir, 'normalized'), { recursive: true });

    const projectsFile = path.join(tempDir, 'projects.json');
    fs.writeFileSync(projectsFile, JSON.stringify([{ projectId, name: 'Control Project' }], null, 2));

    const chaptersFile = path.join(projDir, 'normalized/chapters.json');
    fs.writeFileSync(chaptersFile, JSON.stringify([{ chapterId: 'ch1', title: 'Capítulo 1', originalText: 'Texto original.' }], null, 2));

    // Start Job via API
    const startRes = await request(app)
      .post(`/api/projects/${projectId}/jobs/start`)
      .send({ operation: 'translation', options: { style: 'literário' } });
    expect(startRes.status).toBe(200);
    expect(startRes.body.job.status).toBe('queued');

    // Pause Job via API
    const pauseRes = await request(app).post(`/api/projects/${projectId}/jobs/pause`);
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.job.status).toBe('paused');

    // Resume Job via API
    const resumeRes = await request(app).post(`/api/projects/${projectId}/jobs/resume`);
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.job.status).toBe('queued');

    // Cancel Job via API
    const cancelRes = await request(app).post(`/api/projects/${projectId}/jobs/cancel`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.job.status).toBe('cancelled');
  });

  it('deve paginar capítulos e segmentos corretamente', async () => {
    const projectId = 'proj_c06_pagination';
    const projDir = path.join(tempDir, projectId);
    fs.mkdirSync(path.join(projDir, 'normalized'), { recursive: true });
    fs.mkdirSync(path.join(projDir, 'scripts'), { recursive: true });

    // Write 5 chapters
    const chapters = Array.from({ length: 5 }, (_, i) => ({
      chapterId: `ch_${i}`,
      title: `Capítulo ${i}`,
      originalText: `Conteúdo ${i}`
    }));
    fs.writeFileSync(path.join(projDir, 'normalized/chapters.json'), JSON.stringify(chapters, null, 2));

    // Write 5 segments
    const segments = Array.from({ length: 5 }, (_, i) => ({
      segmentId: `seg_${i}`,
      spokenText: `Fala ${i}`,
      order: i
    }));
    fs.writeFileSync(path.join(projDir, 'scripts/segments.json'), JSON.stringify(segments, null, 2));

    // Test chapters pagination
    const chapRes = await request(app).get(`/api/projects/${projectId}/chapters?page=2&limit=2`);
    expect(chapRes.status).toBe(200);
    expect(chapRes.body.chapters.length).toBe(2);
    expect(chapRes.body.total).toBe(5);
    expect(chapRes.body.chapters[0].chapterId).toBe('ch_2');

    // Test segments pagination
    const segRes = await request(app).get(`/api/projects/${projectId}/segments?page=2&limit=3`);
    expect(segRes.status).toBe(200);
    expect(segRes.body.segments.length).toBe(2); // page 2 with limit 3 returns remaining 2 items
    expect(segRes.body.total).toBe(5);
    expect(segRes.body.segments[0].segmentId).toBe('seg_3');
  });

  describe('VoxLibro C07 - Configurações Confiáveis', () => {
    let projDir: string;
    const projectId = 'proj_c07_test';
    let originalApiKey: string | undefined;

    beforeAll(() => {
      originalApiKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'mock-api-key';
      projDir = path.join(tempDir, projectId);
      fs.mkdirSync(path.join(projDir, 'normalized'), { recursive: true });
      fs.mkdirSync(path.join(projDir, 'translation'), { recursive: true });
    });

    afterAll(() => {
      process.env.OPENAI_API_KEY = originalApiKey;
      setAiClient(mockAi);
    });

    it('deve realizar detecção de idiomas de forma sequencial garantindo isolamento de mocks (fallback en, pt-BR, falhas und)', async () => {
      const projectsFile = path.join(tempDir, 'projects.json');

      // 1. Fallback para Inglês (und -> en)
      const enProjectId = projectId + '_en';
      const enProjDir = path.join(tempDir, enProjectId);
      fs.mkdirSync(path.join(enProjDir, 'normalized'), { recursive: true });

      fs.writeFileSync(projectsFile, JSON.stringify([
        {
          projectId: enProjectId,
          name: 'English Book',
          status: 'extracting',
          updatedAt: new Date().toISOString(),
        }
      ], null, 2));

      const sampleTextEn = 'This is a beautifully written chapter in English with some words.';
      await normalizeAndSaveProject(
        enProjectId,
        sampleTextEn,
        ['Chapter 1'],
        [],
        'txt-local',
        {},
        'book.txt',
        'text/plain',
        Buffer.from(sampleTextEn).length,
        path.join(enProjDir, 'source', 'book.txt'),
        Buffer.from(sampleTextEn)
      );

      let projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      let project = projects.find((p: any) => p.projectId === enProjectId);

      expect(project.sourceLanguage).toBe('en');
      expect(Number(project.languageConfidence)).toBe(0.85);
      expect(project.languageEvidence).toContain('English');

      // 2. Identificação de pt-BR (sem tradução exigida)
      const ptProjectId = projectId + '_pt';
      const ptProjDir = path.join(tempDir, ptProjectId);
      fs.mkdirSync(path.join(ptProjDir, 'normalized'), { recursive: true });

      projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      projects.push({
        projectId: ptProjectId,
        name: 'Livro Brasileiro',
        status: 'extracting',
        updatedAt: new Date().toISOString(),
      });
      fs.writeFileSync(projectsFile, JSON.stringify(projects, null, 2));

      const sampleTextPt = 'Isto é um livro em português do Brasil.';
      await normalizeAndSaveProject(
        ptProjectId,
        sampleTextPt,
        ['Capítulo 1'],
        [],
        'txt-local',
        {},
        'book.txt',
        'text/plain',
        Buffer.from(sampleTextPt).length,
        path.join(ptProjDir, 'source', 'book.txt'),
        Buffer.from(sampleTextPt)
      );

      projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      project = projects.find((p: any) => p.projectId === ptProjectId);

      expect(project.sourceLanguage).toBe('pt-BR');
      expect(project.status).toBe('awaiting_configuration');
      
      const ptChaptersFile = path.join(ptProjDir, 'normalized/chapters.json');
      const ptChapters = JSON.parse(fs.readFileSync(ptChaptersFile, 'utf8'));
      expect(ptChapters[0].status).toBe('translation_not_required');

      // 3. Indeterminação de idioma (und/unknown)
      const undProjectId = projectId + '_und';
      const undProjDir = path.join(tempDir, undProjectId);
      fs.mkdirSync(path.join(undProjDir, 'normalized'), { recursive: true });

      projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      projects.push({
        projectId: undProjectId,
        name: 'Inconclusive Book',
        status: 'extracting',
        updatedAt: new Date().toISOString(),
      });
      fs.writeFileSync(projectsFile, JSON.stringify(projects, null, 2));

      const sampleTextUnd = 'Some garbage text that language detection fails to process.';
      await normalizeAndSaveProject(
        undProjectId,
        sampleTextUnd,
        ['Chapter 1'],
        [],
        'txt-local',
        {},
        'book.txt',
        'text/plain',
        Buffer.from(sampleTextUnd).length,
        path.join(undProjDir, 'source', 'book.txt'),
        Buffer.from(sampleTextUnd)
      );

      projects = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      project = projects.find((p: any) => p.projectId === undProjectId);

      expect(project.sourceLanguage).toBe('und');
      expect(Number(project.languageConfidence)).toBe(0);
      expect(project.languageEvidence).toContain('API Rate Limit Exceeded');
    });

    it('deve suportar persistência de Audiodrama, correções manuais e validação de intensidade 0-1', async () => {
      // Initialize projects in state
      const projectsFile = path.join(tempDir, 'projects.json');
      fs.writeFileSync(projectsFile, JSON.stringify([
        {
          projectId,
          name: 'Original Title',
          status: 'awaiting_configuration',
          detectedTitle: 'Suggested Title',
          sourceLanguage: 'es',
          recommendedProductionMode: 'audiodrama',
          productionMode: 'audiobook',
          translationEnabled: true,
          intensity: 0.5
        }
      ], null, 2));

      // Trigger /api/projects/:projectId/configure manually
      const res = await request(app)
        .post(`/api/projects/${projectId}/configure`)
        .send({
          userTitle: 'User Corrected Title',
          selectedProductionMode: 'audiodrama',
          sourceLanguage: 'es',
          translationEnabled: false,
          intensity: 0.8
        });

      expect(res.status).toBe(200);
      expect(res.body.project.userTitle).toBe('User Corrected Title');
      expect(res.body.project.selectedProductionMode).toBe('audiodrama');
      expect(res.body.project.intensity).toBe(0.8);
      expect(res.body.project.translationEnabled).toBe(false);
      expect(res.body.project.status).toBe('analyzing_characters');

      // Attempt invalid intensity value
      const badIntensityRes = await request(app)
        .post(`/api/projects/${projectId}/configure`)
        .send({
          userTitle: 'Title',
          selectedProductionMode: 'audiodrama',
          sourceLanguage: 'es',
          translationEnabled: false,
          intensity: 1.5 // Invalid, > 1.0
        });

      expect(badIntensityRes.status).toBe(400);
      expect(badIntensityRes.body.error).toContain('Intensidade');
    });

    it('deve respeitar translationEnabled=false e pular etapa de tradução', async () => {
      const projectsFile = path.join(tempDir, 'projects.json');
      const mockProject = {
        projectId,
        name: 'Obra Estrangeira',
        status: 'translating',
        sourceLanguage: 'en',
        translationEnabled: false,
        intensity: 0.8
      };
      fs.writeFileSync(projectsFile, JSON.stringify([mockProject], null, 2));

      const chaptersFile = path.join(projDir, 'normalized/chapters.json');
      fs.writeFileSync(chaptersFile, JSON.stringify([
        {
          chapterId: 'ch1',
          title: 'Chapter One',
          originalText: 'Once upon a time...',
          status: 'pending'
        }
      ], null, 2));

      // Trigger translate API
      const res = await request(app)
        .post(`/api/projects/${projectId}/translate`)
        .send({ options: { style: 'literário' } });

      expect(res.status).toBe(200);
      expect(res.body.project.status).toBe('analyzing_characters');
      expect(res.body.chapters[0].translatedText).toBeUndefined();
      expect(res.body.chapters[0].status).toBe('translation_not_required');
    });
  });
});
