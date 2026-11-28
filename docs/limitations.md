# Limitations

## The Action

- `merged` rules use GitHub search, which does not follow renames. When a rule names a
  repository that has moved (`facebook/react` is now `react/react`), the Action looks up the
  current name, counts there, and warns you to update the rule. For a repository search cannot
  find at all, it reads the author's own merged PRs instead, up to 500 of them; if that is
  not enough to decide, the rule counts only what it read and a warning says so.
- It acts on the PR's state when the event fired. A PR edited later is not checked again
  unless it is reopened, a maintainer comments `/vouch`, or (with the `push` trigger) your
  own list changes.
- `merged: { repo: any }` reads at most 300 search results per check; an author with many
  merges they made themselves may count short of `min`, with a warning. A failed search,
  membership check or account lookup is a rule that does not match, plus a warning (with
  `min_account_age`, an account whose age cannot be read is treated as too new).
- It needs `pull_request_target`. With `pull_request`, PRs from forks get a read-only token,
  so labelling fails and the check reports an error.

## The backtest

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
- **`org_member` uses today's membership.** GitHub keeps no history of organisation
  membership, so each author's public membership today is used for all their PRs: someone
  who joined after opening a PR counts as a member when they opened it, and someone who has
  left or hidden their membership since does not.
- **`merged: { repo: any }` uses search as it is today.** Merge dates are exact, but merges
  into repositories since deleted or made private are missed, and repository owners are
  today's. It costs at least one search per external author.
- `min_account_age` is replayed exactly: account creation dates do not change.

## GitHub Enterprise

Rules only see the GitHub server the Action runs on. See
[GitHub Enterprise](enterprise.md#what-is-different).
