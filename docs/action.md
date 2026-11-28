# Action reference

## Inputs

| Input | Default | |
|---|---|---|
| `github-token` | `${{ github.token }}` | Needs `pull-requests: write` to label, comment and close; `/vouch` also needs `contents: write` (and, on a protected default branch, permission to open pull requests) |
| `config` | `.github/trust.yml` | Rules file on the default branch |
| `dry-run` | `false` | Decide and report, change nothing |
| `pr-number` | from the event | Check another PR, for example from `workflow_dispatch` |
| `as-author` | empty | Try your rules: check the PR as if this username had opened it as an outside contributor. Labels and comments are applied unless `dry-run` is on |
| `fail-on-error` | `false` | Fail the job when the check fails (the PR stays open regardless) |
| `validate` | empty | Instead of checking a PR, check this rules file as of the workflow's commit and fail on errors ([Rules](rules.md#checking-the-rules-file-before-merging)) |

## Outputs

| Output | |
|---|---|
| `status` | `admitted`, `exempt`, `unknown`, `denounced`, `skipped` or `error`; with `validate`, `valid` or `invalid` |
| `admitted` | `"true"` for admitted, exempt or skipped |
| `reason` | One line, such as `3 merged PRs in rust-lang/rust` |
| `rule` | The rule that admitted the author |
| `command` | On a comment: `vouched`, `already-vouched`, `proposed` (a pull request adding the line is open), `refused` or `failed` for a maintainer's `/vouch`, else empty |
| `rechecked` | On a push that changed the list: the numbers of the pull requests checked again, comma-separated |

Each run also writes a short table to the job summary.

## Permissions

| Trigger | Needs |
|---|---|
| `pull_request_target` (the check) | `contents: read`, `pull-requests: write` |
| `issue_comment` ([`/vouch`](vouching.md)) | also `contents: write`, and `issues: write` to reply on issues |
| `push` to your list ([check again](vouching.md#checking-again-when-the-list-changes)) | `contents: read`, `pull-requests: write` |
| `pull_request` with [`validate`](rules.md#checking-the-rules-file-before-merging) | `contents: read` |

See [SECURITY.md](../SECURITY.md) for exactly what the Action does with its token.
