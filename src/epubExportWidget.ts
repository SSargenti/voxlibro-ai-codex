function activeProjectId() {
  return localStorage.getItem('voxlibro.project') || '';
}

function downloadEpub() {
  const projectId = activeProjectId();
  if (!projectId) return;
  const anchor = document.createElement('a');
  anchor.href = `/api/projects/${encodeURIComponent(projectId)}/translated-book/download?format=epub`;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function installEpubButton() {
  const actions = document.querySelector<HTMLElement>('#translated-book-root .translated-book-actions');
  if (!actions || actions.querySelector('[data-epub-export]')) return;
  const docx = Array.from(actions.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => button.textContent?.includes('DOCX'));
  if (!docx) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.epubExport = 'true';
  button.textContent = 'EPUB 3';
  button.disabled = docx.disabled;
  button.title = 'Baixar livro eletrônico EPUB 3 com sumário navegável';
  button.addEventListener('click', downloadEpub);

  const packageButton = Array.from(actions.querySelectorAll<HTMLButtonElement>('button'))
    .find(item => item.textContent?.includes('Pacote completo'));
  if (packageButton) actions.insertBefore(button, packageButton);
  else actions.appendChild(button);
}

const observer = new MutationObserver(installEpubButton);
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installEpubButton, { once: true });
} else {
  installEpubButton();
}
