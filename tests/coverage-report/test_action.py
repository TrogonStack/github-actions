import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

import test_publish


ACTION = Path(__file__).resolve().parents[2] / "actions" / "coverage-report"


def step(name):
    text = (ACTION / "action.yml").read_text()
    return text.split(f"    - name: {name}\n", 1)[1].split("\n    - name:", 1)[0]


def script(name):
    block = step(name)
    value = block.split("      run: ", 1)[1]
    if not value.startswith("|\n"):
        return value.splitlines()[0]
    lines = []
    for line in value.splitlines()[1:]:
        if line and not line.startswith("        "):
            break
        lines.append(line[8:])
    return "\n".join(lines)


class SharedActionTests(unittest.TestCase):
    def test_all_publication_steps_resolve_from_external_action_checkout(self):
        fixture = test_publish.CoveragePublicationTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        installed = fixture.root / "installed actions" / "coverage-report"
        shutil.copytree(ACTION, installed)
        consumer = fixture.root / "consumer"
        consumer.mkdir()
        publisher_steps = [
            "Push storage branch",
            "Push badges",
            "Push XML report to ${{ inputs.diff-storage }}",
        ]
        self.assertEqual((ACTION / "action.yml").read_text().count('run: python3 "$COVERAGE_PUBLISHER"'), len(publisher_steps))
        for index, name in enumerate(publisher_steps):
            with self.subTest(step=name):
                writer = fixture.clone(f"writer-{index}")
                concurrent = fixture.clone(f"concurrent-{index}")
                filename = f"data/writer-{index}/coverage.xml"
                other = f"data/concurrent-{index}/coverage.xml"
                fixture.commit(writer, filename, b"local report\n")
                fixture.commit(concurrent, other, b"concurrent report\n")
                fixture.git(concurrent, "push", "origin", f"HEAD:refs/heads/{test_publish.BRANCH}")
                values = {
                    "github.action_path": str(installed),
                    "inputs.diff-storage": str(writer),
                }
                environment = os.environ.copy()
                for key, expression in re.findall(r"^        (COVERAGE_\w+): (.+)$", step(name), re.M):
                    if key == "COVERAGE_STORAGE_BRANCH":
                        environment[key] = test_publish.BRANCH
                    else:
                        environment[key] = re.sub(r"\$\{\{ (.*?) \}\}", lambda match: values[match[1]], expression)
                result = subprocess.run(["bash", "-e", "-c", script(name)], cwd=consumer, env=environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("attempt 2", result.stdout)
                self.assertEqual(fixture.stored(filename), b"local report\n")
                self.assertEqual(fixture.stored(other), b"concurrent report\n")

    def run_gate(self, name, values, files):
        with tempfile.TemporaryDirectory() as directory:
            for filename, text in files.items():
                (Path(directory) / filename).write_text(text)
            rendered = re.sub(r"\$\{\{ (.*?) \}\}", lambda match: values[match[1]], script(name))
            environment = os.environ.copy()
            for key, expression in re.findall(r"^        (COVERAGE_\w+): (.+)$", step(name), re.M):
                environment[key] = re.sub(r"\$\{\{ (.*?) \}\}", lambda match: values[match[1]], expression)
            command = [sys.executable, "-c"] if name == "Check threshold" else ["bash", "-e", "-o", "pipefail", "-c"]
            result = subprocess.run([*command, rendered], cwd=directory, env=environment, capture_output=True, text=True)
            self.assertFalse((Path(directory) / "injected").exists(), "Input executed as code")
            return result

    def test_comment_and_output_preserve_report_and_literal_inputs(self):
        for visibility, skip, badge in [("public", "false", True), ("private", "false", False), ("public", "true", False)]:
            with self.subTest(visibility=visibility, skip=skip), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                values = {
                    "steps.repository-visibility.outputs.result": visibility,
                    "inputs.skip-diff-storage": skip,
                    "env.diff_storage_branch": "feature/report",
                    "github.repository_owner": "example",
                    "github.event.repository.name": "consumer",
                    "inputs.diff-storage": "_xml_coverage_reports",
                    "inputs.storage-subdirectory": ".",
                    "steps.coverage_percent.outputs.coverage_total": "96.00000000",
                    "inputs.coverage-summary-title": "Coverage $(touch injected)",
                    "inputs.exclude-detailed-coverage": "false",
                    "inputs.togglable-report": "true",
                    "inputs.diff": "true",
                    "inputs.diff-branch": "main",
                    "github.sha": "merge-commit",
                    "github.event_name": "pull_request",
                    "github.event.pull_request.head.sha": "head-commit",
                    "inputs.threshold": "95",
                    "inputs.publish": "true",
                }
                (root / ".coverage-output").write_text("TOTAL 100 4 96%\n")
                (root / ".coverage-output.diff").write_text("coverage diff\n")
                environment = os.environ.copy()
                environment["GITHUB_OUTPUT"] = str(root / "output")
                name = "Generate issue comment body"
                for key, expression in re.findall(r"^        (COVERAGE_\w+): (.+)$", step(name), re.M):
                    environment[key] = re.sub(r"\$\{\{ (.*?) \}\}", lambda match: values[match[1]], expression)
                for name in [name, "Set as output"]:
                    result = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script(name)], cwd=root, env=environment, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                body = (root / ".coverage-output.final").read_text()
                self.assertFalse((root / "injected").exists())
                self.assertIn("Coverage $(touch injected)", body)
                self.assertIn("TOTAL 100 4 96%", body)
                self.assertIn("<details>", body)
                self.assertIn("coverage diff", body)
                self.assertIn("Results for commit: head-commit", body)
                self.assertEqual("![badge]" in body, badge)
                if badge:
                    self.assertIn("feature%2Freport", body)
                output = (root / "output").read_text().splitlines()
                delimiter = output[0].removeprefix("summary<<")
                self.assertEqual(output[-1], delimiter)
                self.assertEqual("\n".join(output[1:-1]), body.rstrip("\n"))

    def test_threshold_input_cannot_execute_python(self):
        value = "0');open('injected','w').write('executed');min=float('0"
        result = self.run_gate("Check threshold", {"inputs.threshold": value}, {".coverage-total": "100"})
        self.assertNotEqual(result.returncode, 0)

    def test_threshold_remains_strict_at_boundary(self):
        for total, expected in [("94.99999999", 1), ("95", 0), ("100", 0)]:
            with self.subTest(total=total):
                result = self.run_gate("Check threshold", {"inputs.threshold": "95"}, {".coverage-total": total})
                self.assertEqual(result.returncode, expected, result.stderr)

    def test_diff_failures_and_explicit_opt_out(self):
        flags = ["uncovered-statements-increase-failure", "new-uncovered-statements-failure", "pycobertura-exception-failure", "coverage-rate-reduction-failure"]
        for status in ["0", "1", "2", "3"]:
            for enabled in [True, False]:
                with self.subTest(status=status, enabled=enabled):
                    values = {f"inputs.{flag}": str(enabled).lower() for flag in flags}
                    values["env.pycobertura_status"] = status
                    result = self.run_gate("Fail if coverage worsened", values, {})
                    self.assertEqual(result.returncode, int(enabled and status != "0"), result.stderr)

    def test_rate_reduction_is_independent_of_diff_exit_status(self):
        for current, baseline, expected in [("96", "97", 1), ("97", "97", 0), ("98", "97", 0)]:
            with self.subTest(current=current):
                values = {"env.pycobertura_status": "0", "inputs.uncovered-statements-increase-failure": "true", "inputs.new-uncovered-statements-failure": "true", "inputs.pycobertura-exception-failure": "true", "inputs.coverage-rate-reduction-failure": "true"}
                result = self.run_gate("Fail if coverage worsened", values, {".coverage-total": current, ".coverage-total.diff-branch": baseline})
                self.assertEqual(result.returncode, expected, result.stderr)


if __name__ == "__main__":
    unittest.main()
