import itertools
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from xml.etree import ElementTree as ET

from ruamel.yaml import YAML

from test_action import ACTION


class ActionFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.installed = self.root / 'installed action'
        shutil.copytree(ACTION, self.installed)
        self.workspace = self.root / 'consumer'
        self.workspace.mkdir()
        self.metadata = YAML(typ='safe').load((self.installed / 'action.yml').read_text())
        self.values = {'inputs.' + k: str(v.get('default', '')).lower() if isinstance(v.get('default'), bool) else str(v.get('default', '')) for k, v in self.metadata['inputs'].items()}
        self.values.update({'github.action_path': str(self.installed), 'github.workspace': str(self.workspace), 'github.repository': 'example/consumer', 'github.repository_owner': 'example', 'github.event.repository.name': 'consumer', 'github.event_name': 'push', 'github.event.pull_request.head.repo.full_name': '', 'github.event.pull_request.head.repo.id': '', 'github.event.pull_request.number': '', 'github.sha': '', 'github.event.pull_request.head.sha': ''})
        self.environment = dict(os.environ, GITHUB_WORKSPACE=str(self.workspace), GITHUB_REF='refs/heads/main', GITHUB_HEAD_REF='', GITHUB_REPOSITORY='example/consumer')
        self.git(self.workspace, 'init', '-b', 'main')
        self.git(self.workspace, 'config', 'core.hooksPath', os.devnull)
        self.git(self.workspace, 'config', 'commit.gpgsign', 'false')
        self.git(self.workspace, 'config', 'user.name', 'Example')
        self.git(self.workspace, 'config', 'user.email', 'coverage-fixture')
        self.report([1, 0, 1])
        self.source('first\nold\nlast\n')
        self.values['github.sha'] = self.git(self.workspace, 'rev-parse', 'HEAD').strip()
        self.environment['GITHUB_SHA'] = self.values['github.sha']
        self.values.update({'inputs.diff': 'true', 'inputs.skip-diff-storage': 'false'})
        self.storage = self.workspace / '_xml_coverage_reports'
        self.baseline = self.storage / 'data/main'
        self.baseline.mkdir(parents=True)
        self.git(self.storage, 'init', '-b', '_xml_coverage_reports')
        self.git(self.storage, 'config', 'core.hooksPath', os.devnull)
        self.git(self.storage, 'config', 'commit.gpgsign', 'false')
        self.git(self.storage, 'config', 'user.name', 'Example')
        self.git(self.storage, 'config', 'user.email', 'coverage-fixture')
        self.git(self.storage, 'commit', '--allow-empty', '-m', 'Initial')

    def git(self, root, *args):
        result = subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def source(self, text):
        (self.workspace / 'sample.py').write_text(text)
        self.git(self.workspace, 'add', 'sample.py')
        self.git(self.workspace, 'commit', '-m', 'Source fixture')
        self.environment['GITHUB_SHA'] = self.git(self.workspace, 'rev-parse', 'HEAD').strip()
        self.values['github.sha'] = self.environment['GITHUB_SHA']

    def report(self, hits, destination=None):
        root = ET.Element('coverage', {'line-rate': str(sum(bool(x) for x in hits) / len(hits) if hits else 0)})
        classes = ET.SubElement(ET.SubElement(ET.SubElement(root, 'packages'), 'package', {'name': 'sample'}), 'classes')
        c = ET.SubElement(classes, 'class', {'name': 'sample', 'filename': 'sample.py', 'line-rate': root.get('line-rate')})
        lines = ET.SubElement(c, 'lines')
        for n, h in enumerate(hits, 1):
            ET.SubElement(lines, 'line', {'number': str(n), 'hits': str(h)})
        ET.ElementTree(root).write(destination or self.workspace / 'coverage.xml')

    def render(self, value):
        return re.sub(r'\$\{\{ (.*?) \}\}', lambda m: self.values.get(m[1], ''), str(value))

    def run_step(self, name, expected=0):
        s = next(s for s in self.metadata['runs']['steps'] if s.get('name') == name)
        condition = s.get('if', '')
        if condition:
            condition = re.sub(r"contains\(([^,]+), '([^']+)'\)", lambda m: str(m[2] in self.values.get(m[1], '')), condition)
            condition = re.sub(r"(inputs\.[\w-]+) != '([^']+)'", lambda m: str(self.values.get(m[1], '') != m[2]), condition)
            if not eval(condition.replace('&&', ' and ').replace('||', ' or ')):
                return None
        env = dict(self.environment)
        env.update({k: self.render(v) for k, v in s.get('env', {}).items()})
        out = self.root / 'step-output'
        job = self.root / 'job-env'
        out.write_text('')
        job.write_text('')
        env.update(GITHUB_OUTPUT=str(out), GITHUB_ENV=str(job))
        shell = [sys.executable, '-c'] if s['shell'] == 'python' else ['bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c']
        cwd = self.workspace / self.render(s.get('working-directory', '.'))
        result = subprocess.run([*shell, self.render(s['run'])], cwd=cwd, env=env, capture_output=True, text=True)
        for line in out.read_text().splitlines():
            if '=' in line:
                k, v = line.split('=', 1)
                self.values[f"steps.{s.get('id')}.outputs.{k}"] = v
        for line in job.read_text().splitlines():
            if '=' in line:
                k, v = line.split('=', 1)
                self.values['env.' + k] = v
                self.environment[k] = v
        if expected is not None:
            self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def stage(self):
        self.run_step('Capture report sources')
        self.run_step('Generate text report')

    def baseline_snapshot(self):
        self.stage()
        shutil.copy(self.workspace / 'coverage-action/coverage.xml', self.baseline / 'coverage.xml')
        source = self.workspace / 'coverage-action/sources.json'
        if source.exists():
            shutil.copy(source, self.baseline / 'sources.json')

    def gate(self, expected=0):
        return self.run_step('Fail if coverage worsened', expected)


