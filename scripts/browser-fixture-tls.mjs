// Browser fixtures exercise the same HTTPS-only origin checks as production.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
export function browserFixtureTls() {
    const directory = mkdtempSync(join(tmpdir(), 'ava-browser-tls-'));
    const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
    return { https: { key: readFileSync(key), cert: readFileSync(cert) }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
