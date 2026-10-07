# Preserve query semantics when bounded traversal is unsafe

Query traversal will use bounded fetching where correctness permits it and retain full-result behavior initially for query shapes that cannot safely use cursor batching. We chose this over requiring bounded traversal for every shape because joins, groups, unions, and projections can lack a stable cursor ordering. Deepening traversal must preserve ordering, duplicate rows, and mutation behavior rather than introduce a cursor strategy that changes results.

Bounded ascending model chunking continues to observe changes to later records, while existing full-result fallbacks retain their snapshot behavior. Newly bounded table and descending traversal will also observe changes made by earlier callbacks; this behavior change is explicitly accepted for eligible query shapes.

Traversal planning and retrieval will concentrate in the query module, with model hydration, batched relation processing, and observations retained behind the model seam. Existing caller-facing method shapes remain unchanged. Verification must cover bounded reads, early termination, projections, cached results, duplicate rows, and the distinct joined/grouped/union fallback behaviors.
