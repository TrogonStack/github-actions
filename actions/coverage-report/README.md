# Coverage report

A composite action that reports Cobertura coverage, compares it with a stored
branch baseline, and enforces coverage gates. Derived from
[insightsengineering/coverage-action at `3179498004cf3a28cbd5b496ce580767888375b9`](https://github.com/insightsengineering/coverage-action/tree/3179498004cf3a28cbd5b496ce580767888375b9).
The upstream MIT notice is retained in [LICENSE](LICENSE).

## Usage

Pin `TrogonStack/github-actions/actions/coverage-report` to the full commit SHA
of the reviewed shared revision. Check out the consumer repository and generate
a Cobertura XML report before invoking the action.

The action requires Python 3.11 (installed by the action), Git, Bash and `bc`.
It pins pycobertura to `3.0.0`. Storage publication requires `contents: write`;
PR comments require `pull-requests: write`. Fork PR tokens generally cannot
write to the base repository.

## Inputs and output

[The action metadata](action.yml) defines all inputs and defaults. To enforce a
strict coverage policy, set `threshold` to the required percentage, `fail` and
`diff` to `true`, and enable `uncovered-statements-increase-failure`,
`new-uncovered-statements-failure`, and `coverage-rate-reduction-failure`.
`pycobertura-exception-failure` defaults to `true`.

`diff-branch` selects the baseline branch (default `main`); `diff-storage`
selects its storage branch (default `_xml_coverage_reports`).
`storage-subdirectory` separates report namespaces. With `publish: true`, the
`summary` output contains the PR comment body.

`skip-diff-storage: true` disables storage access and baseline comparison. It
is suitable for report-only operation, not enforcement of baseline gates.
Missing baseline reports retain the upstream behavior of skipping the diff.

## Concurrent publication

The publisher retries rejected pushes after fetching and replaying local
commits over the current storage tip, with a bounded attempt budget. Disjoint
reports survive concurrent publication. Conflicting edits fail without force
pushing or replacing the winning report. Publication errors fail the action.

The publisher is resolved through `github.action_path`, independently of the
consumer checkout. Its regressions run with
`mise run github:actions:tests:coverage` from the shared repository root.
