import type { Express, NextFunction, Request, Response } from 'express';
import fs from 'fs';

export type TranslatedBookEligibilityStorage = {
  projectsDbFile: string;
};

function isPortuguese(language?: string) {
  const normalized = String(language || '').toLocaleLowerCase('pt-BR').trim();
  return normalized.startsWith('pt') || normalized.includes('portug') || normalized.includes('brazil');
}

function readProjects(projectsDbFile: string): any[] {
  if (!fs.existsSync(projectsDbFile)) return [];
  const parsed = JSON.parse(fs.readFileSync(projectsDbFile, 'utf8'));
  return Array.isArray(parsed) ? parsed : [];
}

export function registerTranslatedBookEligibilityGuard(
  app: Express,
  storageProvider: () => TranslatedBookEligibilityStorage,
) {
  app.use('/api/projects/:projectId/translated-book', (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = readProjects(storageProvider().projectsDbFile)
        .find(item => item.projectId === req.params.projectId);
      if (!project) return res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Projeto não encontrado.' } });

      const foreignSource = !isPortuguese(project.sourceLanguage);
      if (foreignSource && project.translationEnabled === false) {
        return res.status(409).json({
          error: {
            code: 'TRANSLATION_DISABLED_FOR_FOREIGN_SOURCE',
            message: 'A obra está em idioma estrangeiro e a tradução para pt-BR está desativada. Ative a tradução antes de gerar o livro traduzido.',
          },
        });
      }
      return next();
    } catch (error: any) {
      return res.status(400).json({
        error: {
          code: 'TRANSLATED_BOOK_ELIGIBILITY_FAILED',
          message: error?.message || 'Não foi possível verificar a elegibilidade do livro traduzido.',
        },
      });
    }
  });
}
