#!/usr/bin/env python3
"""Linux-only command adapter; the frozen owner alone observes, signals and reaps.
Cancellation uses the parent's private stdin pipe, including EOF on parent loss.
Host-runner hard cancellation remains the outer boundary, not a cleanup guarantee.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys

HERE = Path(__file__).resolve().parent
OWNER = HERE / 'owned-supervisor.py'
assert hashlib.sha256(OWNER.read_bytes()).hexdigest() == 'bc48ae5497f44cbdd97d73bce1a67c36e970c3dd13995336ce992de6c750b62c'
spec = importlib.util.spec_from_file_location('owned_supervisor', OWNER)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)
# Startup request is a single bounded line. No command inherits this pipe.
line = bytearray()
while len(line) < 1024 * 1024:
    byte = os.read(sys.stdin.fileno(), 1)
    if byte == b'\n':
        break
    if not byte:
        raise RuntimeError('parent closed before startup request')
    line.extend(byte)
else:
    raise RuntimeError('startup request exceeds bound')
request = json.loads(line)
assert sys.platform == 'linux'
evidence = Path(request['evidence']).resolve()
owner.EVIDENCE = evidence
owner.PHASE = 'owner'
owner.LOG_LIMIT = owner.TOTAL_LOG_LIMIT = 32 * 1024 * 1024
cancelled = None

def signal_received(number, _frame):
    # Do not raise inside the owner's finally/cleanup on a repeated signal.
    global cancelled
    cancelled = 'owner received signal ' + str(number)

for sig in (signal.SIGINT, signal.SIGTERM):
    signal.signal(sig, signal_received)
os.set_blocking(sys.stdin.fileno(), False)

def check_parent():
    global cancelled
    try:
        data = os.read(sys.stdin.fileno(), 4096)
    except BlockingIOError:
        data = None
    if data == b'':
        cancelled = cancelled or 'parent control pipe closed'
    elif data:
        cancelled = cancelled or 'parent requested cancellation'
    if cancelled:
        raise RuntimeError(cancelled)

owner.check_disk_budgets = check_parent
failure = None
try:
    owner.run('command', request['argv'], request['timeout_ms'] / 1000,
              request['cwd'], request['env'])
except BaseException as error:
    failure = f'{type(error).__name__}: {error}'
finally:
    records = owner.RECORDS
    record = records[-1] if len(records) == 1 else None
    # Empty survivors alone is insufficient: a genuine exit code proves final reap.
    confirmed = bool(record is not None and record.get('exit_code') is not None
                     and record.get('survivors') == {}
                     and record.get('reason') != 'cleanup_failed')
    receipt = {'schema': 1, 'cleanupConfirmed': confirmed, 'record': record,
               'failure': failure, 'cancelled': cancelled}
    temporary = evidence / 'receipt.json.tmp'
    temporary.write_text(json.dumps(receipt) + '\n')
    temporary.replace(evidence / 'receipt.json')
