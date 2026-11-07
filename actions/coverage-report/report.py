"""Exact coverage gates and verified source-aware comparison."""

import argparse
from dataclasses import dataclass
from fractions import Fraction
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from xml.etree import ElementTree as ET

from diagnostics import CoverageError, Reason, boolean, diagnostic
from sources import capture, materialize, context_identity, migrate


@dataclass(frozen=True)
class CoverageCounts:
    statements: int
    misses: int

    @classmethod
    def read(cls, report):
        """Use integer totals, never the display percentage, for enforcement."""
        totals = [line.split() for line in Path(report).read_text().splitlines() if line.startswith('TOTAL ')]
        if len(totals) != 1:
            raise ValueError('Expected one coverage TOTAL row')
        statements, misses = map(int, totals[0][1:3])
        if not 0 <= misses <= statements:
            raise ValueError('Invalid coverage counts')
        return cls(statements, misses)

    @property
    def percent(self):
        return Fraction(100 * (self.statements - self.misses), self.statements) if self.statements else Fraction(0)


def diff(baseline, current, current_sources, output, provider=None):
    with tempfile.TemporaryDirectory(prefix='coverage-source-') as temporary:
        root = Path(temporary)
        options = {} if provider is None else {'provider': provider}
        materialize(baseline, Path(baseline).with_name('sources.json'), root / 'baseline', os.environ['GITHUB_REPOSITORY'], **options)
        current_manifest = json.loads(Path(current_sources).read_text())
        expected = context_identity(current_manifest['commit'])
        materialize(current, current_sources, root / 'current', expected, **options)
        return subprocess.run(['pycobertura', 'diff', '--no-color', '--source', '--source1', str(root / 'baseline/source'), '--source2', str(root / 'current/source'), str(root / 'baseline/coverage.xml'), str(root / 'current/coverage.xml'), '--output', str(output)], capture_output=True, timeout=120).returncode


def gate():
    """Integrity failures cannot be waived by coverage policy toggles."""
    status = os.environ.get('COVERAGE_ENV_PYCOBERTURA_STATUS', '')
    if status not in ('0', '2', '3') or os.environ.get('COVERAGE_CAPTURE_STATUS') != '0':
        raise CoverageError(Reason.COMPARISON_REQUIRED)
    if os.environ.get('COVERAGE_BASELINE_STATUS', '') not in ('', '0'):
        raise CoverageError(Reason.BASELINE_COUNTS)
    policies = {'2': 'UNCOVERED_STATEMENTS_INCREASE_FAILURE', '3': 'NEW_UNCOVERED_STATEMENTS_FAILURE'}
    enabled = {name: boolean(os.environ['COVERAGE_INPUTS_' + name]) for name in (*policies.values(), 'COVERAGE_RATE_REDUCTION_FAILURE', 'PYCOBERTURA_EXCEPTION_FAILURE')}
    if status in policies and enabled[policies[status]]:
        raise CoverageError(Reason.MISSES_INCREASED if status == '2' else Reason.NEW_UNCOVERED)
    baseline = Path('.coverage-output.diff-branch')
    if enabled['COVERAGE_RATE_REDUCTION_FAILURE']:
        current = CoverageCounts.read('.coverage-output').percent
        previous = CoverageCounts.read(baseline).percent
        if current < previous:
            raise CoverageError(Reason.RATE_DECREASED)


def main():
    """Return exceptions separately from pycobertura policy statuses 2 and 3."""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    snapshot = commands.add_parser('capture')
    snapshot.add_argument('--report', required=True)
    snapshot.add_argument('--output', required=True)
    snapshot.add_argument('--source-root', required=True)
    comparison = commands.add_parser('diff')
    comparison.add_argument('--baseline', required=True)
    comparison.add_argument('--current', required=True)
    comparison.add_argument('--current-sources', required=True)
    comparison.add_argument('--output', required=True)
    migration = commands.add_parser('migrate')
    for name in ('report', 'legacy', 'output', 'repository', 'commit', 'object-directory'):
        migration.add_argument('--' + name, required=True)
    percent = commands.add_parser('percent')
    percent.add_argument('report')
    commands.add_parser('threshold')
    commands.add_parser('gate')
    args = parser.parse_args()
    try:
        if args.command == 'capture':
            capture(args.report, args.output, args.source_root)
        elif args.command == 'migrate':
            migrate(args.report, args.legacy, args.output, args.repository, args.commit, args.object_directory)
        elif args.command == 'diff':
            return diff(args.baseline, args.current, args.current_sources, args.output)
        elif args.command == 'percent':
            print(f'{float(CoverageCounts.read(args.report).percent):.8f}')
        elif args.command == 'threshold':
            threshold = Fraction(os.environ['COVERAGE_INPUTS_THRESHOLD'])
            if CoverageCounts.read('.coverage-output').percent < threshold:
                raise CoverageError(Reason.THRESHOLD)
        elif args.command == 'gate':
            gate()
    except (ValueError, OSError, KeyError, TypeError, ET.ParseError, subprocess.SubprocessError, UnicodeError) as error:
        diagnostic(error)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
