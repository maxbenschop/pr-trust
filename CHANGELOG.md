# Changelog

## Unreleased

- `/vouch` comment command (opt-in, with an `issue_comment` trigger and `contents: write`): a
  maintainer comments `/vouch` on a pull request, or `/vouch @login` anywhere, to add the
  account to the project's own Vouch list, and the pull request is checked again. New
  `command` output. See `examples/workflow-with-vouch.yml`.
- `/vouch` on a default branch that only takes pull requests (branch protection or a
  ruleset) opens a pull request with the one-line change on `pr-trust/vouch-<login>`, or
  links the one already open, instead of failing (`command` output `proposed`). Opening it
  needs "Allow GitHub Actions to create and approve pull requests"; without it, the branch
  is deleted and the reply says what to change. A refused commit is no longer retried as if
  it were a conflict, GitHub's messages are flattened to one line in replies, and the line
  to add by hand is shown in the list's own style (`github:login` where the list uses it).
- Re-checks when the trust list changes (opt-in, with a `push` trigger and a `paths:` filter
  for the list): open pull requests labelled "unknown" are checked again, at most 50 per
  push. Newly admitted ones are updated; ones still unknown are left untouched. New
  `rechecked` output.
- New default comment: a heading with the result, a note saying what happens next, and the
  project's rules as a list of ways to pass. Denounced authors get their own shorter comment.
- `{rules}` placeholder for custom messages.
- New logo; the Marketplace icon is now a check mark.
- `merged` rules now follow renamed repositories (`facebook/react` is now `react/react`) and
  warn you to update the rule. For a repository search cannot find at all, the Action counts
  the author's own merged PRs instead, reading at most 500 of them.

## 0.1.1 (2026-11-28)

- `as-author` input: check a pull request as if another account had opened it, to try out
  rules (for example from `workflow_dispatch`).
- This repository now accepts Ghostty's Vouch list and lets anyone change docs or suggest a
  trust list, and its check can be re-run by hand.
- The comment left on unknown pull requests links to a new page for contributors explaining
  the labels and how to get vouched: https://maxbenschop.github.io/pr-trust/contributors/
- New website design, with real backtest results for ten projects and the live trust list
  directory wired into the rule builder.
- `examples/strict.yml`: a "trusted only" preset that closes pull requests from unknown
  authors.

## 0.1.0 (2026-11-27)

- GitHub Action: checks PR authors against `.github/trust.yml`, labels the PR, and can
  comment and close. Supports your own Vouch list (including denouncements), other
  projects' Vouch lists, merged-PR history in this or other repositories, and exempt paths.
- Never closes a PR on an error, and respects a maintainer reopening a closed PR.
- `dry-run` mode and an `admitted` output for running alongside Vouch.
- `check` command: run the decision on any PR without changing it.
- `backtest` command: replay a year of a repository's PRs against a set of rules.
- `pr-trust` command bundle, runnable with `npx github:maxbenschop/pr-trust`.
- Website with install guide, rule builder, ready-made workflows and a directory of public
  Vouch lists: https://maxbenschop.github.io/pr-trust/
