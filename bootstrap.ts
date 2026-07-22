import { registerProjectBackupRoutes } from './src/projectBackup';
import { registerCharacterAnalysisJobRoutes } from './src/characterAnalysisJob';
import { withCharacterEditPreservation } from './src/characterAnalysisPreservation';
import { cleanupStaleCharacterAnalysisStages } from './src/characterAnalysisStageCleanup';
import { configureOpenAiModelRouting } from './src/openAiModelRouting';
import { registerProjectCostEstimateRoutes } from './src/projectCostEstimate';
import { registerEpubExportRoutes } from './src/epubExport';
import { registerScriptContextReviewRoutes } from './src/scriptContextReview';
import { registerScriptGenerationJobRoutes } from './src/scriptGenerationJob';
import { registerTranslatedBookEligibilityGuard } from './src/translatedBookEligibility';
import { registerTranslatedBookRoutes } from './src/translatedBookExport';
import { registerTranslationMemoryRoutes } from './src/translationMemory';
import {
  registerAudiobookNarrationPolicy,
  withAudiobookContextReviewPolicy,
} from './src/audiobookNarrationPolicy';
import { registerAudiobookNarrationPolicyRoutes } from './src/audiobookNarrationPolicyRoutes';
import { registerVoiceScriptPersistenceRoutes } from './src/voiceScriptPersistence';
import { registerAudioGenerationJobRoutes } from './src/audioGenerationJob';
import { registerTranslationGenerationJobRoutes } from './src/translationGenerationJob';

async function bootstrap() {
  const previousVitest = process.env.VITEST;
  process.env.VITEST = 'voxlibro-bootstrap';

  const server = await import('./server');

  if (previousVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = previousVitest;

  configureOpenAiModelRouting(server as any);

  const storageProvider = () => ({
    projectsRoot: server.PROJECTS_ROOT,
    projectsDbFile: server.PROJECTS_DB_FILE,
  });

  cleanupStaleCharacterAnalysisStages(storageProvider());
  registerProjectBackupRoutes(server.app, storageProvider);
  registerProjectCostEstimateRoutes(server.app, storageProvider);
  registerTranslationGenerationJobRoutes(server.app, storageProvider, {
    hasTextAi: server.hasTextAi,
    translateChunk: async request => server.runTaskForItem('translation', {
      itemId: request.unitId,
      jobId: request.jobId,
      status: 'processing',
      attempts: 1,
      inputHash: '',
      model: server.TEXT_MODELS.editorial,
      promptVersion: 'resumable-v1',
      configurationHash: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: request,
    } as any),
    legacyCompletedChunks: projectId => server.getJobs()
      .filter((job: any) => job.projectId === projectId && job.operation === 'translation')
      .flatMap((job: any) => job.items || [])
      .filter((item: any) => item.status === 'completed' && item.result?.translatedText)
      .map((item: any) => ({ chapterId: item.payload.chapterId, chunkIndex: item.payload.chunkIndex, inputHash: item.inputHash, translatedText: item.result.translatedText })),
  });
  registerTranslationMemoryRoutes(server.app, storageProvider, {
    startProjectJob: server.startProjectJob,
  });
  registerCharacterAnalysisJobRoutes(server.app, storageProvider, {
    performMapReduceCharacterAnalysis: withCharacterEditPreservation(
      storageProvider,
      server.performMapReduceCharacterAnalysis,
    ),
  });

  registerAudiobookNarrationPolicyRoutes(server.app, storageProvider);
  registerAudiobookNarrationPolicy(server.app, storageProvider);
  registerVoiceScriptPersistenceRoutes(server.app, storageProvider);
  registerAudioGenerationJobRoutes(server.app, storageProvider, {
    generateSegment: async (projectId, segmentId) => {
      const port = Number(process.env.PORT || 3000);
      const response = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(projectId)}/segments/${encodeURIComponent(segmentId)}/tts`, { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error: any = new Error(payload?.error?.message || payload?.error || `Falha HTTP ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    },
  });

  registerScriptGenerationJobRoutes(server.app, storageProvider, {
    generateContent: args => server.ai.models.generateContent(args),
    hasTextAi: server.hasTextAi,
    editorialModel: () => server.TEXT_MODELS.editorial,
  });
  registerScriptContextReviewRoutes(server.app, storageProvider, {
    generateContent: withAudiobookContextReviewPolicy(args => server.ai.models.generateContent(args)),
    hasTextAi: server.hasTextAi,
    editorialModel: () => server.TEXT_MODELS.editorial,
    auditModel: () => server.TEXT_MODELS.audit,
  });
  registerTranslatedBookEligibilityGuard(server.app, storageProvider);
  registerEpubExportRoutes(server.app, storageProvider);
  registerTranslatedBookRoutes(server.app, storageProvider);

  await server.startServer();
}

bootstrap().catch(error => {
  console.error('Falha ao iniciar o VoxLibro:', error);
  process.exitCode = 1;
});
