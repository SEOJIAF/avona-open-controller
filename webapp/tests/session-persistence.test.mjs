import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const appDir = path.dirname(fileURLToPath(new URL('../server.mjs', import.meta.url)));

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

test('a login survives a new tab and server restart, then logout revokes it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'avona-session-test-'));
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  let server;

  async function start() {
    server = spawn(process.execPath, ['server.mjs'], {
      cwd: appDir,
      env: { ...process.env, MOCK: '1', HOST: '127.0.0.1', PORT: String(port), SESSION_FILE: path.join(dir, 'sessions.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    server.stdout.on('data', (chunk) => { output += chunk; });
    server.stderr.on('data', (chunk) => { output += chunk; });
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
      try {
        if ((await fetch(`${base}/api/config`)).ok) return;
      } catch { /* Wait for the listener. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Server did not start: ${output}`);
  }

  async function stop() {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await once(server, 'exit');
    }
  }

  try {
    await start();
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@example.com', password: 'demo1234' }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /Max-Age=2592000/);
    assert.match(setCookie, /HttpOnly/);
    const cookie = setCookie.split(';', 1)[0];
    const headers = { Cookie: cookie };

    assert.equal((await fetch(`${base}/`, { headers, redirect: 'manual' })).status, 200);
    assert.equal((await fetch(`${base}/login`, { headers, redirect: 'manual' })).status, 302);

    await stop();
    await start();
    const restored = await fetch(`${base}/api/me`, { headers });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).email, 'demo@example.com');

    assert.equal((await fetch(`${base}/api/logout`, { method: 'POST', headers })).status, 200);
    assert.equal((await fetch(`${base}/api/me`, { headers })).status, 401);

    await stop();
    await start();
    assert.equal((await fetch(`${base}/api/me`, { headers })).status, 401);
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
