import { diffChars } from 'diff';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// TODO: fix this more elegantly; understand why that many renderings
const diffCache = new Map<string, Map<string, string>>();

export function generateHtmlDiff(original: string, edited: string): string {
  if (!diffCache.has(original)) {
    diffCache.set(original, new Map());
  } else {
    if (diffCache.get(original)!.has(edited)) {
      return diffCache.get(original)!.get(edited)!;
    }
  }

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

  diffCache.get(original)!.set(edited, html);

  return html;
}
