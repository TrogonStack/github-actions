"""Exact coverage gates and report-bound source snapshots."""

import argparse
from dataclasses import dataclass
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
from xml.etree import ElementTree as ET


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


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE)


def capture(report, output, source_root):
    """Bind measured files and the XML to the actual checked-out Git revision."""
    report = Path(report).resolve()
    root = Path(source_root).resolve()
    repo = Path(git(root, 'rev-parse', '--show-toplevel').decode().strip()).resolve()
    commit = git(repo, 'rev-parse', 'HEAD').decode().strip()
    xml = report.read_bytes()
    tree = ET.fromstring(xml)
    roots = [root] if source_root else [repo, report.parent, *(Path(node.text) for node in tree.findall('./sources/source') if node.text)]
    sources = {}
    for node in tree.findall('.//class'):
        filename = node.attrib['filename']
        candidates = {base / filename for base in roots if (base / filename).is_file()}
        if any(path.is_symlink() for path in candidates):
            raise ValueError('Symbolic-link coverage sources are not supported')
        candidates = {path.resolve() for path in candidates}
        if len(candidates) != 1:
            raise ValueError('Missing or ambiguous coverage source; set source-root explicitly')
        path = candidates.pop()
        relative = path.relative_to(repo).as_posix()
        data = path.read_bytes()
        if data != git(repo, 'show', f'{commit}:{relative}'):
            raise ValueError('Coverage source differs from the checked-out commit')
        if path.is_symlink() or git(repo, 'ls-tree', commit, '--', relative).startswith(b'120000'):
            raise ValueError('Symbolic-link coverage sources are not supported')
        text = data.decode('utf-8')
        if any(int(line.attrib['number']) < 1 or int(line.attrib['number']) > len(text.splitlines()) for line in node.findall('./lines/line')):
            raise ValueError('Coverage line is outside its source file')
        sources[filename] = {'path': relative, 'sha256': digest(data), 'text': text}
    snapshot = {'version': 1, 'commit': commit, 'repository': os.environ.get('COVERAGE_SOURCE_REPOSITORY') or os.environ['GITHUB_REPOSITORY'], 'report_sha256': digest(xml), 'sources': sources}
    Path(output).write_text(json.dumps(snapshot, sort_keys=True) + '\n')


def materialize(report, snapshot, destination, repository):
    """Validate a stored report/source pair before exposing it to pycobertura."""
    xml = Path(report).read_bytes()
    data = json.loads(Path(snapshot).read_text())
    if data['version'] != 1 or data['report_sha256'] != digest(xml):
        raise ValueError('Source snapshot does not match the coverage report')
    if not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', data['commit']):
        raise ValueError('Source snapshot has no immutable commit identity')
    if data['repository'].lower() != repository.lower():
        raise ValueError('Source snapshot belongs to another repository')
    tree = ET.fromstring(xml)
    names = {node.attrib['filename'] for node in tree.findall('.//class')}
    if names != set(data['sources']):
        raise ValueError('Source snapshot file set does not match the report')
    written = {}
    for node in tree.findall('.//class'):
        source = data['sources'][node.attrib['filename']]
        relative = PurePosixPath(source['path'])
        if relative.is_absolute() or '..' in relative.parts or not relative.parts or '\\' in source['path']:
            raise ValueError('Invalid snapshot source path')
        contents = source['text'].encode('utf-8')
        if digest(contents) != source['sha256']:
            raise ValueError('Source snapshot checksum mismatch')
        if source['path'] in written and written[source['path']] != contents:
            raise ValueError('Conflicting snapshot source aliases')
        written[source['path']] = contents
        if any(int(line.attrib['number']) < 1 or int(line.attrib['number']) > len(source['text'].splitlines()) for line in node.findall('./lines/line')):
            raise ValueError('Coverage line is outside its stored source file')
        path = destination / 'source' / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)
        node.set('filename', relative.as_posix())
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'source').mkdir(exist_ok=True)
    ET.ElementTree(tree).write(destination / 'coverage.xml')


def diff(baseline, current, current_sources, output):
    """Compare immutable source snapshots instead of whichever branch is now checked out."""
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        materialize(baseline, Path(baseline).with_name('sources.json'), root / 'baseline', os.environ['GITHUB_REPOSITORY'])
        materialize(current, current_sources, root / 'current', os.environ.get('COVERAGE_SOURCE_REPOSITORY') or os.environ['GITHUB_REPOSITORY'])
        return subprocess.call(['pycobertura', 'diff', '--no-color', '--source', '--source1', str(root / 'baseline/source'), '--source2', str(root / 'current/source'), str(root / 'baseline/coverage.xml'), str(root / 'current/coverage.xml'), '--output', output])


def gate():
    """Keep each policy independent, including exception opt-out."""
    status = os.environ.get('COVERAGE_ENV_PYCOBERTURA_STATUS', '')
    errors = [status, os.environ.get('COVERAGE_BASELINE_STATUS', ''), os.environ.get('COVERAGE_CAPTURE_STATUS', '')]
    if '1' in errors and os.environ['COVERAGE_INPUTS_PYCOBERTURA_EXCEPTION_FAILURE'] == 'true':
        raise ValueError('Coverage comparison exception occurred')
    policies = {'2': 'UNCOVERED_STATEMENTS_INCREASE_FAILURE', '3': 'NEW_UNCOVERED_STATEMENTS_FAILURE'}
    if status in policies and os.environ['COVERAGE_INPUTS_' + policies[status]] == 'true':
        raise ValueError(f'Coverage source comparison failed with status {status}')
    baseline = Path('.coverage-output.diff-branch')
    if os.environ['COVERAGE_INPUTS_COVERAGE_RATE_REDUCTION_FAILURE'] == 'true' and baseline.exists():
        current = CoverageCounts.read('.coverage-output').percent
        previous = CoverageCounts.read(baseline).percent
        if current < previous:
            raise ValueError('Coverage rate decreased')


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
    percent = commands.add_parser('percent')
    percent.add_argument('report')
    commands.add_parser('threshold')
    commands.add_parser('gate')
    args = parser.parse_args()
    try:
        if args.command == 'capture':
            capture(args.report, args.output, args.source_root)
        elif args.command == 'diff':
            return diff(args.baseline, args.current, args.current_sources, args.output)
        elif args.command == 'percent':
            print(f'{float(CoverageCounts.read(args.report).percent):.8f}')
        elif args.command == 'threshold':
            threshold = Fraction(os.environ['COVERAGE_INPUTS_THRESHOLD'])
            if CoverageCounts.read('.coverage-output').percent < threshold:
                raise ValueError('Total coverage falls below minimum threshold')
        elif args.command == 'gate':
            gate()
    except (ValueError, OSError, KeyError, TypeError, ET.ParseError, subprocess.CalledProcessError) as error:
        print(f'Coverage error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
