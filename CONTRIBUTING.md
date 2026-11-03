# Contributing to purse-strings

Bug reports, failing-test reproductions, and pull requests are all welcome.
This document is the whole process: what you need installed, what the scripts
do, what a PR has to pass, and what will be declined on sight.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Security problems go through [SECURITY.md](SECURITY.md), never a public issue:
a way to spend past a configured limit is a vulnerability.

Before proposing a behaviour change, read the
[threat model](docs/threat-model.md). This library is a spending control, and
most of its design is a consequence of what that document promises.

## Prerequisites

- **Node.js >= 20.** The package declares `engines.node: ">=20"` and CI runs
  20, 22, 24 and 26 on Linux, plus 24 on Windows and macOS. `.nvmrc` pins 22
  (the active LTS) for local work, so `nvm use` picks the right version.
- **npm.** The lockfile is `package-lock.json` and is committed; please do not
  swap in another package manager or commit a second lockfile.
- Nothing else. The library has **zero runtime dependencies** and the toolchain
  is entirely devDependencies.

## Getting started

```sh
git clone https://github.com/sean1093/purse-strings.git
cd purse-strings
npm ci
npm test
```

Use `npm ci`, not `npm install`: it installs exactly the lockfile and fails
loudly if `package.json` and the lockfile disagree, which is what CI does.

## Scripts

