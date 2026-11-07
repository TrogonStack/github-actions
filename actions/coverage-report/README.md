# Coverage report

A composite action that reports Cobertura coverage, compares it with a stored
branch baseline, and enforces coverage gates. Derived from
[insightsengineering/coverage-action at `3179498004cf3a28cbd5b496ce580767888375b9`](https://github.com/insightsengineering/coverage-action/tree/3179498004cf3a28cbd5b496ce580767888375b9).
The upstream MIT notice is retained in [LICENSE](LICENSE).

## Usage

Pin `TrogonStack/github-actions/actions/coverage-report` to the full commit SHA
of the reviewed shared revision. Check out the consumer repository and generate
a Cobertura XML report before invoking the action.

The action requires Python 3.11 (installed by the action), Git and Bash.
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
`storage-subdirectory` separates report namespaces. The `summary` output contains the report body even when `publish: false`.
Only comment publication requires `publish: true`.

`skip-diff-storage: true` disables storage access and baseline comparison. It
is suitable for report-only operation, not enforcement of baseline gates.
Missing baseline reports retain the upstream behavior of skipping the diff.

## Source comparison and baseline migration

The action captures the actual checked-out source files with the report. Each
`sources.json` snapshot binds the XML checksum, source contents and checksums,
repository identity, and checked-out commit. The XML and snapshot are committed
together. Comparisons use those stored contents, so shallow checkouts and later
branch movement do not change the baseline's source version. Capture refuses
missing, modified, untracked, or symbolic-link source files and out-of-range
coverage lines. Generate the report from the checked-out commit before invoking
the action; generated source must be tracked if it is included in coverage.

`source-root` can explicitly resolve relative Cobertura filenames. By default,
the action uses XML source directories, the report directory, and the workspace,
requiring an unambiguous existing file. Set `source-root` to a language
subdirectory if these locations would otherwise be ambiguous. Absolute filenames must resolve inside the
consumer repository. Snapshot paths are normalized to repository-relative paths
for comparison across runner workspaces.

An existing XML-only baseline cannot prove which source produced its coverage.
It produces a comparison exception, not a successful source comparison.
To migrate, regenerate coverage on the trusted baseline branch with this action.
For that initial seed run, set `diff: true` and `diff-branch` to a deliberately
unused baseline name so the documented missing-baseline behavior applies. Then
restore `diff-branch` to the real baseline branch for ordinary comparisons.
Do not reconstruct old source from a moving branch or disable strict gates on PRs.

`pycobertura-exception-failure: false` explicitly tolerates comparison or capture
errors. Failed capture leaves the stored XML/source pair intact. Rate comparison still runs independently when valid counts exist.
Missing source snapshots never become fabricated status-0 comparisons. Fork PR
reports use a reserved `.forks/<head-repository-id>/<pr-number>` namespace; they
cannot replace a same-named official branch baseline.

## Coverage gates

Threshold and rate gates compare exact integer statement/miss counts. Rounded
percentages are display-only. A report with zero measured statements is 0%,
consistent with pycobertura's empty-count fallback; it passes threshold zero and
fails a positive threshold. The same rule applies to baseline rate comparisons.

Status 2 means at least one file has more missed statements and is controlled by
`uncovered-statements-increase-failure`. Status 3 means source changes introduce
uncovered statements without any file's missed count increasing, including when
counts stay unchanged; it is controlled by `new-uncovered-statements-failure`.
Enable both to reject both kinds of regressions. The rate gate is independent.

## Concurrent publication

The publisher retries rejected pushes after fetching and replaying local
commits over the current storage tip, with a bounded attempt budget. Disjoint
reports survive concurrent publication. Conflicting edits fail without force
pushing or replacing the winning report. Publication errors fail the action.

The publisher is resolved through `github.action_path`, independently of the
consumer checkout. Its regressions run with
`mise run github:actions:tests:coverage` from the shared repository root.
