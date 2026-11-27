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

It never checks out, builds or runs code from the pull request, never pushes commits, and
sends nothing anywhere except GitHub's API. It has no server of its own.

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

This Action needs `pull_request_target` so it can label PRs from forks. That trigger runs
with a write token, so in the same job **do not check out or run the PR's code**
(`ref: ${{ github.event.pull_request.head.sha }}` and the like). The examples in this
repository only check out the default branch, or nothing at all.

## Reporting a vulnerability

Please report it privately through GitHub's "Report a vulnerability" button on this
repository rather than in a public issue.
