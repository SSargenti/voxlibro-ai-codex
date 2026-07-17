# Roteamento de modelos do VoxLibro

A seleção é feita pela carga de trabalho reconhecida no prompt, e não apenas pelo modelo legado solicitado por `server.ts`.

| Etapa | Modelo inicial | Raciocínio | Escalonamento automático |
|---|---|---:|---|
| Teste de credencial | GPT-5.6 Luna | baixo | não |
| Detecção de idioma | GPT-5.6 Luna | baixo | Luna → Luna → Terra |
| OCR | GPT-5.6 Luna | baixo | Luna → Luna → Terra |
| Título, autor e modo | GPT-5.6 Luna | baixo | Luna → Luna → Terra |
| Estrutura e capítulos | GPT-5.6 Terra | médio | Terra → Terra → Sol |
| Tradução | GPT-5.6 Terra | baixo | Terra → Terra → Sol |
| Bíblia de personagens | GPT-5.6 Terra | médio | Terra → Terra → Sol |
| Fatiamento e locutores | GPT-5.6 Terra | médio | Terra → Terra → Sol |
| Auditoria editorial final | GPT-5.6 Sol | alto | não |

O Sol não é usado automaticamente em OCR, metadados, detecção de idioma ou testes de credencial.

## Variáveis específicas

- `VOXLIBRO_HEALTH_MODEL`
- `VOXLIBRO_LANGUAGE_MODEL`
- `VOXLIBRO_OCR_MODEL`
- `VOXLIBRO_METADATA_MODEL`
- `VOXLIBRO_STRUCTURE_MODEL`
- `VOXLIBRO_TRANSLATION_MODEL`
- `VOXLIBRO_CHARACTER_MODEL`
- `VOXLIBRO_SCRIPT_MODEL`
- `VOXLIBRO_AUDIT_MODEL`

As variáveis gerais `VOXLIBRO_BULK_MODEL`, `VOXLIBRO_EDITORIAL_MODEL` e `VOXLIBRO_AUDIT_MODEL` continuam como padrões dos níveis Luna, Terra e Sol. `VOXLIBRO_TEXT_MODEL` permanece somente para compatibilidade e não prevalece sobre uma tarefa reconhecida.

Modelos personalizados fora da família padrão permanecem fixos e não são trocados silenciosamente por outro nível.
