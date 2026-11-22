# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `cobraprojects/holo-js`.
Use the `gh` CLI from this repository.

## Operations

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --json number,title,state,labels,body,comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body-file <file>`
- Apply labels: `gh issue edit <number> --add-label "..."`
- Remove labels: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number>`

Use a UTF-8 file for multiline issue bodies and comments.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the issue and its comments.

## Implementation completion

Apply these steps when implementing a tracked issue, whether through `/implement`,
`/implement-all`, or direct instructions. Skip issue closure for work without a
tracked issue.

1. Verify the issue's requirements and confirm its changes are merged into `main`.
   Until then, keep the issue open and report what remains.
2. Add a completion summary with validation results and commit or PR references,
   then close the implementation issue.
3. If the issue references a parent spec, check all related implementation tickets.
   When all are complete and merged, review their combined implementation against
   the full parent spec. Closed tickets alone do not establish spec completion.
4. If the full spec is satisfied, add a completion summary with validation and
   implementation references, then close the parent. Otherwise, keep it open and
   report the remaining requirements.

## Pull requests as a triage surface

**PRs as a request surface: no.**
