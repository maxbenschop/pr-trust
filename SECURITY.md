# Security

## What the Action can do

It runs with the token you give it, normally the workflow's `GITHUB_TOKEN` with
`contents: read` and `pull-requests: write`. With that it:

- reads the rules file, your trust list and an optional message file from your **default
  branch**, through the API;
- reads other public repositories' trust lists and searches their merged PRs;
- checks the PR author's permission on your repository;
- adds and removes its own labels, creates those labels if missing, posts or edits one
  comment, and closes the PR when your rules say so.

It never checks out, builds or runs code from the pull request, and sends nothing anywhere
except GitHub's API. It has no server of its own. It never pushes commits, except the one
kind described next, and only if you turn it on.

## The `/vouch` command

If your workflow also runs on `issue_comment`, a maintainer can comment `/vouch` to add an
account to your trust list. That needs `contents: write` on the token (and `issues: write`
to reply on issues). With it, the Action additionally:

- checks the commenter's permission on your repository with the collaborator permission API
  (`author_association` is never trusted for this); only `admin`, `maintain` and `write`
  may use the command, and bot accounts never can;
- looks up the account to vouch for, which must be an existing personal GitHub account;
- writes **one file**: your own trust list on the default branch (the path `own_list`
  resolves to, or a new `.github/VOUCHED.td`), through the Contents API. Each commit adds
  exactly one line, a GitHub login, which can only contain letters, digits and hyphens. It
  never removes or changes a line, so it cannot lift a denouncement;
- reacts to the command comment, posts a short reply to maintainers when it cannot do what
  they asked, and checks the pull request again as above.

The comment body is treated as hostile: only its first line is read, it must match the
command exactly, and nothing from it reaches a file, API path, reply or shell except a login
that has passed the check above. Comments from anyone without write access get no reply, so
the command cannot be used to make the bot post. Edited comments are ignored. The
`issue_comment` trigger, like `pull_request_target`, runs the workflow from your default
branch; never check out the pull request's code in that job either.

Without the `issue_comment` trigger the command does not exist, and `contents: read` is
enough.

## Design choices that matter for safety

- **Rules come from the default branch**, so a PR cannot change the policy that judges it.
- **The author is the account that opened the PR**, not the commit author.
- **Errors never close a PR.** They add a "check failed" label instead.
- **Other projects' denouncements are ignored**; only your own list can denounce.
- **Trust is one step deep**: a list you import admits only the people it vouched for.
- **Its comment is found by a marker plus a bot author**, so a person cannot get the Action
  to edit their comment by pasting the marker.
- `dist/index.cjs` is rebuilt in CI and must match the source, and releases carry a signed
  build attestation (`gh attestation verify dist/index.cjs --repo maxbenschop/pr-trust`).

## Using `pull_request_target` safely

This Action needs `pull_request_target` so it can label PRs from forks. That trigger (and
`issue_comment`) runs with a write token, so in the same job **do not check out or run the
PR's code**
(`ref: ${{ github.event.pull_request.head.sha }}` and the like). The examples in this
repository only check out the default branch, or nothing at all.

## Reporting a vulnerability

Please report it privately through GitHub's "Report a vulnerability" button on this
repository rather than in a public issue.
