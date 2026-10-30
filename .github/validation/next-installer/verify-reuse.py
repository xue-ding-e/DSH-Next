"""Verify an immutable prior artifact; never execute its binaries or grant qualification."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import subprocess
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(stream):
    h = hashlib.sha256()
    while chunk := stream.read(1024 * 1024):
        h.update(chunk)
    return h.hexdigest()


def validate_metadata(m, run, artifact):
    for key, value in {'id': m['priorRun'], 'run_attempt': m['priorAttempt'],
                       'head_sha': m['priorControl'], 'head_branch': m['priorBranch'],
                       'event': 'workflow_dispatch', 'status': 'completed',
                       'conclusion': m['priorConclusion'], 'workflow_id': 400043182,
                       'path': '.github/workflows/next-context-menu-validation.yml'}.items():
        require(run.get(key) == value, 'Prior run mismatch: ' + key)
    require(run['repository']['id'] == m['repositoryId'] and
            run['repository']['full_name'] == m['repository'], 'Foreign repository')
    for key, value in {'id': m['artifactId'], 'name': m['artifactName'],
                       'size_in_bytes': m['artifactBytes'], 'expired': False,
                       'digest': 'sha256:' + m['artifactSha256']}.items():
        require(artifact.get(key) == value, 'Artifact mismatch: ' + key)
    for key, value in {'id': m['priorRun'], 'repository_id': m['repositoryId'],
                       'head_repository_id': m['repositoryId'],
                       'head_sha': m['priorControl']}.items():
        require(artifact['workflow_run'].get(key) == value, 'Artifact run mismatch: ' + key)


def validate_inventory(m, infos):
    names = [i.filename for i in infos]
    require(len(names) == len(set(names)), 'Duplicate archive entry')
    require(set(names) == set(m['files']), 'Archive inventory drift')
    require(len(m['extractFiles']) == len(set(m['extractFiles'])) == 3,
            'Expected baseline installer, attestation and official identity')
    require(set(m['extractFiles']).issubset(names), 'Missing selected input')
    for i in infos:
        p = PurePosixPath(i.filename)
        require(not p.is_absolute() and '..' not in p.parts and '\\' not in i.filename
                and ':' not in i.filename and len(p.parts) == 1 and not i.is_dir(),
                'Only flat reviewed archive members are allowed')
        require(not stat.S_ISLNK(i.external_attr >> 16), 'Archive symlink refused')
        require(i.file_size == m['files'][i.filename]['bytes'], 'Member size drift')
        require(i.file_size <= 400 * 1024 * 1024, 'Oversized archive member')
    require(sum(i.file_size for i in infos) <= 800 * 1024 * 1024, 'Archive expansion budget')


def verify_archive(m, archive):
    require(archive.stat().st_size == m['artifactBytes'], 'ZIP size drift')
    with archive.open('rb') as f:
        require(digest(f) == m['artifactSha256'], 'ZIP SHA256 drift')
    with zipfile.ZipFile(archive) as z:
        validate_inventory(m, z.infolist())
        for i in z.infolist():
            with z.open(i) as f:
                require(digest(f) == m['files'][i.filename]['sha256'], 'Member SHA256 drift: ' + i.filename)
        result = json.loads(z.read('result.json'))
        require(result['source'] == m['source'] and result['tree'] == m['tree'] and
                result['control'] == m['priorControl'], 'Prior result identity mismatch')
        require(result['qualified'] is False and result['failure'] == 'Next protocol registration is missing.',
                'Do not reinterpret prior qualification')
        expected = ['desktop-tests', 'smoke-profile-tests', 'browser-cookie-tests',
                    'extensions-browser-control', 'extensions-nav-buttons', 'extensions-input-guard',
                    'package-v1-preflight', 'package-v1', 'package-v2-preflight', 'package-v2']
        require([s['label'] for s in result['stages']] == expected, 'Prior completed-stage inventory drift')
        for s in result['stages']:
            r = s['result']
            require(r['exitCode'] == 0 and r['quiescenceConfirmed'] is True and
                    r['timedOut'] is False and r['outputExceeded'] is False, 'Prior stage was not accepted')
        for package in m['packages']:
            require(m['files'][package['filename']]['sha256'] == package['sha256'], 'Installer pin mismatch')
            a = json.loads(z.read(package['attestation']))
            require(a['source'] == m['source'] and a['version'] == package['version'] and
                    a['repositoryId'] == m['repositoryId'] and a['actualPackagedElectron'] is True and
                    a['dirty'] is False, 'Prior package attestation mismatch')
    return {'zipVerified': True, 'memberCount': len(m['files']), 'priorQualified': False,
            'scope': 'Verified reusable package bytes only; runtime and lifecycle remain unqualified'}


def extract_inputs(m, archive, output):
    # Exclusive directory creation prevents merging with another run or following an existing directory link.
    output.mkdir(parents=False, exist_ok=False)
    with zipfile.ZipFile(archive) as z:
        for name in m['extractFiles']:
            with z.open(name) as source, (output / name).open('xb') as target:
                while chunk := source.read(1024 * 1024):
                    target.write(chunk)
            with (output / name).open('rb') as f:
                require(digest(f) == m['files'][name]['sha256'], 'Extracted member mismatch')
    index = [{'source': m['source'], 'version': p['version'], 'sha256': p['sha256'],
              'installer': str((output / p['filename']).resolve()),
              'attestation': str((output / p['attestation']).resolve())} for p in m['packages']]
    (output / 'packages.json').write_text(json.dumps(index, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    for name in ['manifest', 'archive', 'run', 'artifact', 'product', 'output']:
        parser.add_argument('--' + name, required=True, type=Path)
    a = parser.parse_args()
    m = json.loads(a.manifest.read_text())
    require(m['executionAuthorized'] is True, 'Pending user actions:read approval and reviewed runtime control; execution is disabled')
    validate_metadata(m, json.loads(a.run.read_text()), json.loads(a.artifact.read_text()))
    def git(*args):
        return subprocess.check_output(['git', '-C', str(a.product), *args], text=True, timeout=10).strip()
    require(git('rev-parse', 'HEAD') == m['source'] and git('rev-parse', 'HEAD^{tree}') == m['tree'], 'Product source mismatch')
    require(not git('status', '--porcelain', '--untracked-files=all'), 'Product checkout is not clean')
    result = verify_archive(m, a.archive)
    extract_inputs(m, a.archive, a.output)
    (a.output / 'reuse-receipt.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
