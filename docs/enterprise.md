# GitHub Enterprise

pr-trust runs on GitHub Enterprise Server and on GitHub Enterprise Cloud with data residency
(`*.ghe.com`). It talks to the server the workflow runs on and to nothing else; there is no
setting to change in the Action.

It has not been run against a live Enterprise Server yet. The addresses it uses are covered
by tests; if something behaves differently on your server, please
[open an issue](https://github.com/maxbenschop/pr-trust/issues) with the server version.

## The Action

GitHub sets `GITHUB_API_URL`, `GITHUB_GRAPHQL_URL` and `GITHUB_SERVER_URL` on every runner.
The Action reads them, so the API calls go to your server and the links in its comment point
there. The run log says `Using the GitHub server at https://github.example.com`.

Your server has to be able to fetch the Action itself. Either:

- turn on [GitHub Connect](https://docs.github.com/en/enterprise-server@latest/admin/managing-github-actions-for-your-enterprise/managing-access-to-actions-from-githubcom/enabling-automatic-access-to-githubcom-actions-using-github-connect),
  and `uses: maxbenschop/pr-trust@<commit>` works as on github.com; or
- copy the repository to your server with
  [`actions-sync`](https://github.com/actions/actions-sync), and use the copy's name:

  ```yaml
  - uses: your-org/pr-trust@<commit>
  ```

The workflow file is otherwise the same as in [Getting started](getting-started.md).

## The command line

Set `GH_HOST`, the variable the GitHub CLI uses:

```sh
GH_HOST=github.example.com npx github:maxbenschop/pr-trust check your-org/your-repo#12
GH_HOST=github.example.com npx github:maxbenschop/pr-trust backtest your-org/your-repo
```

The token is the first of these that is set: `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`,
`GITHUB_TOKEN`, `GH_TOKEN`, then your `gh auth login --hostname github.example.com` session.

| Variable | Use |
|---|---|
| `GH_HOST` | Your server's host name. Enough on its own. |
| `GITHUB_API_URL` | The REST address, if it is not `https://HOST/api/v3`. Overrides `GH_HOST`. |
| `GITHUB_GRAPHQL_URL` | The GraphQL address, if it is not `https://HOST/api/graphql`. |
| `GITHUB_SERVER_URL` | The website address, for links. |

Cached responses from your server are kept apart from github.com's.

## What is different

- **Rules only see your server.** `list: owner/repo`, `merged: { repo: owner/repo }`,
  `merged: { repo: any }` and `org_member` are all looked up on the server the Action runs
  on. A rule that names a github.com project, such as `list: ghostty-org/ghostty`, finds
  nothing unless that repository exists on your server. To use a public Vouch list, copy its
  `VOUCHED.td` into a repository on your server and point `list:` at that. The logins in it
  must be the logins people have on your server.
- **`merged: { repo: any }`** counts merges into public repositories on your server that the
  author does not own. On a server where most repositories are internal or private, few
  people will have any.
- **`backtest --suggest`** leaves out the trust list directory, which lists github.com
  repositories.
- **The comment's footer** links to this website for contributors. On a network without
  internet access, set your own text with [`message_file`](rules.md#rules-reference); the
  footer line stays.
- **Server version.** The Action sends the `2022-11-28` REST API version header, which
  Enterprise Server understands from version 3.9.
