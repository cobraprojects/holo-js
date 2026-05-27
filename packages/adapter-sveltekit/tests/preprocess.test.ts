import { compile } from 'svelte/compiler'
import { describe, expect, it } from 'vitest'
import { transformSvelteUseFormReactivity } from '../src/preprocess'

describe('@holo-js/adapter-sveltekit preprocess', () => {
  it('makes useForm bindings invalidatable without changing the user source API', () => {
    const source = [
      '<script>',
      '  import { useForm } from \'@holo-js/adapter-sveltekit/client\'',
      '  import { loginForm } from \'./schema\'',
      '',
      '  const login = useForm(loginForm, {',
      '    initialValues: {',
      '      email: \'\',',
      '      password: \'\',',
      '    },',
      '  })',
      '</script>',
      '',
      '<form method="post">',
      '  {#if login.errors.has(\'email\')}',
      '    <span>{login.errors.first(\'email\')}</span>',
      '  {/if}',
      '</form>',
      '',
    ].join('\n')

    const transformed = transformSvelteUseFormReactivity(source)
    expect(transformed).toContain('let login = useForm(loginForm, {')
    expect(transformed).toContain('login.subscribe(() => { login = login })')

    const compiled = compile(transformed, {
      filename: 'Login.svelte',
      generate: 'client',
    }).js.code

    expect(compiled).toContain('$.mutable_source(useForm')
    expect(compiled).toContain('$.get(login).subscribe')
    expect(compiled).toContain('$.get(login).errors.has')
    expect(compiled).toContain('$.get(login).errors.first')
  })

  it('supports aliased imports and does not transform unrelated const declarations', () => {
    const source = [
      '<script>',
      '  import { useForm as createForm } from \'@holo-js/adapter-sveltekit/client\'',
      '',
      '  const untouched = createSomething()',
      '  const register = createForm(registerForm)',
      '</script>',
      '',
    ].join('\n')

    const transformed = transformSvelteUseFormReactivity(source)
    expect(transformed).toContain('const untouched = createSomething()')
    expect(transformed).toContain('let register = createForm(registerForm)')
    expect(transformed).toContain('register.subscribe(() => { register = register })')
  })
})
