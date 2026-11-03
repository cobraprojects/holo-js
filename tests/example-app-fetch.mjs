import { Agent, setGlobalDispatcher } from 'undici'

// A development restart resets connections it accepted but never answered. Node 24's bundled undici then calls
// setTypeOfService on the dead socket before its first write, and on macOS that throws EINVAL from a socket event
// listener: an uncaught exception that ends the journey instead of a fetch rejection (nodejs/undici#6075). undici 8
// leaves the type of service alone unless a request asks for one, so the dropped connection rejects the fetch.
export function sendFetchThroughConnectionResetSafeDispatcher() {
  setGlobalDispatcher(new Agent())
}
