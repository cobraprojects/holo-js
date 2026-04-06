# Testing

Holo-JS applications are easiest to trust when tests exercise the runtime the way the app actually runs:
through routes, models, storage, and real configuration.

## What to test

In a normal Holo-JS app, the most valuable test layers are:

1. route or handler tests
2. model and query workflow tests
3. migrations, factories, and seeding tests
4. storage/runtime integration tests where configuration matters

## Where tests usually live

This depends on the app, but a common structure is:

```text
tests/
├── api/
├── db/
├── storage/
└── setup/
```

The exact folder names matter less than keeping tests aligned with the server-side boundaries they verify.

## Test the framework the way it runs

That usually means:

- real runtime configuration
- real schema definitions
- real models and relations
- factories and seeders instead of hand-written invalid records
- explicit assertions for fail-closed and security behavior

## Application route tests

Start from the HTTP or handler boundary whenever practical.

Why:

- that is how the application is actually used
- it catches serialization, validation, relations, and runtime config mistakes together

## Model and query tests

Write direct model/query tests when the logic belongs to the data layer itself:

- scopes
- relation workflows
- serialization rules
- transaction behavior
- query edge cases

## Factory-first setup

Use factories and seeders to build data with real runtime rules rather than hand-assembling invalid
records in every test.

This keeps tests close to how the application actually writes records and relations.

## What to assert beyond the happy path

Applications are strongest when tests cover both successful and fail-closed behavior:

- invalid input
- unsupported operations
- security policy enforcement
- logging redaction or debug visibility
- timeouts and aborts
- transaction rollback behavior
- relation existence and eager-loading edge cases

## When to write a regression test

When a bug is fixed, add coverage for the bad path that caused it.

A useful rule of thumb:

- if the bug was malformed input, add malformed-input coverage
- if the bug was a dialect edge case, add dialect-specific regression coverage
- if the bug was a relation or transaction boundary issue, assert that boundary directly

## Practical guidance

- test the happy path
- test invalid input
- test unsupported or fail-closed paths
- test logging, security, and transaction behavior when the feature touches runtime policy
- prefer realistic setup over heavy mocking
