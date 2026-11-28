# <img src="site/logo.svg" alt="" width="32" height="32" align="top"> pr-trust

[![CI](https://github.com/maxbenschop/pr-trust/actions/workflows/ci.yml/badge.svg)](https://github.com/maxbenschop/pr-trust/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Website, rule builder and trust list directory: <https://maxbenschop.github.io/pr-trust/>**

A GitHub Action that checks who opened a pull request against rules you write, such as
"vouched for by us or by a project we trust" or "has merged work in projects we depend on".
It then labels the PR, and can comment and close it. It reads
[Vouch](https://github.com/mitchellh/vouch)'s `VOUCHED.td` lists and works alongside Vouch.

![Demo: an unknown author's pull request gets the "trust: unknown" label and a comment; a pull request from someone with merged work in rust-lang/rust gets "trust: admitted"](site/demo.gif)

It comes with two command-line tools:

- **`backtest`** replays a year of a repository's real PRs against your rules and shows
  what they would have kept, stopped and cost, before you install anything.
- **`check`** runs the Action's decision on any single PR without changing it.

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
         - uses: maxbenschop/pr-trust@00e722ff4f51d4bdf2b1ed89316b741ef5cf0ac6 # v0.1.1
   ```

   Pin the Action to a release's full commit hash, not a tag.

3. Before turning on `on_unknown: close`, see what it would do on your own history:

   ```sh
   pnpm backtest your-org/your-repo --config .github/trust.yml
   ```

## What happens on each pull request

1. The workflow starts when a PR is opened or reopened. It runs with your repository's
   token and never checks out or runs the PR's code.
2. PRs that are closed, opened by bots, or opened by people with write access are skipped.
3. The rules are read from your default branch, so a PR cannot change the rules that judge it.
   Without a rules file, the built-in defaults apply (your own Vouch list, or one earlier
   merged PR here) and a warning says so.
4. The author is the account that opened the PR, never the commit author, which anyone can
   set to any name.
5. Rules are checked in order, stopping at the first match:
   1. denounced in your own list: **denounced** (even on exempt paths)
   2. vouched in your own list: **admitted**
   3. each `admit` rule in turn: **admitted**
   4. only exempt paths changed: **exempt**
   5. otherwise: **unknown**
6. The PR gets one label for the result, replacing any earlier one. Unknown and denounced
   authors get a comment and, if configured, the PR is closed. An admitted author's earlier
   comment from this check is updated to say they now pass.
7. If a maintainer reopens a PR the check closed, the reopened PR is only labelled, never
   closed again.
8. If the check itself fails (GitHub down, broken rules file), the PR gets a
   "trust: check failed" label and is **never closed**.

## Rules reference

All keys are optional. See [`examples/trust.yml`](examples/trust.yml) for a commented example.

| Key | Default | Meaning |
|---|---|---|
| `own_list` | `auto` | Your Vouch list: `auto` (`.github/VOUCHED.td`, then `VOUCHED.td`), a path, or `none`. The only list whose denouncements count. |
| `admit` | none | Rules, checked in order (below). |
| `exempt_paths` | none | Glob patterns. A PR that changes only matching files skips the check. |
| `on_unknown` | `label` | `label` or `close`. |
| `on_denounced` | `close` | `label` or `close`. |
| `comment` | `unknown` | Comment on PRs from unadmitted authors (`unknown`), or only when closing (`never`). |
| `message_file` | built-in | Markdown file on your default branch with the comment text. Placeholders: `{author}`, `{reason}`, `{repo}`, `{next}`. See [`examples/trust-message.md`](examples/trust-message.md). |
| `labels` | `trust: admitted`, `trust: unknown`, `trust: denounced`, `trust: check failed` | Label names for `admitted`, `unknown`, `denounced` and `error`; `""` turns one off. |

`admit` rules:

| Rule | Admits the author when |
|---|---|
| `list: owner/repo` | they are vouched in that repository's Vouch list (its denouncements are ignored) |
| `list: owner/repo:path/VOUCHED.td` | the same, for a list stored elsewhere |
| `merged: { repo: owner/repo, min: 3, within: 24mo }` | they have at least `min` merged PRs in that repository within the period (`d`, `w`, `mo`, `y`; default 24mo) |
| `merged: { repo: self, ... }` | the same, in this repository |

Trust goes one step only: a project you list admits the people it vouched for, not the
people trusted by the projects it trusts.

## Inputs and outputs

| Input | Default | |
|---|---|---|
| `github-token` | `${{ github.token }}` | Needs `pull-requests: write` to label, comment and close |
| `config` | `.github/trust.yml` | Rules file on the default branch |
| `dry-run` | `false` | Decide and report, change nothing |
| `pr-number` | from the event | Check another PR, for example from `workflow_dispatch` |
| `as-author` | empty | Try your rules: check the PR as if this username had opened it as an outside contributor. Labels and comments are applied unless `dry-run` is on |
| `fail-on-error` | `false` | Fail the job when the check fails (the PR stays open regardless) |

| Output | |
|---|---|
| `status` | `admitted`, `exempt`, `unknown`, `denounced`, `skipped` or `error` |
| `admitted` | `"true"` for admitted, exempt or skipped |
| `reason` | One line, such as `3 merged PRs in rust-lang/rust` |
| `rule` | The rule that admitted the author |

Each run also writes a short table to the job summary.

## Trust lists

The [website](https://maxbenschop.github.io/pr-trust/#lists) has a directory of public Vouch
lists you can trust with `list:` rules, built from [`lists/catalog.json`](lists/catalog.json)
and refreshed weekly. To suggest one, see [CONTRIBUTING.md](CONTRIBUTING.md#suggesting-a-trust-list-for-the-website).

## Using it with Vouch

Keep your Vouch setup and let this Action admit people your list does not know yet.
Run it in dry-run mode so Vouch keeps doing the labelling and closing, and skip Vouch's
check for anyone it admits ([full example](examples/with-vouch.yml)):

```yaml
      - id: trust
        uses: maxbenschop/pr-trust@00e722ff4f51d4bdf2b1ed89316b741ef5cf0ac6 # v0.1.1
        with:
          dry-run: "true"
      - if: steps.trust.outputs.admitted != 'true'
        uses: mitchellh/vouch/action/check-pr@d66fa29a64600490892131ad87597c30c91fcac4 # v1
        with:
          pr-number: ${{ github.event.pull_request.number }}
          auto-close: true
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

## Command-line tools

Both need Node 22.18 or later and a GitHub token (`GITHUB_TOKEN`, `GH_TOKEN`, or a
`gh auth login` session). Only read access is used. Run them without installing:

```sh
npx github:maxbenschop/pr-trust check astral-sh/uv#23415                    # the repo's rules, or defaults
npx github:maxbenschop/pr-trust check astral-sh/uv#23415 --config my.yml    # try your own rules
npx github:maxbenschop/pr-trust backtest ghostty-org/ghostty --config my.yml --json run.json
```

From a clone, `pnpm check …` and `pnpm backtest …` do the same.

### Reading a backtest

Each outside PR is judged as of the moment it was opened: the trust lists as they stood
that day, and merges before it. The report then compares the verdicts with what really
happened (merged; rejected by a maintainer; withdrawn by its author; closed by a bot; open).

- **Keeps**: the share of merged outside PRs the rules would have let through. The rest is
  good work they would have turned away.
- **Stops**: the share of PRs maintainers rejected that the rules would have blocked, which is
  review time saved.
- **Merge rates** for PRs let through and PRs blocked. If they are close, the rules are not
  telling good contributions from bad.
- **Cost**: merged PRs that would have been blocked, the contributors most affected, and how
  many newcomers blocked on their first PR still went on to get one merged.

`backtest` options: `--config`, `--until <YYYY-MM-DD>`, `--days <n>` (default 365),
`--json <file>`, `--refresh`, `--quiet`. GitHub responses are cached in `.cache/`, so
reruns with other rules are fast.

## Limitations

The Action:

- `merged` rules use GitHub search, which leaves out some repositories entirely (for example
  `facebook/react`). Such a rule then never matches, and the run shows a warning saying so.
- It acts on the PR's state when the event fired. A PR edited later is not checked again
  unless it is reopened.
- It needs `pull_request_target`. With `pull_request`, PRs from forks get a read-only token,
  so labelling fails and the check reports an error.

The backtest:

- **Counterfactual.** History is replayed as it happened. A real gate would have stopped some
  PRs whose merges later admit their authors, so "merged here" rules look slightly better
  than they would in practice.
- **Maintainers are inferred.** GitHub shows private org members to outsiders as ordinary
  contributors, so anyone seen merging a PR or closing someone else's in the past year also
  counts as a maintainer. Staff who do neither still count as outsiders. Roles are taken
  from the whole period, so contributors who later became maintainers count as maintainers
  throughout, which makes the cost to newcomers look smaller than it was.
- **Bot-named accounts.** User accounts whose login ends in "bot" count as bots.
- **Existing gates.** Where Vouch or similar already auto-closes PRs, those PRs show up as
  closed by a bot rather than rejected. Use `--until` to test a period before the gate.
- Trust list history comes from the default branch's commit dates, and renamed accounts
  appear under their current login.

## Security

See [SECURITY.md](SECURITY.md) for what the Action can do with its token.

## Development

```sh
pnpm test        # unit tests (no network)
pnpm typecheck
pnpm build       # bundles the Action (dist/index.cjs) and CLI (dist/cli.mjs); commit both
pnpm lists       # refresh site/lists.json from lists/catalog.json
```

| Folder | |
|---|---|
| `src/engine/` | Rules, config and Vouch list parsing. No network; shared by everything. |
| `src/github/` | API client with retries and rate-limit handling, cache, queries |
| `src/action/` | The Action: live data, the check, planning and applying actions |
| `src/backtest/` | History lookups, replay and the report |
| `src/cli/` | `check` and `backtest`, and the `pr-trust` command that bundles both |
| `site/` | The website (static; deployed to GitHub Pages) |
| `lists/` | The trust list directory's catalog |

CI runs the tests, rebuilds `dist/` and fails if it differs from what is committed, then runs
the Action from the checkout on the PR in dry-run mode. Pushing a `vX.Y.Z` tag builds, tests,
attaches a signed build attestation for `dist/index.cjs`, creates the release and moves the
major tag (`vX`).

## License

Apache-2.0
