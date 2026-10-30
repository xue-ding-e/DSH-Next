"""Download only the fixed reviewed run's inputs under the enclosing native JobObject."""
import argparse
import os
from pathlib import Path
import subprocess
import time


def fetch(gh, endpoint, target, limit, seconds):
    error_path = target.with_suffix(target.suffix + '.stderr')
    error_limit = 1024 * 1024
    with target.open('xb') as output, error_path.open('xb') as error:
        child = subprocess.Popen([str(gh), 'api', '--hostname', 'github.com', endpoint],
                                 stdout=output, stderr=error, shell=False)
        deadline = time.monotonic() + seconds
        while child.poll() is None:
            if time.monotonic() > deadline or target.stat().st_size > limit or error_path.stat().st_size > error_limit:
                # Exit without starting another child. The enclosing JobObject owns
                # this process and gh and must confirm termination before continuing.
                raise RuntimeError('Artifact transport exceeded its fixed budget')
            time.sleep(0.1)
        if child.returncode != 0 or not 0 < target.stat().st_size <= limit or error_path.stat().st_size > error_limit:
            raise RuntimeError('Artifact transport failed; no retry or qualification')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--gh', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if os.name != 'nt' or os.environ.get('GITHUB_REPOSITORY_ID') != '1437727533' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise RuntimeError('Only the disposable hosted DSH Windows runner is supported')
    if not args.gh.is_absolute() or not args.gh.is_file() or args.gh.name.lower() != 'gh.exe':
        raise RuntimeError('Expected the hosted absolute gh executable')
    root = Path(os.environ['RUNNER_TEMP']).resolve()
    output = args.output.resolve()
    if not output.is_relative_to(root) or output == root:
        raise RuntimeError('Transport directory must be a new child of RUNNER_TEMP')
    output.mkdir(exist_ok=False)
    prefix = 'repos/xue-ding-e/DSH-Next/'
    fetch(args.gh, prefix + 'actions/runs/40892180960', output / 'run.json', 1024 * 1024, 30)
    fetch(args.gh, prefix + 'actions/artifacts/12906628819', output / 'artifact.json', 1024 * 1024, 30)
    fetch(args.gh, prefix + 'actions/artifacts/12906628819/zip', output / 'artifact.zip', 700 * 1024 * 1024, 300)
    print('Fixed artifact downloaded; content verification and qualification are still required')


if __name__ == '__main__':
    main()
