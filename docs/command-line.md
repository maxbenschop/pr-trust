# Command line

Three tools come with the Action. None of them changes anything on GitHub.

- **`check`** runs the Action's decision on one pull request.
- **`backtest`** replays a year of a repository's pull requests against your rules.
- **`validate`** finds mistakes in a rules file. It is described under
  [Rules](rules.md#checking-the-rules-file-before-merging).

## Running them

They need Node 22.18 or later. `check`, `backtest` and `validate --online` also need a GitHub
token (`GITHUB_TOKEN`, `GH_TOKEN`, or a `gh auth login` session); only read access is used.
Run them without installing:

```sh
npx github:maxbenschop/pr-trust check astral-sh/uv#23415                    # the repo's rules, or defaults
npx github:maxbenschop/pr-trust check astral-sh/uv#23415 --config my.yml    # try your own rules
npx github:maxbenschop/pr-trust backtest ghostty-org/ghostty --config my.yml --json run.json
npx github:maxbenschop/pr-trust validate my.yml --online                     # find mistakes in rules
```

From a clone, `pnpm check …`, `pnpm backtest …` and `pnpm validate …` do the same.

## Reading a backtest

Each outside PR is judged as of the moment it was opened: the trust lists as they stood
that day, and merges before it. The report then compares the verdicts with what really
happened (merged; rejected by a maintainer; withdrawn by its author; closed by a bot; open).

- **Keeps**: the share of merged outside PRs the rules would have let through. The rest is
  good work they would have turned away.
- **Stops**: the share of PRs maintainers rejected that the rules would have blocked, which is
  review time saved.
- **Merge rates** for PRs let through and PRs blocked. If they are close, the rules are not
  telling good contributions from bad.
- **Cost**: merged PRs that would have been blocked, the contributors most affected, and how
  many newcomers blocked on their first PR still went on to get one merged.

`backtest` options: `--config`, `--until <YYYY-MM-DD>`, `--days <n>` (default 365),
`--json <file>`, `--suggest`, `--suggest-authors <n>`, `--refresh`, `--quiet`. GitHub responses are cached in `.cache/`, so
reruns with other rules are fast.

## Finding a rule that would have helped

Add `--suggest` and the backtest tries extra rules on the PRs your rules left unknown:
merged work anywhere on GitHub (1, 3 or 10 PRs), every list in the trust list directory, and
a 30-day account-age floor where it helps. Each is judged as of the day the PR was opened.

```
rule added                                               +merged  +rejected  keeps  stops
(current rules)                                                                 8%   100%
≥10 merged PRs in others' public repos within 24 months       +6         +3    58%    70%
≥1 merged PR in others' public repos within 24 months         +8         +6    75%    40%
```

`+merged` is good work the extra rule would have let through; `+rejected` is what it costs:
PRs your maintainers turned down that it would also have let through. The best one or two are
printed as YAML to copy. GitHub search allows about 30 requests a minute, so this looks up
at most `--suggest-authors` authors (default shown in `--help`) and says so when it stops
short. (Sample: astral-sh/uv, 45 days, November 2026.)

The backtest has [limits of its own](limitations.md#the-backtest).
