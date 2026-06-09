import DefaultTheme from 'vitepress/theme'
import { useRoute } from 'vitepress'
import { defineComponent, h, nextTick, onMounted, watch } from 'vue'

import './custom.css'

const TAB_GROUPS = [
  {
    storageKey: 'holo-docs-framework-tab',
    tabs: ['Next.js', 'Nuxt', 'SvelteKit'],
  },
  {
    storageKey: 'holo-docs-package-manager-tab',
    tabs: ['Bun', 'npm', 'pnpm', 'Yarn', 'Direct'],
  },
] as const

type TabGroup = typeof TAB_GROUPS[number]

let isSyncingTabs = false

function normalizeTab(title: string | null | undefined, group: TabGroup): string | null {
  if (!title) {
    return null
  }

  for (const tab of group.tabs) {
    if (
      title === tab
      || title.startsWith(`${tab} `)
      || title.startsWith(`${tab} -`)
      || title.startsWith(`${tab} —`)
    ) {
      return tab
    }
  }

  return null
}

function getCodeGroupLabels(group: Element): HTMLLabelElement[] {
  return Array.from(group.querySelectorAll<HTMLLabelElement>('.tabs label'))
}

function getMatchingTabGroup(group: Element): TabGroup | null {
  const labels = getCodeGroupLabels(group)

  for (const tabGroup of TAB_GROUPS) {
    if (labels.some((label) => normalizeTab(label.dataset.title ?? label.textContent, tabGroup))) {
      return tabGroup
    }
  }

  return null
}

function setCodeGroupTab(group: Element, tabGroup: TabGroup, tab: string): void {
  const labels = getCodeGroupLabels(group)
  const matchedIndex = labels.findIndex((label) => normalizeTab(label.dataset.title ?? label.textContent, tabGroup) === tab)

  if (matchedIndex === -1) {
    return
  }

  const matchedLabel = labels[matchedIndex]
  const inputId = matchedLabel.getAttribute('for')

  if (!inputId) {
    return
  }

  const input = group.querySelector<HTMLInputElement>(`#${CSS.escape(inputId)}`)

  if (!input) {
    return
  }

  input.checked = true

  const blocks = Array.from(group.querySelectorAll<HTMLElement>('.blocks > div[class*="language-"]'))

  blocks.forEach((block, index) => {
    block.classList.toggle('active', index === matchedIndex)
  })
}

function syncTabs(tabGroup: TabGroup, tab: string): void {
  document.querySelectorAll('.vp-code-group').forEach((group) => {
    if (getMatchingTabGroup(group) !== tabGroup) {
      return
    }

    setCodeGroupTab(group, tabGroup, tab)
  })
}

const ThemeLayout = defineComponent({
  name: 'ThemeLayout',
  setup() {
    const route = useRoute()

    const applyStoredTabs = () => {
      for (const tabGroup of TAB_GROUPS) {
        const stored = window.localStorage.getItem(tabGroup.storageKey)

        if (stored) {
          syncTabs(tabGroup, stored)
        }
      }
    }

    const handleChange = (event: Event) => {
      if (isSyncingTabs) {
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
      const group = target.closest('.vp-code-group')

      if (!group) {
        return
      }

      const tabGroup = getMatchingTabGroup(group)

      if (!tabGroup) {
        return
      }

      const tab = normalizeTab(label?.dataset.title ?? label?.textContent, tabGroup)

      if (!tab) {
        return
      }

      window.localStorage.setItem(tabGroup.storageKey, tab)
      isSyncingTabs = true

      try {
        syncTabs(tabGroup, tab)
      }
      finally {
        isSyncingTabs = false
      }
    }

    onMounted(() => {
      applyStoredTabs()
      document.addEventListener('change', handleChange)

      watch(
        () => route.path,
        async () => {
          await nextTick()
          applyStoredTabs()
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
