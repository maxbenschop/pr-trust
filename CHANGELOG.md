# Changelog

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