| Script | Command | What it checks |
|---|---|---|
| `npm run build` | `tsup` | Produces `dist/` — ESM, CJS, and generated `.d.ts` — from the TypeScript sources. |
| `npm run dev` | `tsup --watch` | Rebuilds `dist/` on save, for iterating against the built output. |
| `npm test` | `vitest run` | Runs the suite once and exits. This is the command CI runs. |
| `npm run test:watch` | `vitest` | Same suite in watch mode while you edit. |
| `npm run test:coverage` | `vitest run --coverage` | Runs the suite and fails if coverage drops below the thresholds below. |
| `npm run test:firestore` | `vitest run --config vitest.integration.config.ts test/integration/firestore.test.ts` | Runs the store contract suite against the Firestore emulator. It needs `FIRESTORE_EMULATOR_HOST`, so run it through `firebase emulators:exec` as [the Firestore guide](docs/firestore.md#running-the-tests) shows. |
| `npm run test:cloudflare` | `vitest run --config vitest.integration.config.ts test/integration/cloudflare-` | Runs the store contract suite against Miniflare. Needs no account and no network. |
| `npm run lint` | `biome check .` | Formatting and lint rules. Read-only; it reports, it does not rewrite. |
| `npm run lint:fix` | `biome check --write .` | Applies every fix Biome can apply. Run this instead of arguing with `lint`. |
| `npm run typecheck` | `tsc --noEmit` | Type errors across the whole project, including tests. |
| `npm run check:docs` | `node scripts/check-docs.mjs` | Every relative link and heading anchor in the docs resolves, every code fence declares a language, and no merge marker or unfinished-work note survived. It also compares this table against the scripts `package.json` defines, in both directions. |
| `npm run check:examples` | `tsc -p examples/tsconfig.json` | Type-checks `examples/` against the built package, so a snippet that no longer compiles fails CI. Run `npm run build` first. |
| `npm run check:exports` | `attw --pack . && publint` | Packs the tarball and verifies the `exports` map really resolves for ESM, CJS, and TypeScript consumers. |
| `npm run size` | `size-limit` | Fails if a bundle grows past its budget, so the size claim in the README stays true. |

## Project layout

```text
src/        the published library; every entry point in the exports map
            starts at a file here
test/       the vitest suite, mirroring src/
docs/       the published guides, starting with the threat model
scripts/    dependency-free Node scripts used by the gates
.github/    workflows, issue forms, the pull request template
```

Two constraints apply to everything under `src/`:

- **No runtime dependencies.** `dependencies` is empty and stays empty.
- **No Node.js built-ins.** The guard has to run on Cloudflare Workers, Deno
  and Bun as well as Node, so `src/` uses only language and web platform
  globals. The build enforces this: `tsup` runs with esbuild's `neutral`
  platform, where an accidental `node:*` import fails the build. Test files
  and scripts are free to use Node APIs.

## Adding a store adapter

A store is the only part of the library that touches the outside world, and
the limit is only as strong as the store beneath it. An adapter must:

1. **Implement `BudgetStore`** — `consume()`, `add()` and `read()`, plus a
   `consistency` field that honestly says `'strong'` or `'eventual'`. Claiming
   `'strong'` for a store that cannot check and increment atomically is a
   vulnerability, not an optimisation.
2. **Pass the shared store contract suite** in `test/contract/store-contract.ts`
   against a real instance — an emulator or a local runtime, not a mock. The
   suite covers all-or-nothing `consume()`, per-dimension limits, `add()`
   never dropping a counter below zero, missing and expired keys reading as
   zeros, expiry, and — for `'strong'` stores only — concurrent reservations
   never booking past a limit.
3. **Expire counters by value, not only by platform TTL.** Platform expiry
   (a Firestore TTL policy, a Workers KV `expiration`, a Durable Object alarm)
   is garbage collection and is allowed to lag. A counter past its `expiresAt`
   must read as zeros regardless.
4. **Fail closed.** Propagate store errors rather than treating a failed write
   as a successful one. `reserve()` throwing is the safe outcome.
5. **Ship as its own entry point**, with its platform types declared
   structurally in this package so no SDK becomes a dependency.

Add a CI job that runs the suite against the real backend. An adapter with no
executed contract run is an adapter nobody can trust.

## Making a change

**1. Branch.** Name it `<type>/<short-slug>`, where `<type>` is one of `feat`,
`fix`, `docs`, `chore`, `ci`, or `refactor`:

```sh
git switch -c fix/week-window-boundary
```

**2. Commit with [Conventional Commits](https://www.conventionalcommits.org/).**
The subject is imperative, at most 72 characters, and has no trailing period.
Explain *why* in the body, wrapped at 72 columns.

```text
fix(windows): start ISO weeks on Monday in UTC

The week window floored to a multiple of seven days from the epoch,
which is a Thursday, so a Monday-aligned rule reset mid-week. Derive
the start from the UTC day of week instead.
```

```text
feat(cloudflare): add a Durable Objects store
```

A `!` after the type, or a `BREAKING CHANGE:` footer, marks an incompatible
change.

**3. Test anything that changes behaviour.** A bug fix must come with a test
that fails before your change and passes after it — that test is what stops the
bug returning. A change to the enforcement path needs the boundary case, the
concurrent case and the error it throws, not just the happy path. Refactors
that change no behaviour need no new test, but the existing suite must stay
green.

Tests defend observable behaviour. A test that asserts a field was copied, a
default was applied, or a mock was called tells you nothing about whether a
budget can be exceeded; a test that fires fifty concurrent reservations at a
limit of ten does.

**4. Add a changeset for anything user-visible.** If your change alters the
published package in any way a consumer could notice — API, behaviour, types,
bundle contents, documented defaults — run:

```sh
npx changeset
```

Pick the bump by what a consumer has to do:

| Bump | When | Example |
|---|---|---|
| `patch` | Behaviour that was already documented now actually works. No consumer action. | Fixing a window boundary; correcting a type that was too narrow. |
| `minor` | Something new that existing code keeps working without. | A new store adapter; a new optional rule field. |
| `major` | Existing correct code has to change. | Removing or renaming an export; throwing where the old version returned a value. |

Commit the generated file in `.changeset/`. Purely internal changes — CI,
tests, lint config, a comment — need no changeset.

**5. Open the PR against `main`.** Fill in the template: what changed, why, and
the linked issue. Small, focused PRs get reviewed quickly; a large change is
better split into a reviewable series.

## Quality gates

CI guards `main`, and every job must pass before a PR can merge.

The **quality** job runs once, on Node 22, in this order:

1. `lint` — Biome formatting and rules.
2. `typecheck` — `tsc --noEmit` clean.
3. `check:docs` — links, anchors, code fences, and this document's Scripts
   table. It runs here, before the build, because it needs nothing built.
4. `test:coverage` — the suite plus coverage thresholds: **90% lines, 90%
   functions, 90% statements, 85% branches**. Below any of those, the job
   fails.
5. `build` — `tsup` produces every entry point in ESM, CJS and `.d.ts` form.
6. `check:exports` — `attw` and `publint` agree the packed tarball resolves for
   ESM, CJS, and TypeScript.
7. `size` — every entry point is within its budget.

The **test** job runs `test` and `build` on Node 20, 22, 24 and 26 on Linux,
and on Node 24 on Windows and macOS. Lint, typechecking, coverage, packaging
and size are runtime-independent, so they run once rather than six times.

You can run the same sequence locally. The fast pre-push check is:

```sh
npm run lint && npm run typecheck && npm test
```

## Releases

Releases are automated and restricted to maintainers.

Every user-visible change arrives on `main` with a changeset. The release
workflow re-runs the quality gates on the commit, and then
[changesets](https://github.com/changesets/changesets) either opens a
"Version Packages" pull request collecting the pending changesets, or — once
that pull request is merged and the version is already bumped — publishes the
new version to npm with
[provenance](https://docs.npmjs.com/generating-provenance-statements) and tags
the commit.

`CHANGELOG.md` is generated from the changesets. Never edit it by hand.

The one-time setup, for a maintainer:

1. Create an npm **automation** token for the `purse-strings` package. Classic
   tokens and granular tokens with two-factor enforcement are rejected by
   unattended publishes.
2. Add it as the repository secret `NPM_TOKEN` under Settings, then Secrets and
   variables, then Actions.
3. Leave `publishConfig.provenance` set in `package.json`. Provenance is only
   accepted for a public package published from a supported CI provider, which
   is why the release job holds `id-token: write`.

Without `NPM_TOKEN` the release workflow still runs and still passes; it
reports a warning saying nothing was published, rather than painting `main`
red.

## What does not belong in this library

These are settled design decisions, not open questions. A PR adding one of them
will be declined regardless of quality, so please open a
[discussion](https://github.com/sean1093/purse-strings/discussions) first if
you think one should be reconsidered.

- **A built-in price table.** Provider prices change far more often than this
  package is released, and a stale table silently under-prices a model, which
  is a budget bypass caused by the library. Callers supply pricing.
- **A tokenizer.** `estimateTokens()` is a byte heuristic for reservations and
  says so. A real tokenizer means per-model vocabularies, megabytes of data and
  a runtime dependency, for an estimate that `commit()` corrects moments later.
- **Provider SDK imports.** Usage helpers take plain objects and store adapters
  type their platform structurally. Nothing in `dependencies`, and no optional
  peer that changes behaviour when installed.
- **Sliding windows.** They need per-event timestamps, which turns one integer
  per subject into a list whose length an attacker controls, in a store that
  charges per read. Combine a short fixed window with a long one instead.
- **Fail-open behaviour on store errors.** Making a store outage allow spending
  turns the outage into the attack. A caller who wants that can catch the
  error and decide; the library will not decide it silently.
- **Prompt-injection detection, content moderation, or anything that inspects
  prompt text.** Different problem, different failure mode.
- **Cross-process agent runs.** Run limits are in-process by design; see the
  threat model.
- **Retries, backoff or queueing inside the guard.** `reserve()` either books
  or throws. Scheduling is the caller's.

Everything else — new stores, new provider usage helpers, better errors,
better docs, smaller output — is fair game.
