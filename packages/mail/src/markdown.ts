import MarkdownItParser, { type MarkdownIt, type StateCore, type Token } from 'markdown-it'

interface TextListState {
  readonly ordered: boolean
  nextNumber: number
}

interface TextBlock {
  readonly text: string
  readonly group: number | undefined
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

function readAttribute(token: Token, name: string): string {
  return String(token.attrGet(name) ?? '')
}

function withoutUnsafeLinks(tokens: readonly Token[]): Token[] {
  let insideUnsafeLink = false
  return tokens.flatMap((token) => {
    if (token.type === 'link_open' && !isSafeMailHref(readAttribute(token, 'href'))) {
      insideUnsafeLink = true
      return []
    }
    if (token.type === 'link_close' && insideUnsafeLink) {
      insideUnsafeLink = false
      return []
    }
    if (token.type === 'image' && !isSafeMailHref(readAttribute(token, 'src'))) {
      return token.children ?? []
    }
    return [token]
  })
}

function removeUnsafeLinks(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.type === 'inline' && token.children) {
      token.children = withoutUnsafeLinks(token.children)
    }
  }
}

function createMarkdownParser(): MarkdownIt {
  const parser = new MarkdownItParser('commonmark', { html: true }).enable('table')
  parser.validateLink = () => true
  parser.core.ruler.push('mail_unsafe_links', removeUnsafeLinks)
  return parser
}

const markdownParser = createMarkdownParser()

function renderInlineText(tokens: readonly Token[]): string {
  const parts: string[] = []
  const linkStack: { readonly href: string, readonly labelStart: number }[] = []
  for (const token of tokens) {
    if (token.type === 'link_open') {
      linkStack.push({ href: readAttribute(token, 'href'), labelStart: parts.length })
    } else if (token.type === 'link_close') {
      const link = linkStack.pop()
      if (link && parts.slice(link.labelStart).join('') !== link.href) {
        parts.push(` (${link.href})`)
      }
    } else if (token.type === 'softbreak' || token.type === 'hardbreak') {
      parts.push('\n')
    } else if (token.type === 'image') {
      parts.push(renderInlineText(token.children ?? []))
    } else if (token.type === 'text' || token.type === 'code_inline') {
      parts.push(token.content)
    }
  }
  return parts.join('')
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

function joinTextBlocks(blocks: readonly TextBlock[]): string {
  return blocks.map((block, index) => {
    if (index === 0) return block.text
    const previous = blocks[index - 1]
    const separator = block.group !== undefined && block.group === previous?.group ? '\n' : '\n\n'
    return `${separator}${block.text}`
  }).join('')
}

export function renderMarkdown(markdown: string): string {
  return markdownParser.render(markdown).trimEnd()
}

export function renderMarkdownInline(markdown: string): string {
  return markdownParser.renderInline(markdown)
}

export function renderMarkdownText(markdown: string): string {
  const tokens = markdownParser.parse(markdown, {})
  const blocks: TextBlock[] = []
  const lists: TextListState[] = []
  let group: number | undefined
  let itemPrefix = ''
  let tableRow: string[] | undefined

  tokens.forEach((token, index) => {
    switch (token.type) {
      case 'bullet_list_open':
      case 'ordered_list_open':
        group ??= index
        lists.push({ ordered: token.type === 'ordered_list_open', nextNumber: Number(token.attrGet('start') ?? 1) })
        return
      case 'bullet_list_close':
      case 'ordered_list_close':
        lists.pop()
        if (lists.length === 0) group = undefined
        return
      case 'list_item_open': {
        const list = lists.at(-1)
        const marker = list?.ordered ? `${list.nextNumber++}.` : '-'
        itemPrefix = `${'  '.repeat(lists.length - 1)}${marker} `
        return
      }
      case 'table_open':
        group = index
        return
      case 'table_close':
        group = undefined
        return
      case 'tr_open':
        tableRow = []
        return
      case 'tr_close':
        blocks.push({ text: (tableRow ?? []).join(' | '), group })
        tableRow = undefined
        return
      case 'fence':
      case 'code_block':
        blocks.push({ text: token.content.trimEnd(), group })
        return
      case 'html_block': {
        const text = markdownParser.utils.unescapeAll(stripHtmlTags(token.content)).trim()
        if (text) blocks.push({ text, group })
        return
      }
      case 'inline': {
        const text = renderInlineText(token.children ?? [])
        if (tableRow) {
          tableRow.push(text)
          return
        }
        blocks.push({ text: `${itemPrefix}${text}`, group })
        itemPrefix = ''
      }
    }
  })

  return joinTextBlocks(blocks).trim()
}
