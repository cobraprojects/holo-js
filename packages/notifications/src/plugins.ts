import { loadHoloPluginContributionModules } from '@holo-js/config'
import {
  getRegisteredNotificationChannel,
  registerNotificationChannel,
  unregisterNotificationChannel,
} from './registry'
import type { NotificationChannel } from './contracts'

const loadedProjectRoots = new Set<string>()
const registeredPluginChannels = new Map<string, {
  readonly channel: NotificationChannel
  readonly previous: NotificationChannel | undefined
}>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function resolveNotificationChannel(moduleValue: unknown, packageName: string, channelName: string): NotificationChannel {
  const candidate = isRecord(moduleValue) && typeof moduleValue.default !== 'undefined'
    ? moduleValue.default
    : isRecord(moduleValue) && typeof moduleValue.channel !== 'undefined'
      ? moduleValue.channel
      : moduleValue

  if (!isRecord(candidate) || typeof candidate.send !== 'function') {
    throw new Error(`[@holo-js/notifications] Plugin ${packageName} notification channel "${channelName}" must export send().`)
  }

  return {
    send: candidate.send as NotificationChannel['send'],
    ...(typeof candidate.validateRoute === 'function'
      ? { validateRoute: candidate.validateRoute as NonNullable<NotificationChannel['validateRoute']> }
      : {}),
  }
}

export async function loadNotificationPluginChannels(projectRoot = process.cwd()): Promise<void> {
  if (loadedProjectRoots.has(projectRoot)) {
    return
  }

  const contributions = await loadHoloPluginContributionModules(projectRoot, 'notifications', 'channels')

  for (const contribution of contributions) {
    const previous = getRegisteredNotificationChannel(contribution.name)
    const channel = resolveNotificationChannel(contribution.module, contribution.plugin.packageName, contribution.name)
    registerNotificationChannel(
      contribution.name,
      channel,
      { replaceExisting: true },
    )
    const registered = getRegisteredNotificationChannel(contribution.name)
    if (registered) {
      const existingPluginChannel = registeredPluginChannels.get(registered.name)
      registeredPluginChannels.set(registered.name, {
        channel,
        previous: existingPluginChannel ? existingPluginChannel.previous : previous?.channel,
      })
    }
  }

  loadedProjectRoots.add(projectRoot)
}

export function resetNotificationPluginChannels(): void {
  for (const [channelName, registered] of registeredPluginChannels) {
    if (getRegisteredNotificationChannel(channelName)?.channel !== registered.channel) {
      continue
    }

    unregisterNotificationChannel(channelName)
    if (registered.previous) {
      registerNotificationChannel(channelName, registered.previous, { replaceExisting: true })
    }
  }

  loadedProjectRoots.clear()
  registeredPluginChannels.clear()
}