class ActionExecution(ActionFixture, unittest.TestCase):
    def test_real_source_diff_and_independent_flags(self):
        self.baseline_snapshot()
        self.source('first\nnew uncovered\nlast\n')
        self.stage()
        self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        for increased, new in itertools.product(['true', 'false'], repeat=2):
            self.values['inputs.uncovered-statements-increase-failure'] = increased
            self.values['inputs.new-uncovered-statements-failure'] = new
            self.gate(int(new == 'true'))

    def test_status_two_independent_flags(self):
        self.baseline_snapshot()
        self.report([0, 0, 1])
        self.stage()
        self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        for increased, new in itertools.product(['true', 'false'], repeat=2):
            self.values['inputs.uncovered-statements-increase-failure'] = increased
            self.values['inputs.new-uncovered-statements-failure'] = new
            self.gate(int(increased == 'true'))

    def test_malformed_baseline_respects_exception_flag_with_rate_gate(self):
        self.stage()
        (self.baseline / 'coverage.xml').write_text('<invalid')
        self.values['inputs.coverage-rate-reduction-failure'] = 'true'
        self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        self.run_step('Extract diff-branch coverage percentage')
        for flag in ['false', 'true']:
            self.values['inputs.pycobertura-exception-failure'] = flag
            self.gate(1)

    def test_prior_invocation_status_does_not_leak(self):
        self.values.update({'env.pycobertura_status': '2', 'inputs.uncovered-statements-increase-failure': 'true'})
        self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        self.gate(1)
        self.values['inputs.skip-diff-storage'] = 'true'
        self.gate()

    def test_zero_statement_current_and_baseline(self):
        self.report([])
        self.baseline_snapshot()
        self.values['inputs.coverage-rate-reduction-failure'] = 'true'
        self.run_step('Get total')
        self.assertEqual((self.workspace / '.coverage-total').read_text().strip(), '0.00000000')
        self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        self.run_step('Extract diff-branch coverage percentage')
        self.gate()
        self.run_step('Check threshold')
        self.values['inputs.threshold'] = '1'
        self.run_step('Check threshold', 1)

    def test_threshold_uses_exact_counts(self):
        self.stage()
        self.run_step('Get total')
        self.values['inputs.threshold'] = '66.666666668'
        self.run_step('Check threshold', 1)
        self.values['inputs.threshold'] = '66.666666666'
        self.run_step('Check threshold')

    def test_rate_gate_without_bc(self):
        self.report([1, 1, 1], self.baseline / 'coverage.xml')
        self.stage()
        self.values['inputs.coverage-rate-reduction-failure'] = 'true'
        self.run_step('Get total')
        self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        self.run_step('Extract diff-branch coverage percentage')
        tools = self.root / 'bin'
        tools.mkdir()
        (tools / 'bc').write_text('#!/bin/sh\nexit 127\n')
        (tools / 'bc').chmod(0o755)
        self.environment['PATH'] = str(tools) + os.pathsep + os.environ['PATH']
        self.gate(1)

    def test_fork_main_is_not_official_main(self):
        self.stage()
        self.run_step('Get total')
        self.environment['GITHUB_HEAD_REF'] = 'main'
        self.values.update({'github.event_name': 'pull_request', 'github.event.pull_request.head.repo.full_name': 'contributor/consumer', 'github.event.pull_request.head.repo.id': '123', 'github.event.pull_request.number': '7'})
        self.run_step('Store coverage percent')
        branch = self.values.get('steps.coverage_percent.outputs.diff_storage_branch', self.values.get('env.diff_storage_branch'))
        self.assertNotEqual(branch, 'main')
        self.assertNotIn('..', branch)

    def test_report_only_summary_is_nonempty(self):
        self.values.update({'inputs.publish': 'false', 'inputs.skip-diff-storage': 'true'})
        self.stage()
        self.run_step('Get total')
        self.run_step('Store coverage percent')
        self.run_step('Generate issue comment body')
        self.run_step('Set as output')
        self.assertIn('TOTAL', (self.root / 'step-output').read_text())

    def test_nested_storage_commits_staged_report(self):
        self.stage()
        nested = self.workspace / 'coverage/reports'
        nested.parent.mkdir()
        self.storage.rename(nested)
        self.storage = nested
        self.baseline = nested / 'data/main'
        self.git(nested, 'branch', '-m', 'coverage/reports')
        remote = self.root / 'remote.git'
        self.git(self.root, 'init', '--bare', str(remote))
        self.git(remote, 'config', 'core.hooksPath', os.devnull)
        self.git(nested, 'remote', 'add', 'origin', str(remote))
        self.git(nested, 'push', '-u', 'origin', 'coverage/reports')
        self.values.update({'inputs.diff-storage': 'coverage/reports', 'env.diff_storage_branch': 'main', 'steps.coverage_percent.outputs.diff_storage_branch': 'main'})
        self.values['steps.comparison.outputs.status'] = '0'
        self.run_step('Commit XML report to ${{ inputs.diff-storage }}')
        self.assertEqual((self.baseline / 'coverage.xml').read_bytes(), (self.workspace / 'coverage-action/coverage.xml').read_bytes())

    def test_status_two_documentation_names_real_input(self):
        self.assertNotIn('`coverage-reduction-failure: true`', self.metadata['inputs']['new-uncovered-statements-failure']['description'])

    def test_legacy_baseline_requires_sources_with_explicit_exception_opt_out(self):
        self.stage()
        shutil.copy(self.workspace / 'coverage-action/coverage.xml', self.baseline / 'coverage.xml')
        self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        self.assertEqual(self.values['steps.comparison.outputs.status'], '1')
        self.gate(1)
        self.values['inputs.pycobertura-exception-failure'] = 'false'
        self.gate(1)

    def test_source_identity_is_bound_to_report_bytes(self):
        self.baseline_snapshot()
        self.report([1, 1, 1], self.baseline / 'coverage.xml')
        self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        self.assertEqual(self.values['steps.comparison.outputs.status'], '1')
        self.gate(1)

    def test_modified_worktree_source_is_not_claimed_as_commit_source(self):
        (self.workspace / 'sample.py').write_text('first\nmodified\nlast\n')
        self.stage()
        self.assertEqual(self.values['steps.capture.outputs.status'], '1')
        self.assertFalse((self.workspace / 'coverage-action/sources.json').exists())
        self.gate(1)

    def test_source_root_supports_nested_consumer_report(self):
        nested = self.workspace / 'language'
        nested.mkdir()
        self.git(self.workspace, 'mv', 'sample.py', 'language/sample.py')
        self.git(self.workspace, 'commit', '-m', 'Nested source fixture')
        self.environment['GITHUB_SHA'] = self.git(self.workspace, 'rev-parse', 'HEAD').strip()
        (self.workspace / 'coverage.xml').rename(nested / 'coverage.xml')
        self.values.update({'inputs.path': 'language/coverage.xml', 'inputs.source-root': 'language'})
        self.stage()
        self.assertEqual(self.values['steps.capture.outputs.status'], '0')
        self.assertTrue((self.workspace / 'coverage-action/sources.json').exists())

    def test_official_branch_keeps_existing_namespace(self):
        self.stage()
        self.run_step('Get total')
        self.run_step('Store coverage percent')
        self.assertEqual(self.values['steps.coverage_percent.outputs.diff_storage_branch'], 'main')

    def test_exact_rate_comparison_below_display_precision(self):
        (self.workspace / '.coverage-output').write_text('TOTAL 100000000000 1 ignored\n')
        (self.workspace / '.coverage-output.diff-branch').write_text('TOTAL 100000000001 1 ignored\n')
        self.values['inputs.coverage-rate-reduction-failure'] = 'true'
        self.gate(1)

    def test_default_source_resolution_supports_nested_consumer_report(self):
        nested = self.workspace / 'language'
        nested.mkdir()
        self.git(self.workspace, 'mv', 'sample.py', 'language/sample.py')
        self.git(self.workspace, 'commit', '-m', 'Nested source fixture')
        self.environment['GITHUB_SHA'] = self.git(self.workspace, 'rev-parse', 'HEAD').strip()
        (self.workspace / 'coverage.xml').rename(nested / 'coverage.xml')
        self.values['inputs.path'] = 'language/coverage.xml'
        self.stage()
        self.assertEqual(self.values['steps.capture.outputs.status'], '0')

    def test_snapshot_validation_rejects_corruption_and_path_escape(self):
        self.baseline_snapshot()
        path = self.baseline / 'sources.json'
        original = path.read_text()
        for change in ['checksum', 'path', 'repository', 'commit']:
            with self.subTest(change=change):
                snapshot = json.loads(original)
                if change == 'checksum':
                    snapshot['sources']['sample.py']['sha256'] = '0' * 64
                elif change == 'path':
                    snapshot['sources']['sample.py']['path'] = '../escaped'
                elif change == 'repository':
                    snapshot['repository'] = 'another/repository'
                else:
                    snapshot['commit'] = 'main'
                path.write_text(json.dumps(snapshot))
                self.run_step('Generate diff against ${{ inputs.diff-branch }}')
                self.assertEqual(self.values['steps.comparison.outputs.status'], '1')
                self.gate(1)
        self.assertFalse((self.workspace / 'escaped').exists())

    def test_external_consumer_roundtrip_preserves_sources_and_enforces_new_lines(self):
        remote = self.root / 'storage-remote.git'
        self.git(self.root, 'init', '--bare', str(remote))
        self.git(remote, 'config', 'core.hooksPath', os.devnull)
        self.git(self.storage, 'remote', 'add', 'origin', str(remote))
        self.git(self.storage, 'push', '-u', 'origin', '_xml_coverage_reports')
        self.stage()
        self.run_step('Get total')
        self.run_step('Store coverage percent')
        self.run_step('Generate issue comment body')
        self.run_step('Set as output')
        self.assertIn('TOTAL', (self.root / 'step-output').read_text())
        self.values['steps.comparison.outputs.status'] = '0'
        self.run_step('Commit XML report to ${{ inputs.diff-storage }}')
        self.values['github.repository'] = ''
        self.run_step('Push XML report to ${{ inputs.diff-storage }}')
        published = self.git(remote, 'show', '_xml_coverage_reports:data/main/sources.json')
        self.assertEqual(json.loads(published)['commit'], self.git(self.workspace, 'rev-parse', 'HEAD').strip())
        shutil.rmtree(self.storage)
        self.git(self.workspace, 'clone', '--branch', '_xml_coverage_reports', str(remote), str(self.storage))
        self.source('first\nnew uncovered\nlast\n')
        self.stage()
        self.values.update({'inputs.threshold': '50', 'inputs.uncovered-statements-increase-failure': 'true', 'inputs.new-uncovered-statements-failure': 'true', 'inputs.coverage-rate-reduction-failure': 'true'})
        self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        self.run_step('Extract diff-branch coverage percentage')
        self.run_step('Get total')
        self.run_step('Check threshold')
        self.assertEqual(self.values['steps.comparison.outputs.status'], '3')
        self.gate(1)

    def test_failed_capture_does_not_replace_stored_baseline(self):
        self.baseline_snapshot()
        original = (self.baseline / 'coverage.xml').read_bytes()
        self.report([0, 0, 0])
        (self.workspace / 'sample.py').write_text('first\nmodified\nlast\n')
        self.stage()
        self.run_step('Get total')
        self.run_step('Store coverage percent')
        remote = self.root / 'storage-remote.git'
        self.git(self.root, 'init', '--bare', str(remote))
        self.git(remote, 'config', 'core.hooksPath', os.devnull)
        self.git(self.storage, 'add', 'data')
        self.git(self.storage, 'commit', '-m', 'Valid baseline')
        self.git(self.storage, 'remote', 'add', 'origin', str(remote))
        self.git(self.storage, 'push', '-u', 'origin', '_xml_coverage_reports')
        self.values['steps.comparison.outputs.status'] = '0'
        self.run_step('Commit XML report to ${{ inputs.diff-storage }}', 1)
        self.assertEqual((self.baseline / 'coverage.xml').read_bytes(), original)
        self.assertTrue((self.baseline / 'sources.json').is_file())
        self.gate(1)
