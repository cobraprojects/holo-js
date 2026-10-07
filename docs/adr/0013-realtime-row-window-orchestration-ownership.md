# Keep Realtime window policies behind shared orchestration

The Realtime row-window module will concentrate shared patch preparation and mutation orchestration privately while retaining its existing interfaces and distinct cursor, offset, aggregate, and relation policies. We chose this over simplifying optimized paths through broader fetching or query reruns because page contents, ordering, structural sharing, bounded fetching, and avoided reruns must survive the refactor. Existing behavior and query-count verification remain the test surface.
