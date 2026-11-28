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

## Vouching from a pull request

Optionally, a maintainer can admit an author without leaving the pull request by
commenting `/vouch`. The command only exists if your workflow also runs on new comments
([full example](examples/workflow-with-vouch.yml)):

```yaml
on:
  pull_request_target:
    types: [opened, reopened]
  issue_comment:
    types: [created]
permissions:
  contents: write        # /vouch commits to your trust list
  pull-requests: write
  issues: write          # reply to and react on comments on issues
jobs:
  check:
    # Most comments are not commands; skip those without starting a runner.
    if: github.event_name != 'issue_comment' || startsWith(github.event.comment.body, '/vouch')
    runs-on: ubuntu-latest
    steps:
      - uses: maxbenschop/pr-trust@<a release newer than v0.1.1>
```

- `/vouch` on a pull request vouches for its author; `/vouch @login` (or `/vouch login`) on
  a pull request or an issue vouches for that account. Only the first line of a new comment
  counts, and it must be exactly that.
- Only people with write, maintain or admin permission can use it, checked with GitHub's API.
  Anyone else's `/vouch` is ignored without a reply, as are bots and edited comments.
- The account is added to your own list on the default branch (where `own_list` points, or a
  new `.github/VOUCHED.td`), one line in Vouch's own format, in a commit that says who vouched
  for whom. The comment gets a +1 reaction, and the pull request is checked again, so its
  label and comment change to admitted. A closed pull request is not reopened; reopen it and
  the check runs again.
- Nothing is written if the account is already vouched for (the pull request is still
  checked again), or if it is denounced: `/vouch` never overturns a denouncement, and says so.
- If it cannot write (`own_list: none`, no `contents: write`), it replies saying what to do
  instead, including the exact line to add. It never changes the pull request in that case.

### Protected default branches

If branch protection or a ruleset says changes to the default branch must go through a pull
request, `/vouch` opens one instead: it commits the same one-line change to a branch named
`pr-trust/vouch-<login>`, opens a pull request titled "Vouch for @login" that says who asked
for it and where, and replies with a link: merge it to finish. If a pull request for that
account is already open, it links that one rather than opening a second. A leftover
`pr-trust/vouch-<login>` branch with no open pull request is reset to the default branch and
reused.

This needs `pull-requests: write` (already in the example) and the repository setting
**Allow GitHub Actions to create and approve pull requests** (Settings > Actions > General >
Workflow permissions; in an organization it may have to be allowed there first). Without
it, `/vouch` deletes the branch it created and replies saying which setting to change, or to
add the line in a pull request yourself.

A pull request opened with the workflow's `GITHUB_TOKEN` does not start other workflows. If
your rules require status checks, they stay pending until a person pushes to the branch (an
empty commit is enough) or closes and reopens the pull request.

Once it is merged, the pull request you commented on is checked again only if the workflow
also runs on pushes to the list (next section); otherwise comment `/vouch` again.

## Checking again when the list changes

Pull requests labelled "unknown" are not checked again on their own. To check them again
whenever your own list changes on the default branch (a merged `/vouch` pull request, or an
edit by hand), also run the workflow on pushes that touch the list:

```yaml
on:
  # ... the triggers above, plus:
  push:
    branches: [main]                 # your default branch
    paths: [.github/VOUCHED.td]      # the file own_list points to
```

On such a push, the Action checks the newest 50 open pull requests carrying your "unknown"
label again (with a warning if there are more). Those now admitted get the admitted label and
their comment updated, as usual, and an author you have just denounced is handled as on any
check. Those still unknown are left exactly as they are: no second
comment, and never closed, even with `on_unknown: close`. One that fails to check does not stop
the others. It does nothing with `own_list: none`, with the unknown label turned off, or if the
push did not change the list. This needs only `contents: read` and `pull-requests: write`.
A commit that `/vouch` makes directly with the workflow's `GITHUB_TOKEN` does not start this
run (GitHub does not let that token trigger workflows), but `/vouch` already checks the pull
request it was posted on; merging its pull request by hand does start it.

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
| `message_file` | built-in | Markdown file on your default branch with the comment text. Placeholders: `{author}`, `{reason}`, `{repo}`, `{next}`, `{rules}` (your rules as a list). See [`examples/trust-message.md`](examples/trust-message.md). |
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

## Checking the rules file before merging

A broken `.github/trust.yml` otherwise shows up only when the next pull request arrives and
gets "trust: check failed". Check it first:

```sh
npx github:maxbenschop/pr-trust validate                       # .github/trust.yml, offline
npx github:maxbenschop/pr-trust validate --online --repo your-org/your-repo
```

