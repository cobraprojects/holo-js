import { Agent, setGlobalDispatcher } from 'undici'

const dispatcherThatLeavesTypeOfServiceUnset = new Agent()

export function sendFetchThroughConnectionResetSafeDispatcher() {
  setGlobalDispatcher(dispatcherThatLeavesTypeOfServiceUnset)
}
