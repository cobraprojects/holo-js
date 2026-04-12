import {
  deleteNotifications,
  listNotifications,
  markNotificationsAsRead,
  markNotificationsAsUnread,
  notify,
  notifyMany,
  notifyUsing,
  unreadNotifications,
} from './runtime'

export { defineNotificationsConfig } from '@holo-js/config'
export type { HoloNotificationsConfig, NormalizedHoloNotificationsConfig } from '@holo-js/config'

export {
  defineNotification,
  isNotificationDefinition,
  notificationsInternals,
  normalizeNotificationDefinition,
} from './contracts'
export type {
  AnonymousNotificationTarget,
  BuiltInNotificationChannelRegistry,
  HoloNotificationChannelRegistry,
  InferNotificationChannels,
  InferNotificationNotifiable,
  NotificationBroadcastMessage,
  NotificationBroadcastRoute,
  NotificationBuildContext,
  NotificationBuildFactories,
  NotificationChannel,
  NotificationChannelDispatchResult,
  NotificationChannelName,
  NotificationContext,
  NotificationDatabaseMessage,
  NotificationDatabaseRoute,
  NotificationDelayResolver,
  NotificationDelayValue,
  NotificationDefinition,
  NotificationDispatchInput,
  NotificationDispatchOptions,
  NotificationDispatchResult,
  NotificationDispatchTarget,
  NotificationEmailRoute,
  NotificationJsonValue,
  NotificationMailMessage,
  NotificationMailSender,
  NotificationPayloadFor,
  NotificationQueueOptions,
  NotificationQueueResolver,
  NotificationRecord,
  NotificationResultFor,
  NotificationRouteFor,
  NotificationRuntimeBindings,
  NotificationSendContext,
  NotificationStore,
  NotificationBroadcaster,
  PendingAnonymousNotification,
  PendingNotificationDispatch,
  RegisterNotificationChannelOptions,
  RegisteredNotificationChannel,
} from './contracts'
export {
  getRegisteredNotificationChannel,
  listRegisteredNotificationChannels,
  notificationRegistryInternals,
  registerNotificationChannel,
  resetNotificationChannelRegistry,
} from './registry'
export {
  configureNotificationsRuntime,
  deleteNotifications,
  getNotificationsRuntimeBindings,
  getNotificationsRuntime,
  listNotifications,
  markNotificationsAsRead,
  markNotificationsAsUnread,
  notificationsRuntimeInternals,
  notify,
  notifyMany,
  notifyUsing,
  resetNotificationsRuntime,
  unreadNotifications,
} from './runtime'

const notifications = Object.freeze({
  deleteNotifications,
  listNotifications,
  markNotificationsAsRead,
  markNotificationsAsUnread,
  notify,
  notifyMany,
  notifyUsing,
  unreadNotifications,
})

export default notifications
