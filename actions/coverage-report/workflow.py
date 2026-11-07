"""Composite action orchestration. Inputs are data, never executable shell text."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid
from urllib.parse import quote
from xml.etree import ElementTree as ET

import report
from diagnostics import CoverageError, Reason, boolean, diagnostic
from sources import git as source_git, identity, bounded_read, capture, relative_path, repository_name, xml_tree
import publish


def env(name, default=''):
    return os.environ.get('COVERAGE_' + name, default)


BOOLEAN_INPUTS = ('FAIL', 'PUBLISH', 'DIFF', 'SKIP_DIFF_STORAGE', 'UNCOVERED_STATEMENTS_INCREASE_FAILURE', 'NEW_UNCOVERED_STATEMENTS_FAILURE', 'COVERAGE_RATE_REDUCTION_FAILURE', 'PYCOBERTURA_EXCEPTION_FAILURE', 'TOGGLABLE_REPORT', 'REPORT_LOW_COVERAGE_ONLY', 'EXCLUDE_DETAILED_COVERAGE')

def setting(name, default=''):
    value = env('INPUTS_' + name, default or ('false' if name in BOOLEAN_INPUTS else ''))
    return str(boolean(value)).lower() if name in BOOLEAN_INPUTS else value


def output(name, value):
    if '\n' in value or '\r' in value:
        raise ValueError('Invalid single-line output')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
        stream.write(name + '=' + value + '\n')


def storage():
    name = relative_path(setting('DIFF_STORAGE'))
    root = Path(os.environ['GITHUB_WORKSPACE']).resolve()
    path = root / name
    if path.resolve() != path or path == root:
        raise ValueError('Unsafe storage directory')
    return path


def namespace(value):
    relative_path(value)
    if value.startswith('.') or any(part.startswith('.') for part in value.split('/')):
        raise ValueError('Reserved storage namespace')
    return value


def destination(branch):
    subdirectory = setting('STORAGE_SUBDIRECTORY', '.')
    if subdirectory != '.':
        relative_path(subdirectory)
    path = storage() / 'data' / branch / subdirectory
    if path.resolve() != path:
        raise ValueError('Unsafe storage destination')
    return path


def baseline():
    return destination(namespace(setting('DIFF_BRANCH', 'main'))) / 'coverage.xml'


def show(source, target):
    result = subprocess.run(['pycobertura', 'show', str(source), '--output', str(target)], capture_output=True, timeout=120)
    if result.returncode:
        raise ValueError('Cannot render coverage report')


def preflight():
    for name in BOOLEAN_INPUTS:
        setting(name)
    if setting('SKIP_DIFF_STORAGE') != 'true':
        target = storage()
        if target.exists():
            raise ValueError('Storage checkout destination must be absent')
        if target.parts[len(Path(os.environ['GITHUB_WORKSPACE']).resolve().parts)] == 'coverage-action':
            raise ValueError('Storage overlaps action staging')
        namespace(setting('DIFF_BRANCH', 'main'))
    for name in ('coverage-action', '.coverage-output', '.coverage-output.final', '.coverage-output.diff', '.coverage-output.diff-branch', '.coverage-total', '.coverage-total.diff-branch'):
        path = Path(name)
        if path.exists() or path.is_symlink():
            raise ValueError('Action staging destination must be absent')


def generate():
    directory = Path('coverage-action')
    directory.mkdir(exist_ok=True)
    for name in ('.coverage-output.diff', '.coverage-output.diff-branch', '.coverage-total.diff-branch'):
        Path(name).unlink(missing_ok=True)
    source = Path('coverage-action/coverage.xml') if env('CAPTURE_STATUS') == '0' else Path(setting('PATH'))
    tree = xml_tree(bounded_read(source))
    rendered = directory / 'render.xml'
    rendered.write_bytes(ET.tostring(tree, encoding='utf-8', xml_declaration=True))
    commit = identity(source_git(Path(os.environ['GITHUB_WORKSPACE']), 'rev-parse', 'HEAD').decode().strip())
    (directory / 'measured-commit').write_text(commit)
    show(rendered, '.coverage-output')
    if setting('REPORT_LOW_COVERAGE_ONLY') == 'true':
        path = Path('.coverage-output')
        lines = path.read_text().splitlines()
        path.write_text('\n'.join(line for i, line in enumerate(lines) if i < 2 or line.startswith('TOTAL ') or line.split()[2] != '0') + '\n')


def capture_sources():
    directory = Path('coverage-action')
    if directory.is_symlink() or directory.absolute() != directory.resolve():
        raise ValueError('Unsafe staging directory')
    path = directory / 'sources.json'
    path.unlink(missing_ok=True)
    path.with_name('coverage.xml').unlink(missing_ok=True)
    status = '0'
    try:
        capture(setting('PATH'), path, env('SOURCE_ROOT'))
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError, ET.ParseError, UnicodeError) as error:
        diagnostic(error)
        status = '1'
        path.unlink(missing_ok=True)
        path.with_name('coverage.xml').unlink(missing_ok=True)
    output('status', status)


def compare():
    Path('.coverage-output.diff').unlink(missing_ok=True)
    Path('.coverage-output.diff-branch').unlink(missing_ok=True)
    status = 1
    try:
        old = baseline()
        if not old.is_file() or not old.with_name('sources.json').is_file():
            raise CoverageError(Reason.BASELINE_MISSING)
        status = report.diff(old, 'coverage-action/coverage.xml', 'coverage-action/sources.json', '.coverage-output.diff')
        if status not in (0, 2, 3):
            status = 1
        else:
            show(old, '.coverage-output.diff-branch')
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError, ET.ParseError, UnicodeError) as error:
        diagnostic(error)
        status = 1
    output('status', str(status))


def baseline_total():
    # Only compare() can create this file, after both manifests and Git sources pass.
    status = '0' if env('COMPARISON_STATUS') in ('0', '2', '3') and Path('.coverage-output.diff-branch').is_file() else '1'
    if status == '0':
        Path('.coverage-total.diff-branch').write_text(f'{float(report.CoverageCounts.read(".coverage-output.diff-branch").percent):.8f}\n')
    output('status', status)


def total():
    Path('.coverage-total').write_text(f'{float(report.CoverageCounts.read(".coverage-output").percent):.8f}\n')


def state_path():
    return Path(env('PUBLICATION_STATE', 'coverage-action/storage-state.json'))


def coverage_percent():
    output('coverage_total', Path('.coverage-total').read_text().strip())
    head = os.environ.get('GITHUB_HEAD_REF', '')
    branch = head or os.environ.get('GITHUB_REF', '').removeprefix('refs/heads/')
    if head and repository_name(env('HEAD_REPOSITORY')) != repository_name(os.environ['GITHUB_REPOSITORY']):
        repository_id, number = env('HEAD_REPOSITORY_ID'), env('PR_NUMBER')
        if not repository_id.isdigit() or not number.isdigit():
            raise ValueError('Fork identity is unavailable')
        branch = '.forks/' + repository_id + '/' + number
    else:
        namespace(branch)
    output('diff_storage_branch', branch)
    if setting('SKIP_DIFF_STORAGE') != 'true':
        target = destination(branch)
        target.mkdir(parents=True, exist_ok=True)
        state = json.loads(bounded_read(state_path(), 16384))
        state['namespace'] = target.relative_to(storage()).as_posix()
        state_path().write_text(json.dumps(state))


def configure_git():
    values = {'GIT_AUTHOR_NAME': env('GIT_NAME'), 'GIT_AUTHOR_EMAIL': env('GIT_EMAIL'),
              'GIT_COMMITTER_NAME': env('GIT_NAME'), 'GIT_COMMITTER_EMAIL': env('GIT_EMAIL')}
    with open(os.environ['GITHUB_ENV'], 'a') as stream:
        for key, value in values.items():
            if not value or '\n' in value or '\r' in value:
                raise ValueError('Invalid Git identity')
            stream.write(key + '=' + value + '\n')


def storage_git(*args):
    result = publish.git(storage(), *args)
    if result.returncode:
        raise ValueError('Coverage storage operation failed')
    return result.stdout


def initialize():
    directory = storage()
    reference = 'refs/heads/' + setting('DIFF_STORAGE')
    expected = 'https://github.com/' + repository_name(os.environ['GITHUB_REPOSITORY'])
    remote = storage_git('remote', 'get-url', 'origin').decode().strip().lower().removesuffix('.git')
    if remote != expected:
        raise ValueError('Storage repository does not match trusted context')
    storage_git('check-ref-format', reference)
    remote_ref = storage_git('ls-remote', '--heads', 'origin', reference).splitlines()
    if remote_ref:
        storage_git('fetch', '--no-tags', '--depth=1', 'origin', reference)
        commit = storage_git('rev-parse', 'FETCH_HEAD').strip().decode()
        storage_git('update-ref', reference, commit)
        storage_git('symbolic-ref', 'HEAD', reference)
        storage_git('read-tree', commit)
        records = storage_git('ls-tree', '-r', '-z', commit).split(b'\0')
    else:
        storage_git('symbolic-ref', 'HEAD', reference)
        storage_git('read-tree', '--empty')
        records = []
    for path in directory.iterdir():
        if path.name != '.git':
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink()
    # Write raw blobs, avoiding checkout filters, attributes, symlinks and hooks.
    for record in records:
        if not record:
            continue
        metadata, name = record.split(b'\t', 1)
        mode, kind, blob = metadata.decode().split()
        if mode not in ('100644', '100755') or kind != 'blob':
            raise ValueError('Unsupported storage entry')
        path = directory / relative_path(name.decode())
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(storage_git('cat-file', 'blob', blob))
        path.chmod(0o755 if mode == '100755' else 0o644)
    (directory / 'data').mkdir(exist_ok=True)
    if not remote_ref:
        (directory / 'README.md').write_text('Coverage reports and content-free source manifests.\n')
        storage_git('add', '--', 'README.md')
        storage_git('commit', '-m', 'Initialize coverage storage')
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'initial': storage_git('rev-parse', 'HEAD').decode().strip(), 'existed': bool(remote_ref)}))


def commit_files(files, message):
    storage_git('add', '-f', '--', *files)
    result = publish.git(storage(), 'diff', '--cached', '--quiet')
    if result.returncode == 1:
        storage_git('commit', '-m', message)
    elif result.returncode:
        raise ValueError('Cannot inspect storage changes')


def commit_badge():
    branch = env('ENV_DIFF_STORAGE_BRANCH')
    relative_path(branch)
    path = destination(branch) / 'badge.svg'
    commit_files([path.relative_to(storage()).as_posix()], 'Update coverage badge')


def commit_report():
    if not Path('coverage-action/sources.json').exists():
        raise ValueError('Source capture unavailable; refusing storage replacement')
    if env('COMPARISON_STATUS') not in ('0', '2', '3'):
        raise ValueError('Verified baseline required before storage replacement')
    branch = env('ENV_DIFF_STORAGE_BRANCH')
    relative_path(branch)
    target = destination(branch)
    state = publish.publication_state()
    if state is None or state['namespace'] != target.relative_to(storage()).as_posix():
        raise publish.PublicationError('Publication state unavailable.')
    publish.verify_pair(storage(), 'HEAD', state)
    target.mkdir(parents=True, exist_ok=True)
    for name in ('coverage.xml', 'sources.json'):
        shutil.copyfile(Path('coverage-action') / name, target / name)
    commit_files([(target / n).relative_to(storage()).as_posix() for n in ('coverage.xml', 'sources.json')], 'Update verified coverage report')


def summary():
    percent = env('STEPS_COVERAGE_PERCENT_OUTPUTS_COVERAGE_TOTAL')
    lines = [f'🧪 Test coverage: {percent}%\n', '## ' + setting('COVERAGE_SUMMARY_TITLE') + '\n']
    if env('STEPS_REPOSITORY_VISIBILITY_OUTPUTS_RESULT') == 'public' and setting('SKIP_DIFF_STORAGE') != 'true' and env('BADGE_PUBLISHED') == 'success':
        branch = quote(env('ENV_DIFF_STORAGE_BRANCH'), safe='')
        repo = env('GITHUB_REPOSITORY_OWNER') + '/' + env('GITHUB_EVENT_REPOSITORY_NAME')
        lines[0] = f'![badge](https://raw.githubusercontent.com/{repo}/{quote(setting("DIFF_STORAGE"), safe="")}/data/{branch}/{quote(setting("STORAGE_SUBDIRECTORY"), safe="/")}/badge.svg)\n'
    if setting('EXCLUDE_DETAILED_COVERAGE') == 'false':
        if setting('TOGGLABLE_REPORT') == 'true':
            lines.append('<details>\n')
        lines.extend(['```', Path('.coverage-output').read_text().rstrip(), '```\n'])
        if setting('TOGGLABLE_REPORT') == 'true':
            lines.append('</details>\n')
    if setting('DIFF') == 'true' and Path('.coverage-output.diff').exists():
        lines.extend(['### Diff against ' + setting('DIFF_BRANCH') + '\n', '```', Path('.coverage-output.diff').read_text().rstrip(), '```\n'])
    commit = identity(Path('coverage-action/measured-commit').read_text())
    lines.extend(['Results for commit: ' + commit + '\n', f'_Minimum allowed coverage is `{setting("THRESHOLD")}%`_\n'])
    if setting('PUBLISH') == 'true':
        lines.append(':recycle: This comment has been updated with latest results\n')
    Path('.coverage-output.final').write_text('\n'.join(lines))


def set_output():
    body = Path('.coverage-output.final').read_text().rstrip('\n')
    delimiter = uuid.uuid4().hex
    with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
        stream.write(f'summary<<{delimiter}\n{body}\n{delimiter}\n')


def cleanup():
    shutil.rmtree('coverage-action', ignore_errors=True)
    for name in ('.coverage-output.final', '.coverage-output', '.coverage-total', '.coverage-output.diff', '.coverage-output.diff-branch', '.coverage-total.diff-branch'):
        Path(name).unlink(missing_ok=True)


COMMANDS = {'preflight': preflight, 'generate': generate, 'capture': capture_sources, 'compare': compare,
            'baseline': baseline_total, 'total': total, 'percent': coverage_percent,
            'configure': configure_git, 'initialize': initialize, 'badge': commit_badge,
            'store': commit_report, 'summary': summary, 'output': set_output, 'cleanup': cleanup}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=COMMANDS)
    args = parser.parse_args()
    try:
        COMMANDS[args.command]()
    except (ValueError, OSError, KeyError, TypeError, IndexError, subprocess.SubprocessError, ET.ParseError, UnicodeError, publish.PublicationError) as error:
        diagnostic(error)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
