import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
from contextlib import contextmanager
from xml.etree import ElementTree as ET

from test_review import ActionFixture
from test_action import ACTION
sys.path.insert(0, str(ACTION))
import sources
import report
import workflow
import publish
import test_publish
from test_publish import BRANCH


class SettledContracts(ActionFixture, unittest.TestCase):
    def test_http_declaration_renders_report_only(self):
        path = self.workspace / 'coverage.xml'
        path.write_bytes(b'<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">\n' + path.read_bytes())
        self.values['inputs.skip-diff-storage'] = 'true'
        self.run_step('Generate text report')
        self.assertIn('TOTAL', (self.workspace / '.coverage-output').read_text())

    def test_utf16_entities_are_rejected_before_rendering(self):
        for encoding in ('utf-8', 'utf-16', 'utf-16-be', 'utf-16-le'):
            with self.subTest(encoding=encoding):
                data = '<!DOCTYPE coverage [<!ENTITY x "expanded">]><coverage>&x;</coverage>'.encode(encoding)
                with self.assertRaises(ValueError):
                    sources.xml_tree(data)

    def test_scientific_rates_preserve_exact_value_and_reject_bad_numbers(self):
        path = self.workspace / 'coverage.xml'
        tree = ET.parse(path)
        tree.getroot().set('line-rate', '1e-05')
        tree.write(path)
        self.stage()
        self.assertEqual(self.values['steps.capture.outputs.status'], '0')
        self.assertEqual(ET.parse(self.workspace / 'coverage-action/coverage.xml').getroot().get('line-rate'), '1e-05')
        for value in ('NaN', 'Infinity', '-0.1', '1.01', '1e99999', '1e99999999999999999999999999999'):
            tree.getroot().set('line-rate', value)
            tree.write(path)
            self.run_step('Capture report sources')
            self.assertEqual(self.values['steps.capture.outputs.status'], '1')
        tree.getroot().set('line-rate', '0.5')
        tree.find('.//line').set('hits', '1e2')
        tree.write(path)
        self.run_step('Capture report sources')
        self.assertEqual(self.values['steps.capture.outputs.status'], '1')

    def test_clean_git_eol_conversion_keeps_blob_identity(self):
        (self.workspace / '.gitattributes').write_text('sample.py text eol=crlf\n')
        self.git(self.workspace, 'add', '.gitattributes')
        self.git(self.workspace, 'commit', '-m', 'Checkout line endings')
        self.environment['GITHUB_SHA'] = self.git(self.workspace, 'rev-parse', 'HEAD').strip()
        (self.workspace / 'sample.py').unlink()
        self.git(self.workspace, 'checkout', '--', 'sample.py')
        self.assertIn(b'\r\n', (self.workspace / 'sample.py').read_bytes())
        self.assertEqual(self.git(self.workspace, 'diff', '--name-only'), '')
        self.stage()
        self.assertEqual(self.values['steps.capture.outputs.status'], '0')
        manifest = json.loads((self.workspace / 'coverage-action/sources.json').read_text())
        self.assertEqual(manifest['sources']['sample.py']['sha256'], sources.digest(b'first\nold\nlast\n'))
        (self.workspace / 'sample.py').write_bytes(b'first\r\nchanged\r\nlast\r\n')
        self.run_step('Capture report sources')
        self.assertEqual(self.values['steps.capture.outputs.status'], '1')

    def test_eol_changes_without_git_conversion_authority_are_refused(self):
        self.git(self.workspace, 'config', 'core.autocrlf', 'false')
        (self.workspace / 'sample.py').write_bytes(b'first\r\nold\r\nlast\r\n')
        self.stage()
        self.assertEqual(self.values['steps.capture.outputs.status'], '1')

    def test_materialize_validates_every_class_for_the_same_source(self):
        self.stage()
        path = self.workspace / 'coverage-action/coverage.xml'
        tree = ET.parse(path)
        classes = tree.find('.//classes')
        duplicate = ET.fromstring(ET.tostring(classes[0]))
        duplicate.find('./lines/line').set('number', '999')
        classes.append(duplicate)
        path.write_bytes(sources.canonical_xml(tree.getroot(), {'sample.py': 'sample.py'}))
        manifest = path.with_name('sources.json')
        data = json.loads(manifest.read_text())
        data['report_sha256'] = sources.digest(path.read_bytes())
        manifest.write_text(json.dumps(data))
        with patch.dict(os.environ, self.environment), self.assertRaisesRegex(ValueError, 'outside its source'):
            sources.materialize(path, manifest, self.root / 'materialized', 'example/consumer')

    def test_relative_source_root_deduplicates_without_accepting_symlinks(self):
        path = self.workspace / 'coverage.xml'
        tree = ET.parse(path)
        ET.SubElement(ET.SubElement(tree.getroot(), 'sources'), 'source').text = '.'
        tree.write(path)
        self.stage()
        self.assertEqual(self.values['steps.capture.outputs.status'], '0')
        (self.workspace / 'alias').symlink_to(self.workspace, target_is_directory=True)
        tree.find('./sources/source').text = 'alias'
        tree.write(path)
        self.run_step('Capture report sources')
        self.assertEqual(self.values['steps.capture.outputs.status'], '1')

    def test_mixed_case_and_unknown_policy_values(self):
        self.baseline_snapshot()
        self.report([0, 0, 1])
        self.stage()
        self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        self.assertEqual(self.values['steps.comparison.outputs.status'], '2')
        for value in ('TRUE', 'True', 'yes', 'nottrue'):
            self.values['inputs.uncovered-statements-increase-failure'] = value
            self.gate(1)
        self.values['inputs.uncovered-statements-increase-failure'] = 'FALSE'
        self.gate(0)

    def test_preflight_rejects_unknown_booleans_even_when_diff_is_disabled(self):
        import shutil
        shutil.rmtree(self.storage)
        for name in ('fail', 'publish', 'diff', 'skip-diff-storage', 'new-uncovered-statements-failure'):
            original = self.values['inputs.' + name]
            for value in ('', 'yes', 'nottrue'):
                self.values['inputs.' + name] = value
                result = self.run_step('Validate action destinations', 1)
                self.assertIn('invalid-boolean', result.stderr)
            self.values['inputs.' + name] = original
        self.values['inputs.diff'] = 'FALSE'
        self.run_step('Validate action destinations')

    def test_untyped_diagnostics_never_echo_exception_values(self):
        import io
        from diagnostics import diagnostic
        output = io.StringIO()
        with patch('sys.stderr', output):
            diagnostic(ValueError('sensitive source marker'))
            diagnostic(OSError('sensitive path marker'))
        self.assertEqual(output.getvalue(), 'Coverage: invalid-input.\nCoverage: operation-failed.\n')

    def test_diagnostics_distinguish_missing_baseline_and_checksum(self):
        self.stage()
        result = self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        self.assertIn('baseline-missing', result.stderr)
        self.baseline_snapshot()
        path = self.baseline / 'coverage.xml'
        path.write_bytes(path.read_bytes() + b' ')
        result = self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        self.assertIn('manifest-binding', result.stderr)
        self.assertNotIn(str(self.workspace), result.stderr)

    def test_summary_uses_measured_checkout_without_capture(self):
        self.values.update({'inputs.skip-diff-storage': 'true', 'github.sha': '1' * 40})
        self.run_step('Generate text report')
        self.run_step('Get total')
        self.run_step('Store coverage percent')
        self.run_step('Generate issue comment body')
        body = (self.workspace / '.coverage-output.final').read_text()
        self.assertIn(self.environment['GITHUB_SHA'], body)
        self.assertNotIn('1' * 40, body)

    def test_materialize_groups_classes_once_and_checks_each_class(self):
        self.stage()
        manifest = self.workspace / 'coverage-action/sources.json'
        xml = manifest.with_name('coverage.xml')
        tree, data = sources.load_manifest(xml, manifest, 'example/consumer')
        class CountingTree:
            calls = 0
            def findall(self, path):
                self.calls += 1
                return tree.findall(path)
        counted = CountingTree()
        data['sources']['other.py'] = data['sources']['sample.py']
        @contextmanager
        def provider(*args):
            class Objects:
                def source(self, name):
                    return sources.GitObjects(self_workspace, commit).source('sample.py')
            yield Objects()
        self_workspace, commit = self.workspace, self.environment['GITHUB_SHA']
        with patch.object(sources, 'load_manifest', return_value=(counted, data)):
            sources.materialize(xml, manifest, self.root / 'output', 'example/consumer', provider)
        self.assertEqual(counted.calls, 1)

    def test_failed_policies_keep_summary_and_block_publication(self):
        for failure in ('threshold', 'diff'):
            with self.subTest(failure=failure):
                self.baseline_snapshot()
                self.source('first\nchanged uncovered\nlast\n')
                self.stage()
                self.values['inputs.threshold'] = '100' if failure == 'threshold' else '0'
                self.values['inputs.new-uncovered-statements-failure'] = 'true'
                self.values['inputs.publish'] = 'true'
                failed, executed, comments, summary_output = False, [], [], ''
                steps = self.metadata['runs']['steps']
                start = next(i for i, step in enumerate(steps) if step.get('id') == 'comparison')
                for step in steps[start:]:
                    condition = step.get('if', '')
                    if failed and 'always()' not in condition:
                        continue
                    if not self.condition_allows(step):
                        continue
                    name = step['name']
                    executed.append(name)
                    if 'uses' in step:
                        if name == 'Determine repository visibility':
                            self.values['steps.repository-visibility.outputs.result'] = 'public'
                        elif name == 'Post as comment':
                            comments.append((self.workspace / '.coverage-output.final').read_text())
                        else:
                            self.fail('Unexpected publication after failed policy: ' + name)
                        continue
                    result = self.run_step(name, expected=None)
                    failed = failed or result.returncode != 0
                    if name == 'Set as output':
                        summary_output = (self.root / 'step-output').read_text()
                self.assertTrue(failed)
                self.assertEqual(len(comments), 1)
                self.assertIn('TOTAL', comments[0])
                self.assertNotIn('![badge]', comments[0])
                self.assertIn('TOTAL', summary_output)
                self.assertFalse(any(n.startswith(('Commit ', 'Push ', 'Generate the badge')) for n in executed))
                self.source('first\nold\nlast\n')

    def test_initialization_restores_executable_blobs(self):
        remote = self.root / 'storage.git'
        self.git(self.root, 'init', '--bare', str(remote))
        executable = self.storage / 'script'
        executable.write_text('#!/bin/sh\nexit 0\n')
        executable.chmod(0o755)
        self.git(self.storage, 'config', 'core.filemode', 'true')
        self.git(self.storage, 'add', 'script')
        self.git(self.storage, 'commit', '-m', 'Executable fixture')
        self.git(self.storage, 'remote', 'add', 'origin', str(remote))
        self.git(self.storage, 'push', 'origin', '_xml_coverage_reports')
        real_git = workflow.storage_git
        def intercept(*args):
            if args[:2] == ('remote', 'get-url'):
                return b'https://github.com/example/consumer.git\n'
            return real_git(*args)
        with patch.dict(os.environ, {**self.environment, 'COVERAGE_INPUTS_DIFF_STORAGE': '_xml_coverage_reports', 'COVERAGE_PUBLICATION_STATE': str(self.root / 'state.json')}), patch.object(workflow, 'storage_git', side_effect=intercept):
            workflow.initialize()
        self.assertEqual(self.git(self.storage, 'diff', '--name-only'), '')


