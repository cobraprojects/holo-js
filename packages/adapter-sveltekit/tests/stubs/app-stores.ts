import { writable } from 'svelte/store'

export const page = writable<{ readonly form: unknown }>({
  form: null,
})

export function setPageForm(form: unknown): void {
  page.set({ form })
}
