import { config } from '@holo-js/config'

export function getApplicationTimezone(): string {
  try {
    const timezone = config('app.timezone')
    return typeof timezone === 'string' ? timezone : 'UTC'
  } catch {
    return 'UTC'
  }
}
