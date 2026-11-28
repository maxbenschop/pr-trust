# Vouching

A maintainer can admit an author without leaving the pull request, and pull requests
labelled "unknown" can be checked again when your list changes. Both are opt-in.

## Vouching from a pull request

Optionally, a maintainer can admit an author without leaving the pull request by
commenting `/vouch`. The command only exists if your workflow also runs on new comments
([full example](../examples/workflow-with-vouch.yml)):

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
      - uses: maxbenschop/pr-trust@7ba270aa66f83cf1a9c882e85d090c5e8fa8aa74 # v0.1.3
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
