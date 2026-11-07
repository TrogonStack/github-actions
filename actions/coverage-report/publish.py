import argparse
import os

from sources import repository_name
from pathlib import Path
import subprocess
import sys


class PublicationError(Exception):
    pass


def git(directory: Path, *arguments: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            ["git", "-c", "core.hooksPath=" + os.devnull, "-c", "credential.helper=", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=" + ("never" if os.environ.get("COVERAGE_EXPECTED_REPOSITORY") else "always"), "-c", "http.followRedirects=false", "-C", str(directory), *arguments],
            capture_output=True,
            env={**{k: v for k, v in os.environ.items() if not k.startswith("GIT_CONFIG")}, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1"},
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PublicationError("Coverage storage Git operation could not complete.") from error


def publish(directory: Path, branch: str, attempts: int) -> None:
    expected = os.environ.get('COVERAGE_EXPECTED_REPOSITORY')
    if expected:
        for arguments in (('remote', 'get-url', '--all', 'origin'), ('remote', 'get-url', '--push', '--all', 'origin')):
            remote = git(directory, *arguments)
            destinations = remote.stdout.decode().splitlines()
            if remote.returncode or len(destinations) != 1 or destinations[0].lower().removesuffix('.git') != 'https://github.com/' + repository_name(expected):
                raise PublicationError('Storage repository does not match trusted context.')
    reference = f"refs/heads/{branch}"
    tracking_reference = f"refs/remotes/origin/{branch}"
    if git(directory, "check-ref-format", reference).returncode:
        raise PublicationError("Invalid coverage storage branch.")
    status = git(directory, "status", "--porcelain")
    if status.returncode or status.stdout:
        raise PublicationError("Coverage storage must have a clean committed worktree.")

    for attempt in range(1, attempts + 1):
        result = git(directory, "push", "--atomic", "origin", f"HEAD:{reference}")
        if result.returncode == 0:
            print(f"Coverage storage published on attempt {attempt}.")
            return
        if attempt == attempts:
            break
        print(f"Coverage storage push rejected; refreshing before attempt {attempt + 1}.")
        if git(directory, "fetch", "--no-tags", "origin", f"{reference}:{tracking_reference}").returncode:
            raise PublicationError("Unable to refresh the coverage storage branch.")
        if git(directory, "-c", "rebase.autoStash=false", "rebase", tracking_reference).returncode:
            git(directory, "rebase", "--abort")
            raise PublicationError("Concurrent coverage edits conflict; publication refused.")
    raise PublicationError(f"Coverage storage publication failed after {attempts} attempts.")


def bounded_attempts(value: str) -> int:
    attempts = int(value)
    if not 1 <= attempts <= 10:
        raise argparse.ArgumentTypeError("attempts must be between 1 and 10")
    return attempts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--branch", required=True)
    parser.add_argument("--attempts", type=bounded_attempts, default=5)
    args = parser.parse_args()
    try:
        publish(args.directory, args.branch, args.attempts)
    except PublicationError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
