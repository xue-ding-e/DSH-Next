import copy
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('v2', HERE / 'verify-v2-reuse.py')
v2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v2)


def command():
    return dict(exitCode=0, timedOut=False, outputExceeded=False, quiescenceConfirmed=True,
                naturalQuiescence=True, rootExitGraceExceeded=False, terminationReason=None, toolCleanup=None)


def fixture():
    m = dict(source='6b9ebe026a565e5aa547811972dff745961e134f', tree='c'*40, priorControl='d'*40,
             repositoryId=1437727533, version='0.2.1-rc.3.20261029.2', installerSha256='b'*64,
             priorRun=41134150680, priorAttempt=1)
    c, q = {}, {}
    def put(role, value, both=True):
        c[role] = json.dumps(value).encode()
        if both: q[role] = c[role]
    packages = [dict(source='270dd45091805cb504fdd39bf09d9ec596ca4150', version='0.2.1-rc.3.20261029.1', sha256='4246aac2173d65b61a9a9087caf44e941bef8439c3fa2a37eb0458d24e222a10'),
                dict(source=m['source'], version=m['version'], sha256=m['installerSha256'])]
    labels = ['desktop-tests', 'smoke-profile-tests', 'browser-cookie-tests', 'extensions-browser-control', 'extensions-nav-buttons', 'extensions-input-guard', 'package-v2-preflight', 'package-v2']
    put('result', dict(source=m['source'], tree=m['tree'], control=m['priorControl'], repositoryId=m['repositoryId'],
                      buildQualified=True, qualified=False, failure=None, packages=packages,
                      stages=[dict(label=label, result=command()) for label in labels]))
    put('packages', packages)
    put('attestation', dict(source=m['source'], version=m['version'], repositoryId=m['repositoryId'], dirty=False,
                            actualPackagedElectron=True, updateMode='manual', architecture='x64'))
    for role in ['config', 'pe']: put(role, dict(source=m['source'], version=m['version'], peAttested=True))
    put('officialIdentity', dict(source=m['source'], appId='com.deepseek.dsh'))
    m['candidateInputs'] = {k:k for k in c}
    m['qualificationInputs'] = {k:k for k in q}
    labels = ['dependencies', 'official-identity', 'pe-builder', 'next-source-tests', 'next-uninstall-regression', 'electron-dependency', 'package-v2-config-witness', 'package-v2-pe', 'package-v2-attest']
    m['commandInputs'] = {k:k for k in labels}
    for label in labels: q[label] = json.dumps(command()).encode()
    return m, c, q


class Reuse(unittest.TestCase):
    def test_only_build_is_qualified(self):
        m,c,q=fixture(); r=v2.validate_build(m,c.__getitem__,q.__getitem__)
        self.assertTrue(r['priorBuildQualified']); self.assertFalse(r['lifecycleQualified'])

    def test_build_result_false_missing_failed_and_old_source_refused(self):
        for field, value in [('buildQualified',False),('qualified',True),('failure','incomplete'),('source','old'),('tree','old'),('control','old')]:
            m,c,q=fixture(); r=json.loads(c['result']); r[field]=value
            c['result']=q['result']=json.dumps(r).encode()
            with self.assertRaises(ValueError): v2.validate_build(m,c.__getitem__,q.__getitem__)

    def test_missing_or_contradictory_evidence_refused(self):
        m,c,q=fixture(); q['result']=b'{}'
        with self.assertRaises(ValueError): v2.validate_build(m,c.__getitem__,q.__getitem__)
        for role in list(fixture()[2]):
            m,c,q=fixture(); del q[role]
            with self.assertRaises((ValueError,KeyError)): v2.validate_build(m,c.__getitem__,q.__getitem__)

    def test_command_timeout_unknown_cleanup_and_forced_runtime_refused(self):
        for field,value in [('timedOut',True),('outputExceeded',True),('quiescenceConfirmed',False),('exitCode',1),('naturalQuiescence',False),('rootExitGraceExceeded',True),('terminationReason','forced')]:
            r=command();r[field]=value
            with self.assertRaises(ValueError):v2.accepted_command(r)

    def test_run_must_have_completed_successful_build_step(self):
        jobs={'total_count':1,'jobs':[{'run_id':41134150680,'head_sha':'8bc2d508372d608415cc49a7910310ee45494de6','status':'completed','steps':[{'name':'Test fixed source and build only new V2','conclusion':'success'}]}]}
        v2.validate_jobs(jobs)
        for value in ['failure','skipped','cancelled',None]:
            x=copy.deepcopy(jobs);x['jobs'][0]['steps'][0]['conclusion']=value
            with self.assertRaises(ValueError):v2.validate_jobs(x)
        x=copy.deepcopy(jobs);x['jobs'][0]['status']='in_progress'
        with self.assertRaises(ValueError):v2.validate_jobs(x)


