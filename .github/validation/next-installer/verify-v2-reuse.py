"""Verify fixed build bytes for a lifecycle retry; never grant lifecycle qualification."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import stat
import subprocess
import zipfile

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('baseline', HERE / 'verify-reuse.py')
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)
require = baseline.require
digest = baseline.digest


def read_json(data):
    return json.loads(data.decode('utf-8-sig'))


def verify_zip(pin, archive):
    require(archive.stat().st_size == pin['artifactBytes'], 'ZIP size drift')
    with archive.open('rb') as stream:
        require(digest(stream) == pin['artifactSha256'], 'ZIP digest drift')
    with zipfile.ZipFile(archive) as z:
        infos = z.infolist()
        require(len(infos) == len({i.filename for i in infos}), 'Duplicate ZIP entry')
        require({i.filename for i in infos} == set(pin['files']), 'ZIP inventory drift')
        require(sum(i.file_size for i in infos) <= 800 * 1024 * 1024, 'ZIP expansion limit')
        for i in infos:
            path = PurePosixPath(i.filename)
            require(not path.is_absolute() and '..' not in path.parts and '\\' not in i.filename and ':' not in i.filename, 'Unsafe ZIP path')
            require(not stat.S_ISLNK(i.external_attr >> 16), 'ZIP symlink refused')
            require(i.file_size == pin['files'][i.filename]['bytes'] and i.file_size <= 400 * 1024 * 1024, 'ZIP member size drift')
            with z.open(i) as stream:
                require(digest(stream) == pin['files'][i.filename]['sha256'], 'ZIP member digest drift')


def validate_jobs(jobs):
    require(jobs['total_count'] == len(jobs['jobs']) == 1, 'Unexpected original job inventory')
    job = jobs['jobs'][0]
    require(job.get('run_id') == 41134150680 and job.get('head_sha') == '8bc2d508372d608415cc49a7910310ee45494de6', 'Original job identity differs')
    require(job['status'] == 'completed', 'Original Windows job is not terminal')
    builds = [s for s in job['steps'] if s['name'] == 'Test fixed source and build only new V2']
    require(len(builds) == 1 and builds[0]['conclusion'] == 'success', 'Original V2 build step did not succeed')


def accepted_command(result, allow_compiler=False):
    require(result['exitCode'] == 0 and result['timedOut'] is False and result['outputExceeded'] is False and result['quiescenceConfirmed'] is True, 'Prior command did not complete')
    if result['naturalQuiescence'] is True:
        require(result['rootExitGraceExceeded'] is False and result['terminationReason'] is None and result['toolCleanup'] is None, 'Contradictory natural receipt')
    else:
        tool = result.get('toolCleanup') or {}
        require(allow_compiler and result['naturalQuiescence'] is False and result['terminationReason'] == 'verified-tool-cleanup', 'Unexpected forced cleanup')
        require(tool.get('status') == 'completed-with-verified-tool-cleanup' and tool.get('error') is None and tool.get('attempted') is True and tool.get('terminated') is True and tool.get('exitCode') == 125 and tool.get('jobEmpty') is True and tool.get('inventoryVerificationFailed') is False, 'Incomplete compiler cleanup')


def validate_build(m, candidate, qualification):
    read_candidate = lambda role: read_json(candidate(m['candidateInputs'][role]))
    read_qualification = lambda role: read_json(qualification(m['qualificationInputs'][role]))
    result = read_candidate('result')
    require(result == read_qualification('result'), 'Candidate and qualification result differ')
    require(result['source'] == m['source'] and result['tree'] == m['tree'] and result['control'] == m['priorControl'] and str(result['repositoryId']) == str(m['repositoryId']), 'Original build identity mismatch')
    require(result['buildQualified'] is True and result['qualified'] is False and result['failure'] is None, 'Real build-only qualification required')
    expected = ['desktop-tests', 'smoke-profile-tests', 'browser-cookie-tests', 'extensions-browser-control', 'extensions-nav-buttons', 'extensions-input-guard', 'package-v2-preflight', 'package-v2']
    require([s['label'] for s in result['stages']] == expected, 'Build stage inventory drift')
    for stage in result['stages']:
        accepted_command(stage['result'], stage['label'] in ['desktop-tests', 'package-v2'])
    packages = read_qualification('packages')
    require(packages == result['packages'] and len(packages) == 2, 'Original package index differs')
    require(packages[0]['source'] == '270dd45091805cb504fdd39bf09d9ec596ca4150' and packages[0]['version'] == '0.2.1-rc.3.20261029.1' and packages[0]['sha256'] == '4246aac2173d65b61a9a9087caf44e941bef8439c3fa2a37eb0458d24e222a10', 'Unknown baseline package')
    require(packages[1]['source'] == m['source'] and packages[1]['version'] == m['version'] and packages[1]['sha256'] == m['installerSha256'], 'New V2 identity differs')
    attestation = read_candidate('attestation')
    require(attestation == read_qualification('attestation'), 'Package attestation differs between archives')
    require(attestation['source'] == m['source'] and attestation['version'] == m['version'] and str(attestation['repositoryId']) == str(m['repositoryId']) and attestation['dirty'] is False and attestation['actualPackagedElectron'] is True and attestation['updateMode'] == 'manual' and attestation['architecture'] == 'x64', 'New V2 attestation mismatch')
    for role in ['config', 'pe']:
        report = read_candidate(role)
        require(report == read_qualification(role), 'Package resource witness differs')
        require(report['source'] == m['source'] and report['version'] == m['version'], 'Package resource identity differs')
    require(read_candidate('pe')['peAttested'] is True, 'PE identity not attested')
    official = read_qualification('officialIdentity')
    require(official['source'] == m['source'] and official['appId'] == 'com.deepseek.dsh', 'Official identity source mismatch')
    for label in ['dependencies', 'official-identity', 'pe-builder', 'next-source-tests', 'next-uninstall-regression', 'electron-dependency', 'package-v2-config-witness', 'package-v2-pe', 'package-v2-attest']:
        accepted_command(read_json(qualification(m['commandInputs'][label])))
    return {'buildBytesVerified': True, 'source': m['source'], 'priorRun': m['priorRun'], 'priorAttempt': m['priorAttempt'], 'priorBuildQualified': True, 'lifecycleQualified': False}


def main():
    parser = argparse.ArgumentParser()
    for name in ['manifest', 'download', 'product', 'baseline', 'output']:
        parser.add_argument('--' + name, required=True, type=Path)
    a = parser.parse_args()
    m = read_json(a.manifest.read_bytes())
    require(m.get('sealed') is True, 'Artifact inventory and digests are not sealed')
    require(m['repository'] == 'xue-ding-e/DSH-Next' and m['repositoryId'] == 1437727533 and m['priorRun'] == 41134150680 and m['priorAttempt'] == 1 and m['priorControl'] == '8bc2d508372d608415cc49a7910310ee45494de6' and m['source'] == '6b9ebe026a565e5aa547811972dff745961e134f' and m['tree'] == '02b0f7781afd8df0e2610127a4382cf8d05cd8e4' and m['version'] == '0.2.1-rc.3.20261029.2', 'Wrong fixed build request')
    run = read_json((a.download / 'run.json').read_bytes())
    validate_jobs(read_json((a.download / 'jobs.json').read_bytes()))
    for kind in ['candidate', 'qualification']:
        baseline.validate_metadata({**m, **m[kind]}, run, read_json((a.download / (kind + '.json')).read_bytes()))
        verify_zip(m[kind], a.download / (kind + '.zip'))
    def git(*args):
        return subprocess.check_output(['git', '-C', str(a.product), *args], text=True, timeout=10).strip()
    require(git('rev-parse', 'HEAD') == m['source'] and git('rev-parse', 'HEAD^{tree}') == m['tree'] and not git('status', '--porcelain', '--untracked-files=all'), 'Exact clean product checkout required')
    with zipfile.ZipFile(a.download / 'candidate.zip') as candidate, zipfile.ZipFile(a.download / 'qualification.zip') as qualification:
        receipt = validate_build(m, candidate.read, qualification.read)
        installer_name = m['candidateInputs']['installer']
        require(m['candidate']['files'][installer_name]['sha256'] == m['installerSha256'], 'Installer SHA mismatch')
        prior = read_json((a.baseline / 'packages.json').read_bytes())
        require(len(prior) == 1 and prior[0]['source'] == '270dd45091805cb504fdd39bf09d9ec596ca4150' and prior[0]['version'] == '0.2.1-rc.3.20261029.1' and prior[0]['sha256'] == '4246aac2173d65b61a9a9087caf44e941bef8439c3fa2a37eb0458d24e222a10', 'Verified baseline index required')
        # Create a new evidence directory; never trust or follow paths from the old run.
        a.output.mkdir(exist_ok=False)
        for field in ['installer', 'attestation']:
            source = Path(prior[0][field]).resolve()
            require(source.is_relative_to(a.baseline.resolve()) and source.is_file(), 'Baseline path escape')
            target = a.output / source.name
            with source.open('rb') as src, target.open('xb') as dst:
                while part := src.read(1024 * 1024): dst.write(part)
            prior[0][field] = str(target.resolve())
        with Path(prior[0]['installer']).open('rb') as src:
            require(digest(src) == prior[0]['sha256'], 'Baseline copy changed')
        for role, destination in [('installer', installer_name), ('attestation', 'package-v2.json'), ('config', 'package-v2-config-witness.json'), ('pe', 'package-v2-pe.json')]:
            require(PurePosixPath(destination).name == destination, 'Non-flat output refused')
            with candidate.open(m['candidateInputs'][role]) as src, (a.output / destination).open('xb') as dst:
                while part := src.read(1024 * 1024): dst.write(part)
        with (a.output / installer_name).open('rb') as src:
            require(digest(src) == m['installerSha256'], 'Extracted V2 bytes changed')
        (a.output / 'official-identity.json').write_bytes(qualification.read(m['qualificationInputs']['officialIdentity']))
        prior.append({'source': m['source'], 'version': m['version'], 'sha256': m['installerSha256'], 'installer': str((a.output / installer_name).resolve()), 'attestation': str((a.output / 'package-v2.json').resolve())})
        (a.output / 'packages.json').write_text(json.dumps(prior, indent=2) + '\n')
        (a.output / 'build-reuse-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    main()
