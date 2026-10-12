import { effectScope, nextTick, reactive, watchEffect } from 'vue'
import { describe, expect, it, onTestFinished } from 'vitest'
import { field, schema } from '@holo-js/validation'
import { useForm } from '../src/runtime/composables/forms'

const profileSchema = schema({
  email: field.string().required().email(),
  profile: { city: field.string().required() },
  tags: field.array(field.string()).optional(),
})

function withinNativeScope<TValue>(create: () => TValue): TValue {
  const scope = effectScope()
  onTestFinished(() => scope.stop())
  const result = scope.run(create)
  if (!result) throw new Error('The native Vue scope did not initialize')
  return result
}

describe('Nuxt forms with native Vue', () => {
  it('updates native reactive consumers when app code edits scalar and nested values', async () => {
    const rendered: string[] = []
    const form = withinNativeScope(() => {
      const form = useForm(profileSchema, { initialValues: { email: 'ava@example.com', profile: { city: 'Cairo' }, tags: [] } })
      watchEffect(() => rendered.push(`${form.values.email}:${form.values.profile.city}`))
      return form
    })
    form.values.email = 'nora@example.com'
    form.values.profile.city = 'Alexandria'
    await nextTick()
    expect(rendered).toEqual(['ava@example.com:Cairo', 'nora@example.com:Alexandria'])
    expect((await form.validate()).valid).toBe(true)
    await form.setValue('email', 'invalid')
    expect((await form.validate()).valid).toBe(false)
    expect(form.errors.first('email')).toBeDefined()
  })

  it('reactively renders optional nested fields that appear after the form is created', async () => {
    const rendered: string[] = []
    const form = withinNativeScope(() => {
      const form = useForm(schema({ profile: { city: field.string().optional() } }), { initialValues: {} })
      watchEffect(() => rendered.push(form.values.profile?.city ?? 'missing'))
      return form
    })
    await form.setValue('profile.city', 'Cairo')
    await nextTick()
    expect(rendered).toEqual(['missing', 'Cairo'])
  })

  it('tracks native array edits, dirty fields, and the reset baseline', async () => {
    const form = withinNativeScope(() => useForm(profileSchema, { initialValues: { email: 'ava@example.com', profile: { city: 'Cairo' }, tags: ['first'] } }))
    form.values.tags?.push('second')
    await nextTick()
    expect([...form.values.tags ?? []]).toEqual(['first', 'second'])
    expect(form.fields.tags.dirty).toBe(true)
    form.reset({ email: 'nora@example.com', profile: { city: 'Alexandria' }, tags: ['reset'] })
    await nextTick()
    expect([...form.values.tags ?? []]).toEqual(['reset'])
    expect(form.fields.tags.dirty).toBe(false)
  })

  it('rebuilds the real form when reactive app options change', async () => {
    const options = reactive({ initialValues: { email: 'ava@example.com' } })
    const form = withinNativeScope(() => useForm(schema({ email: field.string().required().email() }), options))
    await form.setValue('email', 'edited@example.com')
    options.initialValues = { email: 'nora@example.com' }
    await nextTick()
    expect(form.values.email).toBe('nora@example.com')
    expect(form.fields.email.dirty).toBe(false)
  })

  it('submits native FormData and applies real server failure and success payloads', async () => {
    const form = withinNativeScope(() => useForm(profileSchema, {
      initialValues: { email: 'ava@example.com', profile: { city: 'Cairo' }, tags: [] },
      submitter: ({ formData }) => ({ ok: true, status: 200, data: String(formData.get('profile.city')) }),
    }))
    await expect(form.submit()).resolves.toMatchObject({ ok: true, data: 'Cairo' })
    form.applyServerState({ ok: false, status: 422, submitted: true, valid: false, values: { email: 'invalid', profile: { city: 'Cairo' }, tags: [] }, errors: { email: ['Server rejected the email.'] } })
    await nextTick()
    expect(form.values.email).toBe('invalid')
    expect(form.errors.first('email')).toBe('Server rejected the email.')
    await form.setValue('email', 'nora@example.com')
    await expect(form.submit()).resolves.toMatchObject({ ok: true, data: 'Cairo' })
  })
})
