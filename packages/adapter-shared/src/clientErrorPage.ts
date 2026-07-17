import type { NormalizedHoloHttpError } from '@holo-js/kernel/http-errors'

type BrowserStyle = { cssText: string, display: string }
type BrowserElement = {
  id: string
  className: string
  textContent: string | null
  readonly style: BrowserStyle
  setAttribute(name: string, value: string): void
  append(...nodes: BrowserElement[]): void
  replaceChildren(...nodes: BrowserElement[]): void
}
type BrowserDocument = {
  title: string
  readonly body: { readonly children: Iterable<BrowserElement>, append(node: BrowserElement): void }
  createElement(tagName: string): BrowserElement
  getElementById(id: string): BrowserElement | null
}

export type ClientErrorPageOptions = {
  readonly rootId: string
  readonly statusClassName: string
}

function escapePage(error: NormalizedHoloHttpError, options: ClientErrorPageOptions): void {
  const browserDocument = (globalThis as unknown as { document?: BrowserDocument }).document
  if (!browserDocument) return
  browserDocument.title = `${error.status}: ${error.message}`
  const existingRoot = browserDocument.getElementById(options.rootId)
  const root = existingRoot ?? browserDocument.createElement('main')
  root.id = options.rootId
  root.setAttribute('role', 'alert')
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;margin:0;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif'
  const wrapper = browserDocument.createElement('div')
  wrapper.style.cssText = 'display:flex;align-items:center;gap:1.5rem;padding:1.5rem'
  const status = browserDocument.createElement('h1')
  status.className = options.statusClassName
  status.textContent = String(error.status)
  status.style.cssText = 'display:inline-block;margin:0 1.25rem 0 0;padding:0 1.5rem 0 0;font-size:24px;font-weight:500;line-height:49px;vertical-align:top;border-right:1px solid rgba(0,0,0,.3)'
  const description = browserDocument.createElement('div')
  description.style.cssText = 'display:inline-block;text-align:left;line-height:49px;height:49px;vertical-align:middle'
  const message = browserDocument.createElement('h2')
  message.textContent = error.message
  message.style.cssText = 'font-size:14px;font-weight:400;line-height:49px;margin:0'
  description.append(message)
  wrapper.append(status, description)
  root.replaceChildren(wrapper)
  for (const child of Array.from(browserDocument.body.children)) {
    if (child.id !== root.id) child.style.display = 'none'
  }
  if (!existingRoot) browserDocument.body.append(root)
}

export function renderClientHttpErrorPage(
  error: NormalizedHoloHttpError,
  options: ClientErrorPageOptions,
): void {
  escapePage(error, options)
}
