# Current form load performance

Measured 2026-09-09 against the prepared compiler-boundary fix. No framework or application source changes were made for this audit. The static comparison page was created outside the repository.

## Method

Five interleaved runs of each production page in separate Chromium browser contexts, cache disabled, 390 × 844 viewport, 4× CPU slowdown, 1.6 Mbps download throughput, and 150 ms emulated network latency. The control renders the same initial form markup without Holo logic. The Holo fixture retains validation, state, submission, and its server-action reference. The real application's login page was started through `holo start`.

These are local lab observations on this computer, not Lighthouse scores, field Core Web Vitals, or real-device results. First paint and LCP use PerformanceObserver. Script execution uses Chrome's Performance metrics. Observed blocking time sums the portion above 50 ms of long tasks starting after FCP through the end of the sample, after network idle plus 200 ms. This is not Lighthouse TBT's exact measurement window. See [Google's long-task explanation](https://web.dev/articles/optimize-long-tasks) and [Lighthouse TBT definition](https://developer.chrome.com/docs/lighthouse/performance/lighthouse-total-blocking-time).

## Results

Medians across five runs:

| Metric | Identical static form | Holo form | Real blog login |
| --- | ---: | ---: | ---: |
| Compressed initial JavaScript | 126,632 B | 141,072 B | 167,189 B |
| First contentful paint | 192 ms | 196 ms | 200 ms |
| Largest contentful paint | 192 ms | 196 ms | 200 ms |
| Script execution | 85.94 ms | 84.38 ms | 51.62 ms |
| Observed blocking time | 20 ms | 20 ms | 14 ms |

The matched form adds 14,440 compressed bytes. The older paragraph-only baseline produced a 14,618-byte increment; this audit improves the comparison by matching the initial HTML form.

The timing differences are small and script-duration ranges overlap: 81.42–91.57 ms for the static control and 80.78–86.38 ms for Holo. There is no evidence here that Holo makes execution faster, or that it adds a measurable paint/main-thread penalty in this small example. The real login is a different application and cannot be used to attribute savings to Holo.

The real login's invalid-email blur-to-error DOM update took 5.3–6.2 ms, median 5.8 ms, under the same CPU slowdown. This measures the DOM update after blur, not INP or the final pixel presentation.

The fetched Next page scripts use `async`. The legacy `nomodule` polyfill tag is not fetched by this Chromium browser. The scripts do not operate as classic synchronous parser-blocking scripts. Their execution can still occupy the main thread and the form's client behavior still requires hydration. [Next's rendering and hydration documentation](https://nextjs.org/docs/app/getting-started/server-and-client-components)

## Where the remaining code goes

The earlier isolated bundle measured 50,574 minified bytes, including 22,978 B of Holo validation, 7,971 B of Valibot, and 11,856 B of form-client code, with React external. Those are source contributions in a separate esbuild bundle, not additive compressed sizes or CPU costs.

A separate V8 coverage capture before interaction shows most of the form/validation code has not executed yet. This is expected for submission and validation handlers. Unexecuted code is not automatically unnecessary: deleting it would break later interactions. Coverage collection was kept separate from timing runs.

The raw runs, summaries, script attributes, and initial coverage are saved in [form-load-performance.json](form-load-performance.json).

## Improvement priorities

1. **Reduce validation code reachable from a small schema.** Holo currently dispatches through field-kind and rule-name switches that reference many Valibot validators. Prototype making unused rules removable while preserving the existing schema API and behavior. Compare production transfer bytes before accepting the complexity. This is the main identified download-size opportunity; no additional savings have been demonstrated yet. See [schema compilation](../packages/validation/src/contracts-support.ts).
2. **Keep client features scoped to pages that use them.** The audit already found no Holo modules in the browser when Holo is configured without client features. Avoid introducing forms into a shared layout or client import that every page needs. This is application-dependent; the current fixture already scopes its form to its page.
3. **Investigate compiled-schema reuse for repeated validation.** `runSchemaValidation` calls `resolveCompiledSchema` each time, which rebuilds the Valibot schema. Reuse might help large forms and repeated blur/change validation if schema immutability and custom-rule behavior permit it. It would not reduce downloaded bytes, and the small login form is already fast. See [validation execution](../packages/validation/src/contracts-runtime.ts).

Adding `defer` manually is not an appropriate fix for the async scripts Next already manages. Delaying all form code would shift the download into the user's first interaction and could change readiness or blur behavior. Changing to server-only validation is a separate API/behavior decision, not required by these measurements.

The measured overhead is approximately 14.4 KB compressed in the matched fixture. There is no measured reason to redesign working blur validation just to improve the lab timing of this small form. First prove a smaller import graph; then recheck bundle size and real-browser behavior. For large forms or a production homepage, repeat this audit on that actual route before attributing its slowdown to Holo.
