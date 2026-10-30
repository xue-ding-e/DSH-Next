"""Download the sealed existing V2 inputs; the enclosing native owner controls gh."""
import argparse
import importlib.util
import json
import os
from pathlib import Path

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('transport', HERE / 'download-reuse.py')
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


def main():
    parser = argparse.ArgumentParser()
    for field in ['gh', 'manifest', 'output']:
        parser.add_argument('--' + field, required=True, type=Path)
    a = parser.parse_args()
    m = json.loads(a.manifest.read_text())
    if m.get('sealed') is not True:
        raise ValueError('Unsealed V2 artifact request')
    if os.name != 'nt' or os.environ.get('GITHUB_REPOSITORY_ID') != '1437727533' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise ValueError('Only disposable hosted Windows is supported')
    if not a.gh.is_absolute() or not a.gh.is_file() or a.gh.name.lower() != 'gh.exe':
        raise ValueError('Absolute hosted gh.exe required')
    root = Path(os.environ['RUNNER_TEMP']).resolve()
    output = a.output.resolve()
    if not output.is_relative_to(root) or output == root:
        raise ValueError('Output must be a new RUNNER_TEMP child')
    if m['repository'] != 'xue-ding-e/DSH-Next' or m['priorRun'] != 41134150680 or m['priorAttempt'] != 1:
        raise ValueError('Wrong fixed artifact request')
    output.mkdir(exist_ok=False)
    prefix = 'repos/xue-ding-e/DSH-Next/'
    transport.fetch(a.gh, prefix + 'actions/runs/41134150680', output / 'run.json', 1024 * 1024, 30)
    transport.fetch(a.gh, prefix + 'actions/runs/41134150680/attempts/1/jobs', output / 'jobs.json', 1024 * 1024, 30)
    for kind in ['candidate', 'qualification']:
        artifact = m[kind]['artifactId']
        if not isinstance(artifact, int) or artifact <= 0:
            raise ValueError('Invalid artifact ID')
        endpoint = prefix + 'actions/artifacts/' + str(artifact)
        transport.fetch(a.gh, endpoint, output / (kind + '.json'), 1024 * 1024, 30)
        transport.fetch(a.gh, endpoint + '/zip', output / (kind + '.zip'), 700 * 1024 * 1024, 300)


if __name__ == '__main__':
    main()
