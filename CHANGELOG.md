# Changelog

## Unreleased

- New default comment: a heading with the result, a note saying what happens next, and the
  project's rules as a list of ways to pass. Denounced authors get their own shorter comment.
- `{rules}` placeholder for custom messages.
- New logo; the Marketplace icon is now a check mark.

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
