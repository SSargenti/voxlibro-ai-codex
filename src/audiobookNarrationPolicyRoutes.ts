import type { Express, Request, Response } from 'express';
import { enforceAudiobookNarrationPolicy, type AudiobookNarrationStorage } from './audiobookNarrationPolicy';

export function registerAudiobookNarrationPolicyRoutes(
  app: Express,
  storageProvider: () => AudiobookNarrationStorage,
) {
  const handle = (req: Request, res: Response) => {
    try {
      const result = enforceAudiobookNarrationPolicy(storageProvider(), String(req.params.projectId || ''));
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        audiobook: result.audiobook,
        project: result.project,
        segments: result.segments,
        changedSegmentIds: result.changedSegmentIds,
        narratorCreated: result.narratorCreated,
        sanitizedSuggestions: result.sanitizedSuggestions,
        report: result.scriptReport,
        finalReport: result.finalReport,
      });
    } catch (error: any) {
      return res.status(400).json({ error: { code: 'AUDIOBOOK_NARRATION_POLICY_FAILED', message: error?.message || 'Não foi possível aplicar a política de narrador único.' } });
    }
  };

  app.get('/api/projects/:projectId/audiobook-narration-policy', handle);
  app.post('/api/projects/:projectId/audiobook-narration-policy/enforce', handle);
}
