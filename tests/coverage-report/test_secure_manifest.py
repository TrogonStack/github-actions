import json
import shutil
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "actions/coverage-report"))
import sources
import report
import workflow
import unittest

import test_review


class SecureManifestContract(test_review.ActionFixture, unittest.TestCase):
    def test_public_capture_never_persists_source_contents(self):
        self.stage()
        manifest = json.loads((self.workspace / 'coverage-action/sources.json').read_text())
        self.assertNotIn('text', manifest['sources']['sample.py'])
        self.assertEqual(manifest['version'], 2)

    def test_missing_baseline_cannot_seed_via_unused_branch(self):
        self.stage()
        self.values['inputs.diff-branch'] = 'unused-baseline'
        self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        self.assertEqual(self.values['steps.comparison.outputs.status'], '1')
        self.values['inputs.pycobertura-exception-failure'] = 'false'
        self.gate(1)

    def test_legacy_xml_cannot_bypass_integrity_with_exception_opt_out(self):
        self.stage()
        shutil.copy(self.workspace / 'coverage.xml', self.baseline / 'coverage.xml')
        self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        self.values['inputs.pycobertura-exception-failure'] = 'false'
        self.gate(1)




    def test_self_consistent_manifest_tamper_cannot_replace_git_source(self):
        self.baseline_snapshot()
        path = self.baseline / 'sources.json'
        data = json.loads(path.read_text())
        malicious = b'first\nforged\nlast\n'
        data['sources']['sample.py']['sha256'] = sources.digest(malicious)
        data['sources']['sample.py']['blob'] = hashlib.sha1(b'blob ' + str(len(malicious)).encode() + b'\0' + malicious).hexdigest()
        path.write_text(json.dumps(data))
        self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        self.assertEqual(self.values['steps.comparison.outputs.status'], '1')
        self.gate(1)

    def test_manifest_extra_metadata_and_source_text_are_refused(self):
        self.baseline_snapshot()
        path = self.baseline / 'sources.json'
        original = json.loads(path.read_text())
        for key in ('url', 'token', 'source_root', 'text'):
            data = dict(original, **{key: 'untrusted metadata'})
            path.write_text(json.dumps(data))
            self.run_step('Generate diff against ${{ inputs.diff-branch }}')
            self.assertEqual(self.values['steps.comparison.outputs.status'], '1')

    def test_normalized_paths_reject_traversal_and_aliases(self):
        for path in ('../escape', '/absolute', 'a/../escape', './file', 'a//file', 'a\\file', '.git/config', 'a/.git/config', 'C:file', 'a\nfile'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                sources.relative_path(path)

    def test_missing_source_and_symlink_ancestors_fail_capture(self):
        (self.workspace / 'sample.py').unlink()
        self.stage()
        self.assertEqual(self.values['steps.capture.outputs.status'], '1')
        (self.workspace / 'elsewhere').write_text('first\nold\nlast\n')
        (self.workspace / 'sample.py').symlink_to('elsewhere')
        self.stage()
        self.assertEqual(self.values['steps.capture.outputs.status'], '1')

    def test_context_commit_cannot_be_claimed_for_unrelated_checkout(self):
        self.environment['GITHUB_SHA'] = '0' * 40
        self.stage()
        self.assertEqual(self.values['steps.capture.outputs.status'], '1')

    def test_fork_head_and_merge_have_explicit_source_identity(self):
        commit = self.environment['GITHUB_SHA']
        with patch.dict(os.environ, {'GITHUB_REPOSITORY': 'example/base', 'GITHUB_SHA': '1' * 40,
                                    'COVERAGE_HEAD_SHA': commit, 'COVERAGE_HEAD_REPOSITORY': 'contributor/fork'}):
            self.assertEqual(sources.context_identity(commit), 'contributor/fork')
            self.assertEqual(sources.context_identity('1' * 40), 'example/base')

    def test_no_manifest_repository_can_choose_fetch_target(self):
        self.baseline_snapshot()
        path = self.baseline / 'sources.json'
        data = json.loads(path.read_text())
        data['repository'] = 'another/repository'
        path.write_text(json.dumps(data))
        with patch('sources.trusted_objects') as network:
            with self.assertRaises(ValueError):
                sources.materialize(self.baseline / 'coverage.xml', path, self.root / 'materialized', 'example/consumer', provider=network)
            network.assert_not_called()

    def test_fetch_is_bounded_https_and_never_inherits_credentials_or_git_commands(self):
        environment = {'GITHUB_WORKSPACE': str(self.workspace), 'GITHUB_REPOSITORY': 'example/consumer',
                       'GITHUB_SHA': '', 'COVERAGE_BASE_SHA': '', 'COVERAGE_HEAD_REPOSITORY': '',
                       'GIT_CONFIG_PARAMETERS': 'unsafe config', 'GIT_SSH_COMMAND': 'unsafe command'}
        calls = []
        def run(command, **kwargs):
            calls.append((command, kwargs))
            if 'fetch' in command:
                raise subprocess.TimeoutExpired(command, 120)
            return subprocess.CompletedProcess(command, 0, b'', b'')
        with patch.dict(os.environ, environment), patch('sources.subprocess.run', side_effect=run):
            with self.assertRaises(subprocess.TimeoutExpired):
                with sources.trusted_objects('example/consumer', '1' * 40):
                    self.fail('Unavailable sources must fail')
        command, options = calls[-1]
        self.assertEqual(command[-2:], ['https://github.com/example/consumer.git', '1' * 40])
        self.assertEqual(options['timeout'], 120)
        self.assertEqual(options['env']['GIT_NO_LAZY_FETCH'], '1')
        self.assertNotIn('GIT_SSH_COMMAND', options['env'])
        self.assertNotIn('GIT_CONFIG_PARAMETERS', options['env'])
        self.assertIn('protocol.allow=never', command)
        self.assertIn('http.followRedirects=false', command)

    def test_actual_git_blob_access_never_executes_hooks_or_source(self):
        sentinel = self.workspace / 'executed'
        hook = self.workspace / '.git/hooks/post-checkout'
        hook.write_text('#!/bin/sh\ntouch executed\n')
        hook.chmod(0o755)
        objects = sources.GitObjects(self.workspace, self.environment['GITHUB_SHA'])
        self.assertEqual(objects.source('sample.py')[1], b'first\nold\nlast\n')
        self.assertFalse(sentinel.exists())
        with self.assertRaises(ValueError):
            objects.source('missing.py')
        with self.assertRaises(ValueError):
            sources.GitObjects(self.workspace, '0' * 40)

    def test_canonicalization_preserves_branch_line_hits_and_only_numeric_metadata(self):
        tree = ET.fromstring('<coverage line-rate="0.5" branch-rate="0.5" timestamp="private" producer="private"><sources><source>/machine/root</source></sources><packages><package name="private"><classes><class name="private_method" filename="sample.py" line-rate="0.5"><methods><method name="private_method"/></methods><lines><line number="1" hits="17" branch="true" condition-coverage="50% (1/2)" secret="private"><conditions><condition number="0" type="jump" coverage="50%"/></conditions></line><line number="2" hits="0"/></lines></class></classes></package></packages></coverage>')
        result = sources.canonical_xml(tree, {'sample.py': 'sample.py'})
        clean = ET.fromstring(result)
        self.assertNotIn(b'private', result)
        self.assertNotIn(b'/machine', result)
        before = tree.findall('.//class/lines/line')
        after = clean.findall('.//class/lines/line')
        self.assertEqual(len(before), len(after))
        for left, right in zip(before, after):
            self.assertEqual({k: v for k, v in left.attrib.items() if k != 'secret'}, right.attrib)
            self.assertEqual([n.attrib for n in left.findall('./conditions/condition')], [n.attrib for n in right.findall('./conditions/condition')])

    def test_shallow_clone_requires_pinned_fetch_for_missing_parent(self):
        old = self.environment['GITHUB_SHA']
        self.source('first\nchanged\nlast\n')
        shallow = self.root / 'shallow'
        self.git(self.root, 'clone', '--depth=1', self.workspace.as_uri(), str(shallow))
        with patch.dict(os.environ, {'GITHUB_WORKSPACE': str(shallow), 'GITHUB_REPOSITORY': 'example/consumer',
                                    'GITHUB_SHA': self.environment['GITHUB_SHA'], 'COVERAGE_BASE_SHA': '', 'COVERAGE_HEAD_REPOSITORY': ''}):
            original = sources.git
            def no_network(root, *args):
                if args[0] == 'fetch':
                    self.assertEqual(args[-1], old)
                    raise ValueError('Unavailable immutable commit')
                return original(root, *args)
            with patch('sources.git', side_effect=no_network), self.assertRaises(ValueError):
                with sources.trusted_objects('example/consumer', old):
                    self.fail('Missing commit was accepted')

    def test_migration_requires_verified_blobs_not_xml_or_self_asserted_legacy(self):
        self.stage()
        xml = self.workspace / 'coverage.xml'
        contents = (self.workspace / 'sample.py').read_bytes()
        legacy = self.root / 'legacy.json'
        data = {'version': 1, 'repository': 'example/consumer', 'commit': self.environment['GITHUB_SHA'],
                'report_sha256': sources.digest(xml.read_bytes()), 'sources': {'sample.py': {'path': 'sample.py', 'sha256': sources.digest(contents), 'text': contents.decode()}}}
        legacy.write_text(json.dumps(data))
        target = self.root / 'migrated/sources.json'
        sources.migrate(xml, legacy, target, 'example/consumer', data['commit'], self.workspace)
        self.assertEqual(json.loads(target.read_text())['version'], 2)
        data['sources']['sample.py']['text'] = 'forged'
        data['sources']['sample.py']['sha256'] = sources.digest(b'forged')
        legacy.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            sources.migrate(xml, legacy, target, 'example/consumer', data['commit'], self.workspace)

    def test_yaml_contains_no_embedded_shell_logic(self):
        for step in self.metadata['runs']['steps']:
            if 'run' in step:
                self.assertNotIn('\n', step['run'].strip())
                self.assertRegex(step['run'], r'^python3 "\$COVERAGE_(WORKFLOW|HELPER|PUBLISHER)"')

    def test_preflight_rejects_storage_traversal_and_existing_workspaces(self):
        self.values['inputs.diff-storage'] = '../outside'
        self.run_step('Validate action destinations', 1)
        self.values['inputs.diff-storage'] = '_xml_coverage_reports'
        self.run_step('Validate action destinations', 1)
        shutil.rmtree(self.storage)
        self.run_step('Validate action destinations')
        (self.workspace / 'coverage-action').symlink_to(self.root)
        self.run_step('Validate action destinations', 1)

    def test_storage_initialization_reads_raw_blobs_without_smudge_or_hooks(self):
        remote = self.root / 'initialization.git'
        self.git(self.root, 'init', '--bare', str(remote))
        self.git(remote, 'config', 'core.hooksPath', os.devnull)
        self.git(self.storage, 'remote', 'add', 'origin', str(remote))
        (self.storage / '.gitattributes').write_text('*.txt filter=probe\n')
        (self.storage / 'data/retained.txt').write_text('retained bytes\n')
        self.git(self.storage, 'add', '.')
        self.git(self.storage, 'commit', '-m', 'Stored bytes')
        self.git(self.storage, 'push', 'origin', '_xml_coverage_reports')
        self.git(self.storage, 'remote', 'set-url', 'origin', 'https://github.com/example/consumer.git')
        self.git(self.storage, 'config', 'filter.probe.smudge', 'touch executed')
        real_git = workflow.publish.git
        def local_transport(directory, *arguments):
            if arguments[0] in ('fetch', 'ls-remote'):
                arguments = tuple(str(remote) if x == 'origin' else x for x in arguments)
            return real_git(directory, *arguments)
        environment = dict(self.environment, COVERAGE_INPUTS_DIFF_STORAGE='_xml_coverage_reports', COVERAGE_PUBLICATION_STATE=str(self.root / 'state.json'))
        with patch.dict(os.environ, environment), patch('workflow.publish.git', side_effect=local_transport):
            workflow.initialize()
        self.assertEqual((self.storage / 'data/retained.txt').read_text(), 'retained bytes\n')
        self.assertFalse((self.storage / 'executed').exists())
        self.assertEqual(self.git(self.storage, 'status', '--porcelain'), '')

    def test_report_only_does_not_reuse_a_stale_manifest(self):
        self.stage()
        self.values['inputs.skip-diff-storage'] = 'true'
        self.values['steps.capture.outputs.status'] = ''
        self.report([1, 1, 1])
        self.run_step('Generate text report')
        self.run_step('Get total')
        self.assertEqual((self.workspace / '.coverage-total').read_text().strip(), '100.00000000')

    def test_duplicate_manifest_fields_are_rejected(self):
        with self.assertRaises(ValueError):
            sources.manifest_json('{"version":1,"version":2}')

    def test_fork_capture_cannot_claim_the_base_repository(self):
        self.baseline_snapshot()
        self.environment['GITHUB_SHA'] = '1' * 40
        self.values['github.event.pull_request.head.sha'] = self.git(self.workspace, 'rev-parse', 'HEAD').strip()
        self.values['github.event.pull_request.head.repo.full_name'] = 'contributor/fork'
        self.values['github.event.pull_request.base.sha'] = self.values['github.event.pull_request.head.sha']
        self.stage()
        path = self.workspace / 'coverage-action/sources.json'
        data = json.loads(path.read_text())
        self.assertEqual(data['repository'], 'contributor/fork')
        self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        self.assertEqual(self.values['steps.comparison.outputs.status'], '0')
        data['repository'] = 'example/consumer'
        path.write_text(json.dumps(data))
        self.run_step('Generate diff against ${{ inputs.diff-branch }}')
        self.assertEqual(self.values['steps.comparison.outputs.status'], '1')

    def test_publisher_rejects_a_different_push_repository(self):
        self.git(self.storage, 'remote', 'add', 'origin', 'https://github.com/example/consumer.git')
        self.git(self.storage, 'remote', 'set-url', '--push', 'origin', 'https://github.com/another/repository.git')
        with patch.dict(os.environ, {'COVERAGE_EXPECTED_REPOSITORY': 'example/consumer'}):
            with self.assertRaises(workflow.publish.PublicationError):
                workflow.publish.publish(self.storage, '_xml_coverage_reports', 1)

    def test_partial_clone_cannot_implicitly_fetch_using_checkout_credentials(self):
        self.git(self.workspace, 'config', 'remote.cache.promisor', 'true')
        with self.assertRaises(ValueError):
            sources.GitObjects(self.workspace, self.environment['GITHUB_SHA'])


if __name__ == '__main__':
    unittest.main()
