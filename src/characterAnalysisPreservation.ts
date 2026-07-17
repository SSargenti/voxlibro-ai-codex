import fs from 'fs';
import path from 'path';

export type CharacterPreservationStorage = {
  projectsRoot: string;
};

type AnalysisResult = { characters: any[]; sightings: any[]; mergeSuggestions: any[] };

type Analyzer = (
  projectId: string,
  forceFresh?: boolean,
  allowTechnicalAuthors?: boolean,
) => Promise<AnalysisResult>;

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function atomicWrite(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function normalizeName(value: unknown) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('pt-BR');
}

function findPrevious(character: any, previous: any[]) {
  const byId = previous.find(item => item.characterId && item.characterId === character.characterId);
  if (byId) return byId;
  const names = new Set([
    normalizeName(character.canonicalName),
    ...(Array.isArray(character.aliases) ? character.aliases.map(normalizeName) : []),
  ].filter(Boolean));
  return previous.find(item => {
    const previousNames = [
      normalizeName(item.canonicalName),
      ...(Array.isArray(item.aliases) ? item.aliases.map(normalizeName) : []),
    ];
    return previousNames.some(name => names.has(name));
  });
}

export function preserveCharacterEdits(previous: any[], generated: any[]) {
  return generated.map(character => {
    const old = findPrevious(character, previous);
    if (!old) return character;

    const voiceFields = {
      voiceAssignmentId: old.voiceAssignmentId ?? character.voiceAssignmentId,
      voiceAssignment: old.voiceAssignment ?? character.voiceAssignment,
      voiceProfile: old.voiceProfile ?? character.voiceProfile,
      voiceRecommendations: old.voiceRecommendations ?? character.voiceRecommendations,
    };

    if (old.locked) {
      return {
        ...character,
        canonicalName: old.canonicalName || character.canonicalName,
        aliases: Array.isArray(old.aliases) ? old.aliases : character.aliases,
        role: old.role || character.role,
        genderPresentation: old.genderPresentation ?? character.genderPresentation,
        estimatedAge: old.estimatedAge ?? character.estimatedAge,
        description: old.description ?? character.description,
        personality: Array.isArray(old.personality) ? old.personality : character.personality,
        speechStyle: old.speechStyle ?? character.speechStyle,
        locked: true,
        ...voiceFields,
      };
    }

    return { ...character, ...voiceFields };
  });
}

export function withCharacterEditPreservation(
  storageProvider: () => CharacterPreservationStorage,
  analyzer: Analyzer,
): Analyzer {
  return async (projectId, forceFresh, allowTechnicalAuthors) => {
    const bibleDir = path.join(storageProvider().projectsRoot, projectId, 'narrative-bible');
    const charactersFile = path.join(bibleDir, 'characters.json');
    const previous = readJson<any[]>(charactersFile, []);
    const result = await analyzer(projectId, forceFresh, allowTechnicalAuthors);
    if (!previous.length || !Array.isArray(result.characters)) return result;

    const characters = preserveCharacterEdits(previous, result.characters);
    const names = new Map(characters.map(character => [character.characterId, character.canonicalName]));
    const sightings = Array.isArray(result.sightings)
      ? result.sightings.map(sighting => ({
          ...sighting,
          canonicalName: names.get(sighting.characterId) || sighting.canonicalName,
        }))
      : [];
    atomicWrite(charactersFile, characters);
    atomicWrite(path.join(bibleDir, 'sightings.json'), sightings);
    return { ...result, characters, sightings };
  };
}
