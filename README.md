# <img src="site/logo.svg" alt="" width="32" height="32" align="top"> pr-trust

[![CI](https://github.com/maxbenschop/pr-trust/actions/workflows/ci.yml/badge.svg)](https://github.com/maxbenschop/pr-trust/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Website, rule builder and trust list directory: <https://maxbenschop.github.io/pr-trust/>**

A GitHub Action that checks who opened a pull request against rules you write, such as
"vouched for by us or by a project we trust" or "has merged work in projects we depend on".
It then labels the PR, and can comment and close it. It reads
[Vouch](https://github.com/mitchellh/vouch)'s `VOUCHED.td` lists and works alongside Vouch.

![Demo: an unknown author's pull request gets the "trust: unknown" label and a comment; a pull request from someone with merged work in rust-lang/rust gets "trust: admitted"](site/demo.gif)

It comes with three command-line tools:

- **`backtest`** replays a year of a repository's real PRs against your rules and shows
  what they would have kept, stopped and cost, before you install anything.
- **`check`** runs the Action's decision on any single PR without changing it.
- **`validate`** finds mistakes in a rules file before it is merged.

## Quick start

1. Add `.github/trust.yml` to your default branch:

   ```yaml
   own_list: auto                     # your VOUCHED.td, if you have one
   admit:
     - list: ghostty-org/ghostty      # people a project you trust has vouched for
     - merged: { repo: self, min: 1, within: 24mo }
   on_unknown: label                  # start by labelling; switch to close later
   ```

2. Add `.github/workflows/pr-trust.yml`:

   ```yaml
   name: Contributor trust
   on:
     pull_request_target:
       types: [opened, reopened]
   permissions:
     contents: read
     pull-requests: write
   jobs:
     check:
       runs-on: ubuntu-latest
       steps:
         - uses: maxbenschop/pr-trust@7ba270aa66f83cf1a9c882e85d090c5e8fa8aa74 # v0.1.3
   ```

   Pin the Action to a release's full commit hash, not a tag.

3. Before turning on `on_unknown: close`, see what it would do on your own history:

   ```sh
   pnpm backtest your-org/your-repo --config .github/trust.yml
   ```

## Documentation

On the website, or as Markdown in [`docs/`](docs/):

| | |
|---|---|
| [Getting started](https://maxbenschop.github.io/pr-trust/docs/getting-started/) | Install, what happens on each pull request, using it with Vouch |
| [Rules](https://maxbenschop.github.io/pr-trust/docs/rules/) | Every key in `.github/trust.yml`, and checking the file before merging |
| [Vouching](https://maxbenschop.github.io/pr-trust/docs/vouching/) | The `/vouch` comment, protected branches, checking again when your list changes |
| [Action reference](https://maxbenschop.github.io/pr-trust/docs/action/) | Inputs, outputs and permissions |
| [Command line](https://maxbenschop.github.io/pr-trust/docs/command-line/) | `check`, `backtest`, `validate`, and reading a backtest |
| [GitHub Enterprise](https://maxbenschop.github.io/pr-trust/docs/enterprise/) | Enterprise Server and `ghe.com` |
| [Limitations](https://maxbenschop.github.io/pr-trust/docs/limitations/) | What the Action and the backtest cannot see |
| [For contributors](https://maxbenschop.github.io/pr-trust/contributors/) | What the labels mean, for people whose pull request got one |

In short: the rules are read from your default branch, so a pull request cannot change the
rules that judge it. The Action never checks out or runs the pull request's code. People with
write access and bots are skipped. If the check itself fails, the pull request gets a
"trust: check failed" label and is never closed.

## Security

See [SECURITY.md](SECURITY.md) for what the Action can do with its token.

## Development

```sh
pnpm test        # unit tests (no network)
pnpm typecheck
pnpm build       # bundles the Action (dist/index.cjs) and CLI (dist/cli.mjs); commit both
pnpm lists       # refresh site/lists.json from lists/catalog.json
pnpm build:docs  # render docs/*.md into site/docs/ (not committed)
```

| Folder | |
|---|---|
| `src/engine/` | Rules, config and Vouch list parsing. No network; shared by everything. |
| `src/github/` | API client with retries and rate-limit handling, cache, queries |
| `src/action/` | The Action: live data, the check, planning and applying actions |
| `src/backtest/` | History lookups, replay and the report |
| `src/cli/` | `check`, `backtest` and `validate`, and the `pr-trust` command that bundles them |
| `docs/` | The documentation, as Markdown; `pnpm build:docs` renders it into `site/docs/` |
| `site/` | The website (static; deployed to GitHub Pages) |
| `lists/` | The trust list directory's catalog |

CI runs the tests, rebuilds `dist/` and fails if it differs from what is committed, then runs
the Action from the checkout on the PR in dry-run mode. Pushing a `vX.Y.Z` tag builds, tests,
attaches a signed build attestation for `dist/index.cjs`, creates the release and moves the
major tag (`vX`).

## License

Apache-2.0