class Archive(unittest.TestCase):
    def test_unsealed_requests_stop_before_transport_or_file_inputs(self):
        import subprocess
        import tempfile
        import sys
        with tempfile.TemporaryDirectory() as directory:
            manifest=Path(directory)/'manifest.json';manifest.write_text('{"sealed":false}')
            for script,fields in [('verify-v2-reuse.py',['download','product','baseline','output']),('download-v2-reuse.py',['gh','output'])]:
                args=[sys.executable,'-B',str(HERE/script),'--manifest',str(manifest)]
                for field in fields:args.extend(['--'+field,str(Path(directory)/'absent')])
                result=subprocess.run(args,capture_output=True,text=True,timeout=10)
                self.assertNotEqual(result.returncode,0)
                self.assertIn('sealed',result.stderr.lower())

    def test_native_test_directory_is_preserved_and_lifecycle_allocates_exclusively(self):
        import tempfile
        native=(HERE/'windows-path-guard.test.ps1').read_text()
        self.assertIn("Join-Path $temporary 'dsh-next-installer-evidence/windows'",native)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'dsh-next-installer-evidence';native_root=root/'windows'
            native_root.mkdir(parents=True);receipt=native_root/'path-guard-native.json';receipt.write_bytes(b'{"passed":true}')
            with self.assertRaises(FileExistsError):v2.create_output_directory(native_root)
            output=root/'reused-windows';v2.create_output_directory(output)
            self.assertTrue(output.is_dir());self.assertEqual(receipt.read_bytes(),b'{"passed":true}')
            with self.assertRaises(FileExistsError):v2.create_output_directory(output)
            self.assertEqual(receipt.read_bytes(),b'{"passed":true}')

    def test_inventory_digest_and_unsafe_paths_fail_closed(self):
        import hashlib
        import tempfile
        import zipfile
        with tempfile.TemporaryDirectory() as directory:
            archive=Path(directory)/'artifact.zip'
            with zipfile.ZipFile(archive,'w') as z: z.writestr('result.json', b'{}')
            pin={'artifactBytes':archive.stat().st_size,'artifactSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),
                 'files':{'result.json':{'bytes':2,'sha256':hashlib.sha256(b'{}').hexdigest()}}}
            v2.verify_zip(pin,archive)
            for mutate in [lambda x:x.update(artifactBytes=0),lambda x:x.update(artifactSha256='0'*64),
                           lambda x:x['files'].update(extra={'bytes':0,'sha256':'0'*64}),
                           lambda x:x['files']['result.json'].update(sha256='0'*64)]:
                bad=copy.deepcopy(pin);mutate(bad)
                with self.assertRaises(ValueError):v2.verify_zip(bad,archive)
            with zipfile.ZipFile(archive,'w') as z:z.writestr('../result.json',b'{}')
            pin.update(artifactBytes=archive.stat().st_size,artifactSha256=hashlib.sha256(archive.read_bytes()).hexdigest())
            pin['files']={'../result.json':pin['files']['result.json']}
            with self.assertRaises(ValueError):v2.verify_zip(pin,archive)

    def test_workflow_has_no_build_and_preserves_full_lifecycle(self):
        workflow=(HERE.parents[1]/'workflows/next-context-menu-validation.yml').read_text()
        for forbidden in ['pnpm/action-setup','-Mode qualify','-Mode install-dependencies','contents: write','gh release']:
            self.assertNotIn(forbidden,workflow)
        for required in ['linux-evidence.mjs','verify-reuse.py','verify-v2-reuse.py','windows-installer.ps1','verify-v2-reuse.test.py']:
            self.assertIn(required,workflow)
        self.assertLess(workflow.index('linux-evidence.mjs'),workflow.index('Download fixed V1'))
        self.assertLess(workflow.index('verify-v2-reuse.py --manifest'),workflow.index('& control/.github/validation/next-installer/windows-installer.ps1'))
        # Native path-guard tests already own windows/. Extraction must not merge into it.
        output='--output "$env:RUNNER_TEMP/dsh-next-installer-evidence/reused-windows"'
        package='-PackageIndex "$env:RUNNER_TEMP/dsh-next-installer-evidence/reused-windows/packages.json"'
        def check_paths(text):
            self.assertIn(output,text);self.assertIn(package,text)
            self.assertIn('dsh-next-installer-evidence/reused-windows/**/*.json',text)
            self.assertNotIn('--output "$env:RUNNER_TEMP/dsh-next-installer-evidence/windows"',text)
        check_paths(workflow)
        for token in [output,package,'dsh-next-installer-evidence/reused-windows/**/*.json']:
            with self.assertRaises(AssertionError):check_paths(workflow.replace(token,token.replace('reused-windows','windows')))
        self.assertIn('output.mkdir(exist_ok=False)',(HERE/'verify-v2-reuse.py').read_text())


if __name__ == '__main__': unittest.main()
