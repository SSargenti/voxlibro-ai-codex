import { registerProjectBackupRoutes } from './src/projectBackup';

async function bootstrap() {
  const previousVitest = process.env.VITEST;
  process.env.VITEST = 'voxlibro-bootstrap';

  const server = await import('./server');

  if (previousVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = previousVitest;

  registerProjectBackupRoutes(server.app, () => ({
    projectsRoot: server.PROJECTS_ROOT,
    projectsDbFile: server.PROJECTS_DB_FILE,
  }));

  await server.startServer();
}

bootstrap().catch(error => {
  console.error('Falha ao iniciar o VoxLibro:', error);
  process.exitCode = 1;
});
