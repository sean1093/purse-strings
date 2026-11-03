## What changed

<!-- One or two sentences. What does this PR do? -->

## Why

<!-- The problem this solves. If it fixes an issue, link it so it closes on merge. -->

Closes #

## Type of change

- [ ] Bug fix (no API change)
- [ ] New feature (backwards compatible)
- [ ] Breaking change (existing correct code has to change)
- [ ] Documentation
- [ ] Internal only (tests, CI, tooling, refactor with no behaviour change)

## Effect on the guarantee

<!-- Delete this section if the change cannot affect enforcement.
     Otherwise: what is booked, when, and how atomically? Does any path now
     allow a call that was refused before, or refuse one that was allowed?
     Does it grow state an attacker controls? -->

## Checklist

- [ ] Tests added or updated. A bug fix includes a test that fails before this change.
- [ ] A new or changed store adapter still passes the store contract suite against a real backend.
- [ ] `npm run lint && npm run typecheck && npm test` pass locally.
- [ ] `npx changeset` run and the generated file committed, or this change is not user-visible.
- [ ] Docs updated if the public API changed.
- [ ] No runtime dependency added. `dependencies` is still empty, and `src/` still imports no Node.js built-in.

## Verification

<!-- The commands you ran and what they reported. -->

## Notes for the reviewer

<!-- Anything worth knowing: a tradeoff you made, a case you deliberately left out,
     a benchmark or size number. Delete this section if there is nothing to say. -->
