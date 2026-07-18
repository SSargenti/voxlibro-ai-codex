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
  registerTranslationMemoryRoutes(server.app, storageProvider, {
    startProjectJob: server.startProjectJob,
  });
  registerCharacterAnalysisJobRoutes(server.app, storageProvider, {
    performMapReduceCharacterAnalysis: withCharacterEditPreservation(
      storageProvider,
      server.performMapReduceCharacterAnalysis,
    ),
  });
  registerScriptGenerationJobRoutes(server.app, storageProvider, {
    generateContent: args => server.ai.models.generateContent(args),
    hasTextAi: server.hasTextAi,
    editorialModel: () => server.TEXT_MODELS.editorial,
  });
  registerScriptContextReviewRoutes(server.app, storageProvider, {
    generateContent: args => server.ai.models.generateContent(args),
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
