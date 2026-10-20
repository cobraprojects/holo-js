# @holo-js/realtime

Define server queries and mutations whose results update in the browser.

**Experimental in 0.4.0.** Realtime is not production-ready. Reconnection and resubscription, presence after a worker stalls past its Redis lease, cross-instance Realtime invalidation, and protocol hardening remain in the separate Realtime production readiness milestone. Do not rely on uninterrupted live updates or accurate presence after failures. Redis scaling does not share Realtime query subscriptions between workers.

This label does not change runtime behavior or indicate that the planned 0.4.0 data-exposure fixes have already shipped.

- [Documentation](https://docs.holo-js.com/realtime/)
- [Production limits](https://docs.holo-js.com/broadcasting/production#experimental-production-limits)
