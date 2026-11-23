# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jekojek/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jekojek/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it reads a patch in unified diff, SEARCH/REPLACE, V4A or JSON form, matches lines at three tiers of whitespace tolerance, and applies every edit atomically — all changes or none — to a tree of text files. Node 22, standard library only; `SPEC.md` is the full contract.

## Run it

```sh
node main.ts fix.patch
```

`node main.ts [options] [PATCH]` — the patch is a file, or `-`/absent for stdin. `--format=` picks `unified`, `search-replace`, `v4a` or `json` (default `auto` detects it); `--check` dry-runs without writing; `--strict` matches exact lines only. Exit 0 lists what changed, exit 1 lists the edits that failed (nothing written), exit 2 is a usage, missing-patch, format or parse error. See `SPEC.md` for every rule.

## The files

- `main.ts`: the CLI.
- `runner.ts`: the trial harness hand-over — keep as is; in a trial it runs `main.ts` on each check.
- `check.ts`: run the practice set locally with `node check.ts ../program/generator/practice.json`.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=xesesfrd&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
