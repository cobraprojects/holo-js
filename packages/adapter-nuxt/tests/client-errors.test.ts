import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderNuxtClientHttpErrorPage } from '../src/runtime/composables/client-errors'

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
    id: '', className: '', textContent: null, style: { cssText: '', display: '' }, attributes: {}, children: [],
    setAttribute(name, value) { this.attributes[name] = value },
    append(...nodes) { this.children.push(...nodes) },
    replaceChildren(...nodes) { this.children = [...nodes] },
  }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'showError')
  Reflect.deleteProperty(globalThis, 'document')
})

describe('Nuxt client errors', () => {
  it('delegates to Nuxt showError when available', () => {
    const showError = vi.fn()
    Object.defineProperty(globalThis, 'showError', { value: showError, configurable: true })
    renderNuxtClientHttpErrorPage({ status: 403, message: 'Denied', cause: undefined })
    expect(showError).toHaveBeenCalledWith({ statusCode: 403, statusMessage: 'Denied', message: 'Denied' })
  })

  it('renders and updates the fallback browser error page', () => {
    const original = createElement()
    original.id = 'app'
    const bodyChildren = [original]
    const document = {
      title: '',
      body: {
        children: bodyChildren,
        append: (node: TestElement) => bodyChildren.push(node),
      },
      createElement: () => createElement(),
      getElementById: (id: string) => bodyChildren.find(child => child.id === id) ?? null,
    }
    Object.defineProperty(globalThis, 'document', { value: document, configurable: true })
    renderNuxtClientHttpErrorPage({ status: 404, message: 'Missing', cause: undefined })
    expect(document.title).toBe('404: Missing')
    expect(original.style.display).toBe('none')
    const root = bodyChildren[1]!
    expect(root.attributes.role).toBe('alert')
    expect(root.children[0]?.children[0]?.textContent).toBe('404')
    renderNuxtClientHttpErrorPage({ status: 401, message: 'Sign in', cause: undefined })
    expect(bodyChildren).toHaveLength(2)
    expect(root.children[0]?.children[0]?.textContent).toBe('401')
  })

  it('does nothing when no client renderer exists', () => {
    expect(() => renderNuxtClientHttpErrorPage({ status: 500, message: 'Failure', cause: undefined })).not.toThrow()
  })
})
