import { afterEach, describe, expect, it } from 'vitest'
import { normalizeHoloHttpError, renderClientHttpErrorPage } from '../src'

type TestElement = {
  id: string
  className: string
  textContent: string | null
  style: { cssText: string, display: string }
  attributes: Record<string, string>
  children: TestElement[]
  setAttribute(name: string, value: string): void
  append(...nodes: TestElement[]): void
  replaceChildren(...nodes: TestElement[]): void
}

function createElement(): TestElement {
  return {
    id: '',
    className: '',
    textContent: null,
    style: { cssText: '', display: '' },
    attributes: {},
    children: [],
    setAttribute(name, value) { this.attributes[name] = value },
    append(...nodes) { this.children.push(...nodes) },
    replaceChildren(...nodes) { this.children = nodes },
  }
}

describe('shared client HTTP errors', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'document')
  })

  it('normalizes and renders a reusable browser error page', () => {
    const existing = createElement()
    existing.id = 'app'
    const body = { children: [existing], append(node: TestElement) { this.children.push(node) } }
    const document = {
      title: '',
      body,
      createElement,
      getElementById(id: string) { return body.children.find(element => element.id === id) ?? null },
    }
    Object.assign(globalThis, { document })
    const error = normalizeHoloHttpError({ statusCode: 403, message: 'Forbidden', code: 'denied' })!
    renderClientHttpErrorPage(error, { rootId: 'holo-error', statusClassName: 'status' })
    expect(document.title).toBe('403: Forbidden')
    expect(existing.style.display).toBe('none')
    expect(body.children.at(-1)).toMatchObject({ id: 'holo-error', attributes: { role: 'alert' } })

    renderClientHttpErrorPage(error, { rootId: 'holo-error', statusClassName: 'status' })
    expect(body.children.filter(element => element.id === 'holo-error')).toHaveLength(1)
  })

  it('does nothing without a browser document', () => {
    const error = normalizeHoloHttpError({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404', statusText: 'Missing' })!
    expect(() => renderClientHttpErrorPage(error, { rootId: 'error', statusClassName: 'status' })).not.toThrow()
    expect(normalizeHoloHttpError({ status: 399 })).toBeUndefined()
  })
})
