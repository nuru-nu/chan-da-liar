import { diffChars } from 'diff';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function generateHtmlDiff(original: string, edited: string): string {
  const diffResult = diffChars(original, edited);
  let html = '';

  diffResult.forEach(part => {
    const escapedValue = escapeHtml(part.value);
    if (part.added) {
      html += `<span class="diff-added">${escapedValue}</span>`;
    } else if (part.removed) {
      html += `<span class="diff-removed">${escapedValue}</span>`;
    } else {
      html += escapedValue;
    }
  });

  return html;
}
