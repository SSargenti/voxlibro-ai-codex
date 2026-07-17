import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./src/App.tsx', import.meta.url), 'utf8');

describe('Regressões da navegação e do fluxo', () => {
  it('não retorna Promises como limpeza de efeitos React', () => {
    expect(source).not.toContain('useEffect(load,');
    expect(source).not.toContain('useEffect(loadExports,');
    expect(source).toContain('useEffect(() => { void load(); }, [])');
    expect(source).toContain('useEffect(() => { void loadExports(); }');
  });

  it('retoma o projeto e a etapa salvos no carregamento', () => {
    expect(source).toContain("localStorage.getItem('voxlibro.project')");
    expect(source).toContain('setView(\'workspace\')');
    expect(source).toContain('localStorage.setItem(\'voxlibro.project\', id)');
  });

  it('bloqueia o roteiro até a conclusão do elenco', () => {
    expect(source).toContain("disabled={!castingReady}");
    expect(source).toContain('Conclua o elenco primeiro');
  });

  it('não exibe os nomes internos antigos de modelos', () => {
    expect(source).not.toContain('Luna · Terra · Sol');
    expect(source).toContain('GPT-5.6 · esforço baixo, médio ou alto');
  });

  it('expõe casting inteligente e som contextual com atribuição', () => {
    expect(source).toContain('Elenco de vozes inteligente');
    expect(source).toContain('voiceRecommendations');
    expect(source).toContain('/api/freesound/search');
    expect(source).toContain('Som de contexto · Freesound');
    expect(source).toContain('role="alert"');
  });

  it('permite revisão editorial da tradução e da Bíblia narrativa', () => {
    expect(source).toContain('Tradução editável');
    expect(source).toContain('/translation`');
    expect(source).toContain('Bíblia narrativa editável');
    expect(source).toContain('/merge-characters');
    expect(source).toContain('/split-character');
    expect(source).toContain('Definir narrador');
  });
});
