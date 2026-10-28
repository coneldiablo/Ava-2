#!/usr/bin/env python3
"""One explicitly requested SIP REGISTER; emit only an allowlisted summary.

Raw packets stay in a private administrator directory for encrypted export.
Never prints Digest authorization, nonce, usernames or telephone numbers.
"""
import argparse
import json
import os
import re
import socket
import subprocess
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--registration', required=True)
    parser.add_argument('--private-output', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', args.registration):
        raise SystemExit('INVALID_REGISTRATION')
    os.umask(0o077)
    out = args.private_output.resolve()
    if not str(out).startswith('/root/backups/ava/') or out.exists():
        raise SystemExit('NEW_PRIVATE_OUTPUT_REQUIRED')
    channels = subprocess.check_output(['asterisk', '-rx', 'core show channels count'], text=True)
    if not re.search(r'^0 active calls$', channels, re.M):
        raise SystemExit('ACTIVE_CALL_DIAGNOSTIC_DEFERRED')
    info = subprocess.check_output(['asterisk', '-rx', f'pjsip show registration {args.registration}'], text=True)
    uri = re.search(r'^\s*server_uri\s*:\s*sip:([^:\s]+)(?::(\d+))?', info, re.M)
    if not uri:
        raise SystemExit('SIP_PROVIDER_NOT_FOUND')
    host, port = uri.group(1), int(uri.group(2) or 5060)
    addresses = sorted({v[4][0] for v in socket.getaddrinfo(host, port, family=socket.AF_INET, type=socket.SOCK_DGRAM)})
    out.mkdir(mode=0o700)
    capture = out / 'registration.pcap'
    capture.touch(mode=0o600)
    packet_filter = 'udp and port ' + str(port) + ' and (' + ' or '.join('host ' + ip for ip in addresses) + ')'
    proc = subprocess.Popen(['tcpdump', '-i', 'any', '-U', '-s', '0', '-w', str(capture), packet_filter], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1)
        if proc.poll() is not None:
            raise RuntimeError('PACKET_CAPTURE_START_FAILED')
        subprocess.run(['asterisk', '-rx', f'pjsip send register {args.registration}'], check=True, capture_output=True, timeout=5)
        time.sleep(8)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill(); proc.wait()
    raw = subprocess.check_output(['tcpdump', '-nn', '-A', '-r', str(capture)], stderr=subprocess.DEVNULL, text=True, errors='replace')
    codes = [int(code) for code in re.findall(r'SIP/2\.0 (\d{3})\b', raw)]
    realms = re.findall(r'(?im)^WWW-Authenticate:\s*Digest\s+[^\r\n]*?realm="([^"\r\n]+)"', raw)
    # Provider realm is non-secret; reject arbitrary packet content rather than
    # copying response headers verbatim into shared logs.
    realms = sorted({realm for realm in realms if re.fullmatch(r'[A-Za-z0-9._:-]{1,100}', realm)})
    after = subprocess.check_output(['asterisk', '-rx', 'pjsip show registrations'], text=True)
    state = 'unknown'
    for line in after.splitlines():
        if args.registration + '/' in line:
            match = re.search(r'\b(Registered|Rejected|Unregistered|Stopped)\b', line)
            if match:
                state = match.group(1)
    result = {'provider_host': host, 'provider_addresses': addresses, 'transport': 'udp',
              'response_codes': codes, 'challenge_realms': realms,
              'authorization_sent': bool(re.search(r'(?im)^Authorization:\s*Digest ', raw)),
              'registration_state': state, 'outbound_calls_started': 0}
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('SIP_DIAGNOSTIC_FAILED_RAW_DATA_NOT_PRINTED')
