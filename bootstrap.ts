import { registerProjectBackupRoutes } from './src/projectBackup';
import { configureOpenAiModelRouting } from './src/openAiModelRouting';
import { registerProjectCostEstimateRoutes } from './src/projectCostEstimate';
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

  registerProjectBackupRoutes(server.app, storageProvider);
  registerProjectCostEstimateRoutes(server.app, storageProvider);
  registerTranslationMemoryRoutes(server.app, storageProvider, {
    startProjectJob: server.startProjectJob,
  });
  registerTranslatedBookRoutes(server.app, storageProvider);

  await server.startServer();
}

bootstrap().catch(error => {
  console.error('Falha ao iniciar o VoxLibro:', error);
  process.exitCode = 1;
});
