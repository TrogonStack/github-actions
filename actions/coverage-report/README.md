# Coverage report

Report Cobertura coverage, compare exact source revisions with pycobertura
`3.0.0`, and enforce integer coverage gates. Derived from
[insightsengineering/coverage-action](https://github.com/insightsengineering/coverage-action/tree/3179498004cf3a28cbd5b496ce580767888375b9).
The upstream MIT notice and local attribution are retained in [LICENSE](LICENSE).

## Use the action

Pin `TrogonStack/github-actions/actions/coverage-report` to the full reviewed
commit SHA. Check out the measured commit and generate a Cobertura XML report
before invoking it. Python 3.11 and pycobertura are installed by the action.
Git and Bash are required; shell steps only invoke Python entry points.

Set `threshold` to the required percentage, `fail` and `diff` to `true`, and
enable `uncovered-statements-increase-failure`,
`new-uncovered-statements-failure`, and `coverage-rate-reduction-failure` for
strict enforcement. Integrity and comparison errors always fail closed;
`pycobertura-exception-failure` remains a deprecated compatibility input and
cannot waive these failures. A missing baseline is an error, including when
`diff-branch` names an unused branch.

[Action metadata](action.yml) describes the inputs. `diff-branch` selects the
baseline branch; `diff-storage` selects the report storage branch.
`storage-subdirectory` separates report namespaces. Storage checkout and local
`coverage-action` staging paths must be absent before invocation; use a fresh
workspace for each invocation. `summary` contains the
report body even with `publish: false`. `skip-diff-storage: true` is explicitly
report-only: it disables storage and baseline gates, not threshold enforcement.

Storage publication requires `contents: write`; comment publication requires
`pull-requests: write`. Use trusted workflow code, a pinned action, and protected
storage refs. Never expose a write token to untrusted fork code or use a
privileged `pull_request_target` job to execute a fork's code. Ordinary fork PR
tokens generally cannot publish storage. The action does not acquire additional
credentials for forks.

## Source trust and publication format

A version 2 `sources.json` contains only the expected repository identity,
immutable commit SHA, repository-relative file paths, SHA256 and Git blob
identities, and canonical XML checksum. It contains no source text, machine
roots, remote URLs, credentials, or producer metadata. The paired `coverage.xml`
retains every measured class line, hit count, branch indicator and condition,
plus numeric coverage totals and rates. Source-method names, timestamps,
producer labels and absolute source roots are omitted. No lines or files are
excluded to meet a gate.

The workflow event is the repository allowlist. Capture requires the checkout
HEAD to equal the event SHA or explicit PR head SHA. An event merge commit
belongs to the base repository; a fork head commit belongs to its head
repository. Fork storage uses `.forks/<head-repository-id>/<pr-number>` and
cannot replace the official branch namespace. Baselines always require the
base repository identity.

Sources are read as Git blobs, never checked out or executed. Local objects can
be used only when the requested commit is an ancestor of an immutable event
anchor for the expected repository. Otherwise an isolated bare repository
fetches the exact SHA from `https://github.com/<expected-repository>.git`.
The manifest cannot choose a host, URL, ref, directory, or credential. Fetches
are anonymous HTTPS, disallow redirects and other transport protocols, disable
hooks and inherited Git/credential configuration, and have a 120-second timeout.
Local object reads disable lazy promisor fetches. Partial-clone object stores
are refused before reading sources instead of implicitly using checkout
credentials to contact a configured remote.
Each source SHA256, blob identity, regular-file mode and line range is verified
before pycobertura receives temporary files. Temporary repositories and sources
are deleted when comparison finishes, including on failure.

A shallow checkout might not contain a historical baseline or an ancestor proof.
An exact-SHA fetch must then succeed. Unavailable or unadvertised commits fail
closed; a moving branch is never substituted. Ephemeral PR merge commits may
become unavailable after the PR changes. Use retained public commit history or
an event-anchored checkout with the required history. This release's remote
retrieval supports public GitHub repositories only. Private repositories work
only when all required objects and event ancestry proofs are present locally;
there is no private-source token fallback or configurable enterprise host.

The manifest proves source/report binding, not that a coverage producer executed
tests honestly. Trusted execution receipts, workflow protections and storage
write authorization remain necessary. Repository administrators supply migration
provenance; a checksum or syntactically valid commit alone is not that provenance.

`source-root` can resolve relative report filenames explicitly. Otherwise the
report directory, workspace and XML source directories must identify a unique
file inside the repository. Modified, missing, untracked or symbolic-link source
files and out-of-range lines are refused. Generated source must be tracked when
measured. Input XML is limited to 128 MiB, source files to 16 MiB, and class
entries to 20,000. Unsupported XML entities or branch condition formats fail
rather than being silently omitted.

## Migrate an already verified baseline

Migration is an offline administrator operation, separate from ordinary action
execution. Obtain the exact measured XML, its previously verified source
snapshot, the independently verified full commit SHA and repository identity,
and a trusted local Git object database containing that commit. Preserve the
original execution and verification receipts. XML alone is insufficient.

```sh
python3 /path/to/action/report.py migrate \
  --report "$VERIFIED_XML" \
  --legacy "$VERIFIED_LEGACY_SNAPSHOT" \
  --repository "$EXPECTED_REPOSITORY" \
  --commit "$VERIFIED_COMMIT_SHA" \
  --object-directory "$TRUSTED_CHECKOUT" \
  --output "$STAGING_DIRECTORY/sources.json"
```

The command verifies the old XML checksum, file set, source contents and hashes
against every immutable Git blob, then writes only canonical `coverage.xml` and
the content-free version 2 manifest. It neither changes refs nor publishes.
It refuses forged legacy source text even if its checksum was recomputed.
Verify per-file coverage and gate equality, audit the staged pair, and have the
trusted storage maintainer publish both files atomically to the intended
baseline namespace using the bounded publisher. Never publish the legacy
snapshot. Do not seed by selecting an unused baseline, tolerating an exception,
or guessing a source version from a moving branch.

## Gate semantics and concurrent storage

Threshold and rate gates use exact integer statement/miss ratios. Rounded
percentages are display-only. Zero measured statements means 0%, matching
pycobertura's fallback. Threshold zero passes; positive thresholds fail.

Status 2 means a file has more missed statements and is controlled by
`uncovered-statements-increase-failure`. Status 3 means changed source introduces
uncovered statements without an increased file miss count and is controlled by
`new-uncovered-statements-failure`. Enable both for strict enforcement. The rate
gate is independent. Source-aware comparison always uses real verified source
versions, never `--no-source` or placeholder files.

Gates precede badge/report publication. The publisher uses atomic, non-force
pushes with bounded retries, fetching and replaying local commits over the
current storage tip. Disjoint reports survive concurrent publication; conflicts
fail without replacing the winning report. Storage initialization writes raw
blobs without executing checkout filters or stored source. All orchestration,
capture, summary, storage and gate logic lives in Python files resolved through
`github.action_path`; YAML contains wiring and external actions.

Run the regressions with `mise run github:actions:tests:coverage` from the shared
repository root. Tests use disposable local Git repositories and real pinned
pycobertura for source changes, exact gates, migration, integrity failures,
fork isolation and concurrent publication.
