import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { 
  pcmToWav,
  getWavDurationAndValidate,
  validateProjectForExport,
  concatenateWavFilesWithPausesAsync,
  convertWavToMp3WithMetadata,
  getMp3InfoAndValidate,
  createExportZip,
  ExportJob,
  getExportJobs,
  saveExportJobs
} from './server';

describe('VoxLibro C13 - Montagem e Exportação Reais', () => {
  const PROJECTS_ROOT = path.join(process.cwd(), 'projects');
  const TEST_PROJECT_ID = 'test_proj_c13';
  const projDir = path.join(PROJECTS_ROOT, TEST_PROJECT_ID);

  beforeEach(() => {
    vi.stubEnv('GEMINI_API_KEY', 'fake-gemini-key');
    if (!fs.existsSync(PROJECTS_ROOT)) {
      fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
    }
    // Setup dummy project directories
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(path.join(projDir, 'audio/segments'), { recursive: true });
    fs.mkdirSync(path.join(projDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(projDir, 'normalized/chapters'), { recursive: true });
    fs.mkdirSync(path.join(projDir, 'translation'), { recursive: true });
    fs.mkdirSync(path.join(projDir, 'narrative-bible'), { recursive: true });
    fs.mkdirSync(path.join(projDir, 'exports'), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    
    // Clean up project dir
    if (fs.existsSync(projDir)) {
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  });

  it('deve concatenar três WAVs com pausas e calcular a duração exata esperada', async () => {
    // Generate 3 WAV files:
    // Seg 1: 500ms -> 24000 Hz, 1 channel, 16-bit = 24000 bytes PCM
    const pcm1 = Buffer.alloc(24000);
    const wav1 = pcmToWav(pcm1, 24000);
    const path1 = path.join(projDir, 'audio/segments/seg1.wav');
    fs.writeFileSync(path1, wav1);

    // Seg 2: 1000ms -> 48000 bytes PCM
    const pcm2 = Buffer.alloc(48000);
    const wav2 = pcmToWav(pcm2, 24000);
    const path2 = path.join(projDir, 'audio/segments/seg2.wav');
    fs.writeFileSync(path2, wav2);

    // Seg 3: 1500ms -> 72000 bytes PCM
    const pcm3 = Buffer.alloc(72000);
    const wav3 = pcmToWav(pcm3, 24000);
    const path3 = path.join(projDir, 'audio/segments/seg3.wav');
    fs.writeFileSync(path3, wav3);

    const inputWavPaths = [
      { path: path1, pauseBeforeMs: 100, pauseAfterMs: 200 },
      { path: path2, pauseBeforeMs: 300, pauseAfterMs: 400 },
      { path: path3, pauseBeforeMs: 500, pauseAfterMs: 600 }
    ];

    const outputPath = path.join(projDir, 'exports/temp_concatenated.wav');

    // Expected duration = (100 + 500 + 200) + (300 + 1000 + 400) + (500 + 1500 + 600) = 800 + 1700 + 2600 = 5100 ms
    const result = await concatenateWavFilesWithPausesAsync(inputWavPaths, outputPath, 24000);

    expect(result.durationMs).toBe(5100);
    expect(fs.existsSync(outputPath)).toBe(true);

    const mergedWavValidation = getWavDurationAndValidate(fs.readFileSync(outputPath));
    expect(mergedWavValidation.isValid).toBe(true);
    expect(mergedWavValidation.durationMs).toBe(5100);

    // Clean up
    fs.unlinkSync(outputPath);
  });

  it('deve falhar na validação e listar explicitamente segmentos ausentes ou com erro', () => {
    // Write scripts/segments.json with missing or failed segments
    const segments = [
      {
        segmentId: 'seg_01',
        order: 1,
        chapterId: 'ch_01',
        speakerId: 'narrador',
        status: 'ready',
        audioPath: 'projects/test_proj_c13/audio/segments/seg_01.wav'
      },
      {
        segmentId: 'seg_02',
        order: 2,
        chapterId: 'ch_01',
        speakerId: 'narrador',
        status: 'failed', // Should block validation
        audioPath: 'projects/test_proj_c13/audio/segments/seg_02.wav'
      },
      {
        segmentId: 'seg_03',
        order: 3,
        chapterId: 'ch_01',
        speakerId: 'narrador',
        status: 'ready'
        // Missing audioPath and file
      }
    ];

    fs.writeFileSync(
      path.join(projDir, 'scripts/segments.json'),
      JSON.stringify(segments, null, 2)
    );

    // Create file for seg_01
    const pcm = Buffer.alloc(12000);
    fs.writeFileSync(
      path.join(projDir, 'audio/segments/seg_01.wav'),
      pcmToWav(pcm, 24000)
    );

    const valResult = validateProjectForExport(TEST_PROJECT_ID);
    expect(valResult.isValid).toBe(false);
    expect(valResult.missingSegments).toBeDefined();
    expect(valResult.missingSegments?.length).toBeGreaterThanOrEqual(2);

    const errStr = valResult.error || '';
    expect(errStr).toContain('seg_02');
    expect(errStr).toContain('seg_03');
  });

  it('deve converter WAV para MP3 real com codec e metadados ID3 válidos', async () => {
    // Generate a valid source WAV file (500ms)
    const pcm = Buffer.alloc(24000);
    const wav = pcmToWav(pcm, 24000);
    const wavPath = path.join(projDir, 'exports/source_test.wav');
    fs.writeFileSync(wavPath, wav);

    const mp3Path = path.join(projDir, 'exports/destination_test.mp3');

    const metadata = {
      title: 'Capítulo 1 - Início C13',
      artist: 'Sérgio Sargenti',
      album: 'The Last Light of Aurora Station',
      comment: 'Sintetizado por IA com VoxLibro'
    };

    await convertWavToMp3WithMetadata(wavPath, mp3Path, metadata);

    expect(fs.existsSync(mp3Path)).toBe(true);

    const mp3Info = await getMp3InfoAndValidate(mp3Path);
    expect(mp3Info.isValid).toBe(true);
    expect(mp3Info.container).toBe('mp3');
    expect(mp3Info.codec).toBe('mp3');
    expect(mp3Info.size).toBeGreaterThan(0);
    expect(mp3Info.durationMs).toBeGreaterThanOrEqual(400);
    expect(mp3Info.durationMs).toBeLessThanOrEqual(650);

    // Clean up
    fs.unlinkSync(wavPath);
    fs.unlinkSync(mp3Path);
  });

  it('deve criar um arquivo ZIP real contendo todos os assets e checksums correspondentes', async () => {
    // Generate some mock chapters, translations, bibles, and segment audio
    fs.writeFileSync(path.join(projDir, 'normalized/chapters.json'), JSON.stringify([{ chapterId: 'ch1', order: 1, title: 'Introducao' }]));
    fs.writeFileSync(path.join(projDir, 'normalized/chapters/ch1.txt'), 'Texto do capitulo 1');
    fs.writeFileSync(path.join(projDir, 'translation/glossary.json'), JSON.stringify([{ original: 'Aurora', translation: 'Aurora' }]));
    fs.writeFileSync(path.join(projDir, 'translation/report.json'), JSON.stringify({ accuracy: 1 }));
    fs.writeFileSync(path.join(projDir, 'narrative-bible/characters.json'), JSON.stringify([{ characterId: 'char1', name: 'Lia' }]));
    fs.writeFileSync(path.join(projDir, 'scripts/segments.json'), JSON.stringify([{ segmentId: 'seg1', order: 1, chapterId: 'ch1', speakerId: 'char1', spokenText: 'Hello world' }]));

    const mockChapterMp3 = path.join(projDir, 'exports/chapter_1.mp3');
    fs.writeFileSync(mockChapterMp3, 'fake mp3 content');

    const zipPath = path.join(projDir, 'exports/test_export.zip');

    const compiledChapters = [
      { chapterId: 'ch1', order: 1, title: 'Introducao', path: mockChapterMp3, durationMs: 1200, size: 5000 }
    ];

    const zipResult = await createExportZip(
      TEST_PROJECT_ID,
      'Obra VoxLibro C13',
      compiledChapters,
      null,
      zipPath
    );

    expect(fs.existsSync(zipPath)).toBe(true);
    expect(zipResult.size).toBeGreaterThan(0);
    expect(zipResult.checksum).toHaveLength(64);

    // Extract and verify checksums
    const zip = new AdmZip(zipPath);
    const manifestEntry = zip.getEntry('manifest.json');
    expect(manifestEntry).toBeDefined();

    const checksumsEntry = zip.getEntry('checksums.sha256');
    expect(checksumsEntry).toBeDefined();

    const checksumsText = checksumsEntry?.getData().toString('utf8') || '';
    expect(checksumsText).toContain('manifest.json');
    expect(checksumsText).toContain('original-texts/chapters.json');
    expect(checksumsText).toContain('audio/chapter_1.mp3');

    // Parse checksums and verify actual files
    const lines = checksumsText.split('\n').filter(Boolean);
    for (const line of lines) {
      const [expectedSha, zipFilePath] = line.split('  ');
      const fileEntry = zip.getEntry(zipFilePath);
      expect(fileEntry).toBeDefined();
      if (fileEntry) {
        const fileContent = fileEntry.getData();
        const actualSha = crypto.createHash('sha256').update(fileContent).digest('hex');
        expect(actualSha).toBe(expectedSha);
      }
    }
  });

  it('deve rejeitar e prevenir tentativas de path traversal maliciosas', () => {
    // Malicious segment entry with path traversal attempt in audioPath
    const segments = [
      {
        segmentId: 'seg_malicious',
        order: 1,
        chapterId: 'ch_01',
        speakerId: 'narrador',
        status: 'ready',
        audioPath: '../../../../etc/passwd' // Malicious path traversal
      }
    ];

    fs.writeFileSync(
      path.join(projDir, 'scripts/segments.json'),
      JSON.stringify(segments, null, 2)
    );

    const valResult = validateProjectForExport(TEST_PROJECT_ID);
    expect(valResult.isValid).toBe(false);
    expect(valResult.error).toContain('malicioso');
  });
});
