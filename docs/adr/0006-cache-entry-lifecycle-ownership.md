# Share cache entry mechanics while retaining query policy

Ordinary caching and query caching will share internal entry identity, serialization, expiry, locking primitives, and deletion handling, while query dependency indexing remains specialized behavior. We chose this over routing every query-cache operation through the ordinary facade because a query bridge can own an independently injected dependency index. Driver deletion must succeed before dependency tracking is removed; existing driver deletion booleans and per-interface refresh-lock waiting policies are preserved.

Existing interfaces remain unchanged. Verification must cover failed deletion retaining dependency tracking, prefixes, refresh contention, scoped invalidation, and preservation of other drivers' entries; no new driver abstraction is needed.

Verification also covers independently injected dependency indexes, serialization, and expiry through ordinary and query cache interfaces with real local drivers. Equivalent prefixes under valid normalized configuration are not a separate defect.
