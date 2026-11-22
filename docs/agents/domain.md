# Domain docs

## Layout

This repository uses single-context domain documentation:

- `GLOSSARY.md` at the repository root: domain vocabulary.
- `docs/adr/`: architecture decision records shared across packages.

## Consumer rules

Before exploring the codebase, read root `GLOSSARY.md` and ADRs relevant
to the work.

If these documents are absent, proceed silently. The domain-modeling
skill creates them lazily when terminology or decisions are resolved.

Use the glossary's vocabulary in issue titles, proposals, and tests.
If a needed concept is missing, reconsider the term or note the gap
for domain-modeling.

If a proposal contradicts an ADR, identify the ADR and explain why
the decision should be reopened.
