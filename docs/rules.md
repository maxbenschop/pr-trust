# Rules

The rules live in `.github/trust.yml` on your default branch. A pull request cannot change
the rules that judge it.

## Rules reference

All keys are optional. See [`examples/trust.yml`](../examples/trust.yml) for a commented example.

| Key | Default | Meaning |
|---|---|---|
| `own_list` | `auto` | Your Vouch list: `auto` (`.github/VOUCHED.td`, then `VOUCHED.td`), a path, or `none`. The only list whose denouncements count. |
| `admit` | none | Rules, checked in order (below). |
| `min_account_age` | off | A period such as `30d`. When set, `admit` rules do not admit an account younger than this when the PR was opened; the PR is then `unknown`, with the account's age as the reason. Your own list and denouncements are unaffected. It only holds people back, never admits anyone: a guard against new accounts collecting cheap merges to pass `merged` rules. |
| `exempt_paths` | none | Glob patterns. A PR that changes only matching files skips the check. |
| `on_unknown` | `label` | `label` or `close`. |
| `on_denounced` | `close` | `label` or `close`. |
| `comment` | `unknown` | Comment on PRs from unadmitted authors (`unknown`), or only when closing (`never`). |
| `message_file` | built-in | Markdown file on your default branch with the comment text. Placeholders: `{author}`, `{reason}`, `{repo}`, `{next}`, `{rules}` (your rules as a list). See [`examples/trust-message.md`](../examples/trust-message.md). |
| `labels` | `trust: admitted`, `trust: unknown`, `trust: denounced`, `trust: check failed` | Label names for `admitted`, `unknown`, `denounced` and `error`; `""` turns one off. |

`admit` rules:

| Rule | Admits the author when |
|---|---|
| `list: owner/repo` | they are vouched in that repository's Vouch list (its denouncements are ignored) |
| `list: owner/repo:path/VOUCHED.td` | the same, for a list stored elsewhere |
| `merged: { repo: owner/repo, min: 3, within: 24mo }` | they have at least `min` merged PRs in that repository within the period (`d`, `w`, `mo`, `y`; default 24mo) |
| `merged: { repo: self, ... }` | the same, in this repository |
| `merged: { repo: any, min: 3, within: 24mo }` | they have at least `min` PRs merged within the period into public repositories they do not own, each merged by someone other than them |
| `org_member: some-org` | they are a public member of that GitHub organisation |

`repo: any` is for newcomers who are not new to open source. A merge counts only when it is
in a public repository outside the author's own account (search's `-user:`) and someone else
merged it, which leaves out PRs merged into an organisation the author runs by themselves.
A second account, or a friend with merge rights, can still get round it, so pair it with
`min_account_age` and a `min` above 1. There is no star or size floor for the target
repository: GitHub search cannot filter pull requests by their repository's stars, and
reading each repository would cost a request per PR. `org_member` sees only public
membership; members choose that on the organisation's People page.

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
([full example](../examples/validate-rules.yml)):

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
      - uses: maxbenschop/pr-trust@cc7858b8951781f7f304c6d1f4b47cc964c18f2c # v0.1.2
        with:
          validate: .github/trust.yml
```

Keep it on `pull_request`, separate from the contributor check: the file comes from the pull
request, so it should only ever be read with the read-only token a fork's pull request gets
there, never with `pull_request_target`'s write token (the Action refuses that). The Action
reads the file through the API and only parses it; nothing is checked out or run. Errors
fail the job and appear as annotations on the file; warnings only annotate.
