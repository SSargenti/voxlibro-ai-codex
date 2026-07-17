# VoxLibro AI — Codex Edition

Estúdio local de uso individual para transformar PDF, DOCX, EPUB, TXT e HTML em audionovelas, audiolivros ou narrações técnicas. O fluxo preserva a obra-fonte e separa revisão editorial, casting, roteiro, geração de áudio e exportação.

## Decisões desta versão

- sem login e sem contas de usuário;
- retomada do projeto e da última etapa no navegador;
- OpenAI para idioma, tradução, bíblia narrativa, continuidade e roteiro;
- Google Cloud TTS para o nível econômico (WaveNet/Neural2);
- Gemini 2.5 Flash TTS para o nível expressivo padrão e Pro TTS para o premium;
- chaves independentes, sem reutilização silenciosa entre provedores;
- nenhum fallback para `speechSynthesis` ou áudio simulado;
- cache por voz, modelo, texto e direção;
- edição e regeneração por segmento;
- casting inteligente por sexo vocal, idade, timbre, energia e expressividade;
- ambientes e efeitos do Freesound com prévia, mixagem e atribuição no pacote final;
- exportação validada com manifesto e checksums.

## Modelos de texto

| Etapa | Modelo padrão |
|---|---|
| Detecção, tradução e volume | `gpt-5.6` com esforço baixo |
| Bíblia narrativa, personagens e continuidade | `gpt-5.6` com esforço médio |
| Auditoria difícil sob demanda | `gpt-5.6` com esforço alto |

Os identificadores podem ser alterados pelas variáveis `VOXLIBRO_BULK_MODEL`, `VOXLIBRO_EDITORIAL_MODEL` e `VOXLIBRO_AUDIT_MODEL`. Os antigos nomes internos Luna/Terra/Sol não são usados como IDs da API pública; o perfil de custo e qualidade é controlado pelo esforço de raciocínio.

## Executar localmente

Requisitos: Node.js 20+ e FFmpeg (o pacote inclui um binário compatível para a maioria dos ambientes).

```bash
cp .env.example .env
npm install
npm run dev
```

Abra `http://localhost:3000`. Também é possível inserir as três chaves na tela **Configurações** apenas para a sessão atual.

## Credenciais

- `OPENAI_API_KEY`: obrigatória para análise textual, tradução, bíblia e roteiro.
- `GEMINI_API_KEY`: necessária somente para Gemini TTS.
- `GCP_CREDENTIALS`: JSON completo de uma Service Account com acesso ao Cloud Text-to-Speech; recomendado no Render.
- `GOOGLE_APPLICATION_CREDENTIALS`: alternativa ADC apontando para um Secret File local.
- `GOOGLE_CLOUD_TTS_API_KEY`: compatibilidade legada; não use quando a API exigir OAuth2.
- `FREESOUND_API_KEY`: necessária para buscar e incorporar sons de contexto; autor e licença acompanham a exportação.
- `VOXLIBRO_MASTER_KEY`: segredo com no mínimo 32 caracteres para persistir chaves criptografadas em disco. Sem ele, use armazenamento em memória.

Nunca use a mesma variável para dois serviços. Os arquivos `.env`, `.credentials/`, projetos, áudios e exports estão ignorados pelo Git.

## Verificação

```bash
npm run verify:all
```

A suíte cobre segurança de credenciais, integridade da extração e do roteiro, cache, validação WAV, provedores separados, jobs retomáveis e exportação.

## Estrutura de dados

Cada projeto é salvo em `projects/<id>/` com diretórios separados para fonte, texto normalizado, tradução, bíblia narrativa, roteiro, áudio, exportações e logs. A pasta pode ser copiada para backup sem depender do navegador.

## Publicar no GitHub

O repositório deve conter somente o código. Não faça commit de `.env`, `.credentials/`, `projects/`, `dist/`, `server-dist/` ou `node_modules/`.
