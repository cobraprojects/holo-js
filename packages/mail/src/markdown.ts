function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function isSafeMailHref(href: string): boolean {
  const trimmed = href.trim()
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) return true
  try {
    const url = new URL(trimmed)
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:'
  } catch {
    return false
  }
}

export function renderMarkdownInline(markdown: string): string {
  return escapeHtml(markdown)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
      return isSafeMailHref(href) ? `<a href="${escapeHtml(href)}">${label}</a>` : label
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

export function stripMarkdownSyntax(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .trim()
}

export function renderMarkdown(markdown: string): string {
  const blocks = markdown.trim().split(/\n\s*\n/g).map(block => block.trim()).filter(Boolean)
  return blocks.map((block) => {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean)
    if (lines.every(line => /^[-*]\s+/.test(line))) {
      return `<ul>${lines.map(line => `<li>${renderMarkdownInline(line.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`
    }
    const heading = lines.length === 1 ? lines[0]!.match(/^(#{1,6})\s+(.+)$/) : null
    if (heading) {
      const [, markers, title] = heading
      const level = markers!.length
      return `<h${level}>${renderMarkdownInline(title!)}</h${level}>`
    }
    return `<p>${lines.map(renderMarkdownInline).join('<br />')}</p>`
  }).join('\n')
}
