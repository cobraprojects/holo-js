import MarkdownItParser, { type MarkdownIt, type StateCore, type Token } from 'markdown-it'

interface TextListState {
  readonly ordered: boolean
  nextNumber: number
}

interface TextBlock {
  readonly text: string
  readonly group: number | undefined
}

const UNSAFE_URL_SCHEME_PATTERN = /^(?:javascript|vbscript|file|data):/i
const SAFE_DATA_IMAGE_PATTERN = /^data:image\/(?:png|gif|jpeg|webp)/i

function isPotentiallyUnsafeUrl(url: string): boolean {
  return UNSAFE_URL_SCHEME_PATTERN.test(url) && !SAFE_DATA_IMAGE_PATTERN.test(url)
}

function readAttribute(token: Token, name: string): string {
  return String(token.attrGet(name) ?? '')
}

function forbidUnsafeUrl(token: Token): void {
  if (token.type === 'link_open' && isPotentiallyUnsafeUrl(readAttribute(token, 'href'))) {
    token.attrs = token.attrs?.filter(([name]) => name !== 'href') ?? null
  }
  if (token.type === 'image' && isPotentiallyUnsafeUrl(readAttribute(token, 'src'))) {
    token.attrSet('src', '')
  }
}

function forbidUnsafeUrls(state: StateCore): void {
  for (const token of state.tokens) {
    token.children?.forEach(forbidUnsafeUrl)
  }
}

function createMarkdownParser(): MarkdownIt {
  const parser = new MarkdownItParser('commonmark', { html: true }).enable('table')
  parser.validateLink = () => true
  parser.core.ruler.push('mail_unsafe_urls', forbidUnsafeUrls)
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
      if (link?.href && parts.slice(link.labelStart).join('') !== link.href) {
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
