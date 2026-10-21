# @holo-js/broadcast

Define broadcast events and channels, publish events, and run the WebSocket worker.

**Experimental in 0.4.0.** Broadcast is not production-ready. Reconnection and resubscription, presence after a worker stalls past its Redis lease, and protocol hardening remain in the separate Realtime production readiness milestone. Do not rely on uninterrupted live updates or accurate presence after failures. With Redis scaling, a write committed in any process refreshes Realtime queries on every worker.

This label does not change runtime behavior or indicate that the planned 0.4.0 data-exposure fixes have already shipped.

- [Documentation](https://docs.holo-js.com/broadcasting/)
- [Production limits](https://docs.holo-js.com/broadcasting/production#experimental-production-limits)
