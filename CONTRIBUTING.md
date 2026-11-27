# Contributing

Thanks for helping. This project gates pull requests by contributor trust, and it uses that
gate on itself, so read the first section before you open one.

## Before you open a pull request

1. **Open an issue first** for anything bigger than a typo, and say what you want to change
   and why. A short agreement up front saves both of us a wasted review.
2. **Get vouched if you are new here.** This repository runs its own Action in label-only
   mode: PRs from people it does not know yet get a `trust: unknown` label and are reviewed
   later. To be added to [`.github/VOUCHED.td`](.github/VOUCHED.td), introduce yourself in an
   issue or a discussion. After your first merged PR you are admitted automatically.
3. **One change per pull request.** Small PRs get reviewed quickly; large mixed ones stall.

## AI-assisted contributions

Using AI tools is fine. You are responsible for every line you submit:

- you have read and understood the change, and can explain it in review;
- you have run the tests yourself;
- say in the PR description if a tool wrote a substantial part of it.

PRs that look generated and unreviewed, such as ones that don't match the issue, invent APIs
or fail the tests, are closed without a detailed review.

## Development

Requires Node 22.18+ and pnpm.

```sh
pnpm install
pnpm test          # unit tests, no network
pnpm typecheck
pnpm build         # rebuild dist/index.cjs
```

- **Commit `dist/`.** The Action runs from `dist/index.cjs`. If you change anything under
  `src/`, run `pnpm build` and commit the result; CI fails when it is out of date.
- **Add tests** for behaviour changes. Rule logic lives in `src/engine/` and needs no network
  to test; Action behaviour is tested against a fake GitHub in `test/action.test.ts`.
- **Try it on real PRs** without changing anything: `pnpm check owner/repo#123`.
- **Keep the safety rules** in [SECURITY.md](SECURITY.md): rules come from the default
  branch, errors never close a PR, and the PR's code is never run.

## Suggesting a trust list for the website

The website lists Vouch lists that projects publish, so maintainers can choose ones to trust.
To add one, open a [trust list issue](../../issues/new?template=trust_list.yml) or edit
[`lists/catalog.json`](lists/catalog.json) directly. A list qualifies when:

- the project maintains it itself and it is public;
- the project describes how people get vouched;
- the project is active.

The catalog is a directory, not an endorsement. Maintainers should still decide for
themselves whose judgement they trust.

## Pull request checklist

- [ ] Linked to an issue (unless trivial)
- [ ] `pnpm test` and `pnpm typecheck` pass
- [ ] `dist/` rebuilt if `src/` changed
- [ ] README or website updated if behaviour or configuration changed

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
