import DefaultTheme from 'vitepress/theme'
import { useRoute } from 'vitepress'
import { defineComponent, h, nextTick, onMounted, watch } from 'vue'

import './custom.css'

const FRAMEWORK_TABS = new Set(['Next.js', 'Nuxt', 'SvelteKit'])
const FRAMEWORK_TAB_STORAGE_KEY = 'holo-docs-framework-tab'
let isSyncingFrameworkTabs = false

function normalizeFrameworkTab(title: string | null | undefined): string | null {
  if (!title) {
    return null
  }

  for (const framework of FRAMEWORK_TABS) {
    if (title === framework || title.startsWith(`${framework} `)) {
      return framework
    }
  }

  return null
}

function setCodeGroupTab(group: Element, framework: string): void {
  const labels = Array.from(group.querySelectorAll<HTMLLabelElement>('.tabs label'))
  const matchedLabel = labels.find((label) => normalizeFrameworkTab(label.dataset.title ?? label.textContent) === framework)

  if (!matchedLabel) {
    return
  }

  const inputId = matchedLabel.getAttribute('for')

  if (!inputId) {
    return
  }

  const input = group.querySelector<HTMLInputElement>(`#${CSS.escape(inputId)}`)

  if (!input || input.checked) {
    return
  }

  input.checked = true
}

function syncFrameworkTabs(framework: string): void {
  document.querySelectorAll('.vp-code-group').forEach((group) => {
    setCodeGroupTab(group, framework)
  })
}

const ThemeLayout = defineComponent({
  name: 'ThemeLayout',
  setup() {
    const route = useRoute()

    const applyStoredFramework = () => {
      const stored = window.localStorage.getItem(FRAMEWORK_TAB_STORAGE_KEY)

      if (stored) {
        syncFrameworkTabs(stored)
      }
    }

    const handleChange = (event: Event) => {
      if (isSyncingFrameworkTabs) {
        return
      }

      const target = event.target

      if (!(target instanceof HTMLInputElement)) {
        return
      }

      if (target.type !== 'radio' || !target.closest('.vp-code-group')) {
        return
      }

      const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(target.id)}"]`)
      const framework = normalizeFrameworkTab(label?.dataset.title ?? label?.textContent)

      if (!framework) {
        return
      }

      window.localStorage.setItem(FRAMEWORK_TAB_STORAGE_KEY, framework)
      isSyncingFrameworkTabs = true

      try {
        syncFrameworkTabs(framework)
      }
      finally {
        isSyncingFrameworkTabs = false
      }
    }

    onMounted(() => {
      applyStoredFramework()
      document.addEventListener('change', handleChange)

      watch(
        () => route.path,
        async () => {
          await nextTick()
          applyStoredFramework()
        },
      )
    })

    return () => h(DefaultTheme.Layout)
  },
})

export default {
  extends: DefaultTheme,
  Layout: ThemeLayout,
}
