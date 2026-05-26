import { defineNitroPlugin } from 'nitropack/runtime/plugin'
import {
  applyFormFailureRedirect,
  getFormFailurePayload,
  shouldRedirectFormFailure,
  type NitroEvent,
  type NitroResponse,
} from '../server/form-failure'

type NitroApp = {
  hooks: {
    hook(name: 'beforeResponse', handler: (event: NitroEvent, response: NitroResponse) => void): void
  }
}

export default defineNitroPlugin((nitroApp: NitroApp) => {
  nitroApp.hooks.hook('beforeResponse', (event, response) => {
    if (!shouldRedirectFormFailure(event)) {
      return
    }

    const failure = getFormFailurePayload(response.body)
    if (!failure) {
      return
    }

    applyFormFailureRedirect(event, response, failure)
  })
})
