import { Component, createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { redirect } from 'next/navigation'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { field, schema, type ValidationSchema } from '@holo-js/validation'
import type { InferFormData } from '@holo-js/forms'
import { useForm, type UseFormOptions } from '../src/client'

beforeEach(() => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  onTestFinished(() => {
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous)
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  })
})

class FormErrorBoundary extends Component<{ children?: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  override render() {
    return this.state.error
      ? createElement('output', { 'data-digest': Reflect.get(this.state.error, 'digest') }, this.state.error.message)
      : this.props.children
  }
}

async function mountForm<TSchema extends ValidationSchema>(definition: TSchema, options: UseFormOptions<InferFormData<TSchema>, string>) {
  let current: ReturnType<typeof useForm<TSchema, string>> | undefined
  let renderer!: ReactTestRenderer
  function Form(props: { options: typeof options }) {
    current = useForm(definition, props.options)
    return createElement('output', null, JSON.stringify(current.values))
  }
  await act(async () => { renderer = create(createElement(FormErrorBoundary, null, createElement(Form, { options }))) })
  onTestFinished(async () => { await act(async () => renderer.unmount()) })
  return {
    get form() {
      if (!current) throw new Error('The native React form did not render')
      return current
    },
    get rendered() { return renderer.root.findByType('output').children.join('') },
    get errorDigest() { return renderer.root.findByType('output').props['data-digest'] as string | undefined },
    async update(nextOptions: typeof options) {
      await act(async () => renderer.update(createElement(FormErrorBoundary, null, createElement(Form, { options: nextOptions }))))
    },
  }
}

const emailSchema = schema({ email: field.string().required().email() })

describe('Next forms with native React', () => {
  it('renders field changes and validates them through the real form subscription', async () => {
    const harness = await mountForm(emailSchema, { initialValues: { email: 'ava@example.com' } })
    await act(async () => { await harness.form.setValue('email', 'nora@example.com') })
    expect(harness.rendered).toBe('{"email":"nora@example.com"}')
    expect((await harness.form.validate()).valid).toBe(true)
    await act(async () => { await harness.form.setValue('email', 'invalid') })
    expect((await harness.form.validate()).valid).toBe(false)
    expect(harness.form.errors.email?.length).toBeGreaterThan(0)
  })

  it('preserves edited values across equivalent option rerenders and resets them when initial values change', async () => {
    const harness = await mountForm(emailSchema, { initialValues: { email: 'ava@example.com' } })
    await act(async () => { await harness.form.setValue('email', 'edited@example.com') })
    await harness.update({ initialValues: { email: 'ava@example.com' } })
    expect(harness.rendered).toBe('{"email":"edited@example.com"}')
    await harness.update({ initialValues: { email: 'nora@example.com' } })
    expect(harness.rendered).toBe('{"email":"nora@example.com"}')
  })

  it('submits through the latest app callback without losing edited field values', async () => {
    const harness = await mountForm(emailSchema, {
      initialValues: { email: 'ava@example.com' },
      submitter: () => ({ ok: true, status: 200, data: 'first' }),
    })
    await act(async () => { await harness.form.setValue('email', 'edited@example.com') })
    await harness.update({
      initialValues: { email: 'ava@example.com' },
      submitter: ({ formData }) => ({ ok: true, status: 200, data: String(formData.get('email')) }),
    })
    await act(async () => { await expect(harness.form.submit()).resolves.toMatchObject({ ok: true, data: 'edited@example.com' }) })
    expect(harness.rendered).toBe('{"email":"edited@example.com"}')
  })

  it('preserves native Next redirects from submitted app callbacks', async () => {
    const harness = await mountForm(emailSchema, {
      initialValues: { email: 'ava@example.com' },
      submitter: () => redirect('/admin'),
    })
    await act(async () => {
      await expect(harness.form.submit()).rejects.toMatchObject({ digest: 'NEXT_REDIRECT;replace;/admin;307;' })
    })
  })

  it('renders submitted HTTP failures through a real React error boundary', async () => {
    const harness = await mountForm(emailSchema, {
      initialValues: { email: 'ava@example.com' },
      submitter: () => { throw Object.assign(new Error('Denied'), { statusCode: 403 }) },
    })
    await act(async () => { await harness.form.submit() })
    expect(harness.rendered).toBe('Denied')
    expect(harness.errorDigest).toBe('NEXT_HTTP_ERROR_FALLBACK;403')
  })

  it('replaces file values when a rerender supplies a different native File', async () => {
    const uploadSchema = schema({ avatar: field.file().optional() })
    const first = new File(['first'], 'avatar.png', { type: 'image/png' })
    const second = new File(['second'], 'avatar.png', { type: 'image/png' })
    const harness = await mountForm(uploadSchema, { initialValues: { avatar: first } })
    await harness.update({ initialValues: { avatar: second } })
    expect(await harness.form.values.avatar?.text()).toBe('second')
  })
})
