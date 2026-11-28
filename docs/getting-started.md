# Getting started

pr-trust is a GitHub Action that checks who opened a pull request against rules you write.
It labels the pull request, and can comment on it and close it. Setting it up takes two
files on your default branch.

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

   `backtest` is one of the [command-line tools](command-line.md); it changes nothing.

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

## Trust lists

The [website](https://maxbenschop.github.io/pr-trust/#lists) has a directory of public Vouch
lists you can trust with `list:` rules, built from [`lists/catalog.json`](../lists/catalog.json)
and refreshed weekly. To suggest one, see [CONTRIBUTING.md](../CONTRIBUTING.md#suggesting-a-trust-list-for-the-website).

## Using it with Vouch

Keep your Vouch setup and let this Action admit people your list does not know yet.
Run it in dry-run mode so Vouch keeps doing the labelling and closing, and skip Vouch's
check for anyone it admits ([full example](../examples/with-vouch.yml)):

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

## Next

- [Rules](rules.md): every key in `.github/trust.yml`, and how to check the file.
- [Vouching](vouching.md): admit someone with a `/vouch` comment.
- [Action reference](action.md): inputs and outputs.
- [Command line](command-line.md): `check`, `backtest` and `validate`.
- [GitHub Enterprise](enterprise.md): running on your own GitHub server.
- [Limitations](limitations.md): what it cannot see.
