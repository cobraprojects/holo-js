# Form validation and browser bundle costs

Research date: 2026-09-09. This report compares architecture, not vendors' advertised bundle sizes. No application code or public API was changed for this research.

A server can validate a form and return field errors without sending its validator to the browser. Conform explicitly supports this approach. Client validation buys immediate feedback without a network request, but it is a product choice with a download cost. [Conform validation guide](https://conform.guide/validation)

## Response data and downloaded code are different costs

HTTP 422 describes a request whose content type and syntax the server understands but whose instructions it cannot process. It does not require sending schemas, validators, or compiler code to the browser. The application chooses the response body. [HTTP semantics, section 15.5.21](https://www.rfc-editor.org/rfc/rfc9110.html#name-422-unprocessable-content)

Holo's form failure payload contains `ok`, `status`, `valid`, sanitized `values`, and `errors`. The client applies these values and errors to existing form state. This is separate from JavaScript fetched when the application loads. Returning fewer JSON fields would not remove a validation runtime from that JavaScript. See [failure serialization](../packages/forms/src/contracts.ts) and [client state handling](../packages/forms/src/internal/client.ts).

## What other packages do

| Package | How it handles browser validation and server errors | Relevant consequence |
| --- | --- | --- |
| Conform | Fully server-side validation returns a submission result consumed through `lastResult`. Adding `onValidate` runs a schema in the browser. Server validation can also run on blur or input. | Excluding the browser schema is supported explicitly. Validation before submission then costs a network round trip. [Official guide](https://conform.guide/validation) |
| React Hook Form | Schema integrations live in the separate `@hookform/resolvers` package and are passed through `resolver`. `setError` accepts field and global errors, including errors returned by a server. | Form state and displaying server errors do not inherently require importing Zod or Valibot. [Official resolvers repository](https://github.com/react-hook-form/resolvers), [official error documentation source](https://github.com/react-hook-form/documentation/blob/master/src/content/docs/useform/seterror.mdx) |
| SvelteKit Superforms | Supports browser HTML constraints, optional schema validators, and `validators: false`. Its `valibotClient` and similar adapters reduce client adapter work. | Its docs explicitly say importing a client schema adds the validation library to the browser bundle. Built-in browser constraints avoid that dependency, with fewer validation and presentation options. [Official client validation guide](https://superforms.rocks/concepts/client-validation) |
| Valibot | Uses small independent functions so bundlers can remove unused validators through static analysis. | Savings depend on what the application or wrapper actually references. A generic interpreter that references every supported rule can retain those rules. [Official architecture comparison](https://valibot.dev/guides/comparison/) |
| Zod Mini | Uses more top-level functions and fewer schema methods so unused checks can be removed. It exposes a different authoring style from regular Zod. | Changing libraries alone is not a substitute for controlling which validation code is reachable. Zod itself recommends measuring the actual use case. [Official Zod Mini documentation](https://zod.dev/packages/mini) |

HTML constraints can cover common field requirements through the browser's constraint validation mechanism. They do not express arbitrary application rules, and a hostile client can bypass them. Server validation must remain authoritative. [HTML specification](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#client-side-form-validation)

## What Holo currently does

`createFormClient` accepts a runtime schema and imports `safeParse`. Its submit path always runs local validation before calling the submitter. `validateOn` defaults to `submit` and also supports local change and blur validation. Explicit `validate` and field validation methods use the same path. This means Holo currently ships validation to preserve existing form behavior, even when a developer primarily wants server error handling. [Form client implementation](../packages/forms/src/internal/client.ts)

The schema runtime calls Valibot and compiles field definitions through switches over field kinds and rule names. Those switches directly reference email, URL, UUID, numeric, array, and other validation functions. The source therefore gives bundlers less opportunity to exclude unrelated checks than a small schema constructed directly from independent Valibot functions. This is an architectural inference from the source, not a measured allocation of the remaining browser chunk. [Validation runtime](../packages/validation/src/contracts-runtime.ts), [schema compilation](../packages/validation/src/contracts-support.ts)

## Recommendation for Holo

Keep the approved compiler import-boundary fix and the existing `useForm` imports. A TypeScript compiler has no role in displaying validation errors in the browser.

For the next design decision, separate form state, submission, and server error consumption from optional browser validation. A server-validation path could keep schemas on the server and send only the result and the metadata the browser needs. HTML constraints could supply basic immediate feedback. Client schema execution should be an explicit capability when users want richer feedback without a round trip. This recommendation is an inference from Conform and Superforms, not an API proposal or an implemented change.

That design needs approval because silently removing today's local validation would change submission timing, coercion, validation methods, and error feedback. A runtime option by itself is also insufficient if the browser still imports the runtime schema and its validator. The import graph must permit the omitted capability to leave the production bundle entirely.

For compatibility work that preserves current behavior, investigate compiling only the rules used by each schema or making rule implementations independently removable. Preserve the existing schema authoring API if possible. This needs a measured prototype before promising savings; arbitrary custom validators and dynamic schema construction make static extraction harder.

Compare a production baseline application, the same application with form state and server errors only, and the same form with client validation. Measure route JavaScript and compressed transfer sizes under identical build settings. Keep JSON response measurements separate. A shared Next.js chunk also includes framework and application code, so its whole size cannot be attributed to Holo validation.