It parses the file exactly as the Action does and lists every error with its line, with a
hint for near misses (`on-unknown`, `admits`, `24m`). It also warns about settings that are
valid but probably not meant: nobody can be admitted under `on_unknown: close`, a repeated
or redundant rule, a `merged` window of days, `exempt_paths` that match nearly everything
or nothing, and labels that collide. `--online` also checks that every repository a rule
names exists (and reports renames), that each `list:` rule finds a Vouch list where the
Action looks, that `merged` repositories are in GitHub's search index, and that `own_list`
and `message_file` exist in `--repo`. Exit status: 0 without errors (warnings fail only with
`--strict`), 1 with errors, 2 if the file or GitHub could not be read. `--json` for scripts.

To check pull requests that change the rules, add a second workflow
([full example](examples/validate-rules.yml)):

```yaml
on:
  pull_request:
    paths: [.github/trust.yml]
permissions:
  contents: read
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: maxbenschop/pr-trust@<a release newer than v0.1.1>
        with:
          validate: .github/trust.yml
```

Keep it on `pull_request`, separate from the contributor check: the file comes from the pull
request, so it should only ever be read with the read-only token a fork's pull request gets
there, never with `pull_request_target`'s write token (the Action refuses that). The Action
reads the file through the API and only parses it; nothing is checked out or run. Errors
fail the job and appear as annotations on the file; warnings only annotate.

## Inputs and outputs

| Input | Default | |
|---|---|---|
| `github-token` | `${{ github.token }}` | Needs `pull-requests: write` to label, comment and close; `/vouch` also needs `contents: write` (and, on a protected default branch, permission to open pull requests) |
| `config` | `.github/trust.yml` | Rules file on the default branch |
| `dry-run` | `false` | Decide and report, change nothing |
| `pr-number` | from the event | Check another PR, for example from `workflow_dispatch` |
| `as-author` | empty | Try your rules: check the PR as if this username had opened it as an outside contributor. Labels and comments are applied unless `dry-run` is on |
| `fail-on-error` | `false` | Fail the job when the check fails (the PR stays open regardless) |
| `validate` | empty | Instead of checking a PR, check this rules file as of the workflow's commit and fail on errors ([above](#checking-the-rules-file-before-merging)) |

| Output | |
|---|---|
| `status` | `admitted`, `exempt`, `unknown`, `denounced`, `skipped` or `error`; with `validate`, `valid` or `invalid` |
| `admitted` | `"true"` for admitted, exempt or skipped |
| `reason` | One line, such as `3 merged PRs in rust-lang/rust` |
| `rule` | The rule that admitted the author |
| `command` | On a comment: `vouched`, `already-vouched`, `proposed` (a pull request adding the line is open), `refused` or `failed` for a maintainer's `/vouch`, else empty |
| `rechecked` | On a push that changed the list: the numbers of the pull requests checked again, comma-separated |

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

They need Node 22.18 or later. `check`, `backtest` and `validate --online` also need a GitHub
token (`GITHUB_TOKEN`, `GH_TOKEN`, or a `gh auth login` session); only read access is used.
Run them without installing:

```sh
npx github:maxbenschop/pr-trust check astral-sh/uv#23415                    # the repo's rules, or defaults
npx github:maxbenschop/pr-trust check astral-sh/uv#23415 --config my.yml    # try your own rules
npx github:maxbenschop/pr-trust backtest ghostty-org/ghostty --config my.yml --json run.json
npx github:maxbenschop/pr-trust validate my.yml --online                     # find mistakes in rules
```

From a clone, `pnpm check …`, `pnpm backtest …` and `pnpm validate …` do the same.

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

- `merged` rules use GitHub search, which does not follow renames. When a rule names a
  repository that has moved (`facebook/react` is now `react/react`), the Action looks up the
  current name, counts there, and warns you to update the rule. For a repository search cannot
  find at all, it reads the author's own merged PRs instead, up to 500 of them; if that is
  not enough to decide, the rule counts only what it read and a warning says so.
- It acts on the PR's state when the event fired. A PR edited later is not checked again
  unless it is reopened, a maintainer comments `/vouch`, or (with the `push` trigger) your
  own list changes.
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
| `src/cli/` | `check`, `backtest` and `validate`, and the `pr-trust` command that bundles them |
| `site/` | The website (static; deployed to GitHub Pages) |
| `lists/` | The trust list directory's catalog |

CI runs the tests, rebuilds `dist/` and fails if it differs from what is committed, then runs
the Action from the checkout on the PR in dry-run mode. Pushing a `vX.Y.Z` tag builds, tests,
attaches a signed build attestation for `dist/index.cjs`, creates the release and moves the
major tag (`vX`).

## License

Apache-2.0