class PublisherSuccess(unittest.TestCase):
    setUp = test_publish.CoveragePublicationTests.setUp
    git = test_publish.CoveragePublicationTests.git
    configure = test_publish.CoveragePublicationTests.configure
    clone = test_publish.CoveragePublicationTests.clone
    commit = test_publish.CoveragePublicationTests.commit
    publish = test_publish.CoveragePublicationTests.publish
    stored = test_publish.CoveragePublicationTests.stored
    def test_expected_https_repository_success_without_network(self):
        directory = self.clone('https')
        self.git(directory, 'remote', 'set-url', 'origin', 'https://github.com/example/consumer.git')
        self.git(directory, 'config', 'remote.origin.pushurl', 'https://github.com/example/consumer.git')
        real_git = publish.git
        calls = []
        def intercept(root, *args):
            if args[0] in ('fetch', 'push', 'ls-remote'):
                calls.append(args)
                self.assertEqual(args[0], 'push')
                return subprocess.CompletedProcess(args, 0, b'', b'')
            return real_git(root, *args)
        with patch.dict(os.environ, {'COVERAGE_EXPECTED_REPOSITORY': 'example/consumer'}), patch.object(publish, 'git', side_effect=intercept):
            publish.publish(directory, BRANCH, 1)
        self.assertEqual(len(calls), 1)

    def state(self, directory, namespace='data/main'):
        path = self.root / (directory.name + '-state.json')
        path.write_text(json.dumps({'initial': self.git(directory, 'rev-parse', 'HEAD').stdout.decode().strip(), 'namespace': namespace, 'existed': True}))
        return path

    def test_stale_identical_badge_cannot_advance_over_newer_pair(self):
        self.commit(self.seed, 'data/main/badge.svg', b'identical badge\n')
        self.commit(self.seed, 'data/main/coverage.xml', b'initial report\n')
        self.git(self.seed, 'push', 'origin', BRANCH)
        older = self.clone('older')
        newer = self.clone('newer')
        state = self.state(older)
        self.commit(newer, 'data/main/coverage.xml', b'newer report\n')
        self.git(newer, 'push', 'origin', BRANCH)
        self.assertEqual((older / 'data/main/badge.svg').read_bytes(), (newer / 'data/main/badge.svg').read_bytes())
        with patch.dict(os.environ, {'COVERAGE_PUBLICATION_STATE': str(state)}):
            result = self.publish(older)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.stored('data/main/coverage.xml'), b'newer report\n')

    def test_retry_rechecks_pair_even_when_git_can_merge(self):
        older = self.clone('retry-older')
        newer = self.clone('retry-newer')
        state = self.state(older)
        self.commit(older, 'data/main/badge.svg', b'badge\n')
        real_git = publish.git
        raced = False
        def race(directory, *args):
            nonlocal raced
            if args[0] == 'push' and not raced:
                raced = True
                self.commit(newer, 'data/main/sources.json', b'newer manifest\n')
                self.git(newer, 'push', 'origin', BRANCH)
            return real_git(directory, *args)
        with patch.dict(os.environ, {'COVERAGE_PUBLICATION_STATE': str(state)}), patch.object(publish, 'git', side_effect=race):
            with self.assertRaises(publish.PublicationError):
                publish.publish(older, BRANCH, 3)
        self.assertTrue(raced)
        self.assertEqual(self.stored('data/main/sources.json'), b'newer manifest\n')

    def test_report_after_badge_rechecks_initialized_pair(self):
        older = self.clone('store-older')
        newer = self.clone('store-newer')
        state = self.state(older)
        self.commit(newer, 'data/main/coverage.xml', b'newer report\n')
        self.git(newer, 'push', 'origin', BRANCH)
        self.git(older, 'fetch', 'origin', BRANCH)
        self.git(older, 'merge', '--ff-only', 'FETCH_HEAD')
        staging = self.root / 'coverage-action'
        staging.mkdir()
        (staging / 'sources.json').write_text('{}')
        (staging / 'coverage.xml').write_text('old report')
        environment = {'GITHUB_WORKSPACE': str(self.root), 'COVERAGE_INPUTS_DIFF_STORAGE': older.name, 'COVERAGE_ENV_DIFF_STORAGE_BRANCH': 'main', 'COVERAGE_COMPARISON_STATUS': '0', 'COVERAGE_PUBLICATION_STATE': str(state)}
        result = subprocess.run([sys.executable, str(ACTION / 'workflow.py'), 'store'], cwd=self.root, env={**os.environ, **environment}, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((older / 'data/main/coverage.xml').read_bytes(), b'newer report\n')
