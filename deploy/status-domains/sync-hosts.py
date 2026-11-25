#!/usr/bin/env python3
"""Synchronize verified hostnames. Execute locally on the VPS as root via systemd.
No shell interpolation. Failed fetch/validation retains the last map; app/ask checks fail closed.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request


def host_entries(hosts, reserved):
    if not isinstance(hosts, list) or len(hosts) > 10000:
        raise ValueError('Invalid host list')
    entries = []
    for host in hosts:
        if not isinstance(host, str) or len(host) > 253 or len(host.split('.')) < 3 or any(
            not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
            for label in host.split('.')
        ) or host in reserved:
            raise ValueError('Invalid or reserved hostname in eligible set')
        entries.append(f'{host} 127.0.0.1:8443;\n')
    return ''.join(sorted(set(entries))).encode()


def install(path, content):
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.watchrail-')
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(content)
            os.fchmod(out.fileno(), 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    token = os.environ['PUBLIC_STATUS_PAGE_INTERNAL_TOKEN']
    reserved = {host.strip() for host in os.environ['STATUS_DOMAIN_RESERVED_HOSTNAMES'].split(',') if host.strip()}
    if not reserved or len(token) < 32:
        raise ValueError('Set the internal token and all existing virtual hosts as reserved names')
    path = Path('/etc/nginx/watchrail-domains.map')
    with open('/run/watchrail-domain-sync.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        request = urllib.request.Request('http://127.0.0.1:4000/api/internal/status-domains/eligible', headers={'x-watchrail-internal-token': token})
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ValueError('Oversized host list')
            content = host_entries(json.loads(raw)['data'], reserved)
        previous = path.read_bytes()
        if content == previous:
            return
        install(path, content)
        try:
            subprocess.run(['nginx', '-t'], check=True)
            subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
        except Exception:
            install(path, previous)
            subprocess.run(['nginx', '-t'], check=True)
            subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
            raise

if __name__ == '__main__':
    main()
