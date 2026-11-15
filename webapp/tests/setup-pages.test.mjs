import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
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

test('setup chooser lists all three setup options and bluetooth setup page is reachable', async () => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: appDir,
    env: { ...process.env, MOCK: '1', HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });

  try {
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
      try {
        if ((await fetch(`${base}/api/config`)).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (i === 99) throw new Error(`Server did not start: ${output}`);
    }

    const anonSetup = await fetch(`${base}/setup-bluetooth`, { redirect: 'manual' });
    assert.equal(anonSetup.status, 302);
    assert.equal(anonSetup.headers.get('location'), '/login');

    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@example.com', password: 'demo1234' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const headers = { Cookie: cookie };

    const setupRes = await fetch(`${base}/setup`, { headers });
    assert.equal(setupRes.status, 200);
    const setupHtml = await setupRes.text();
    assert.match(setupHtml, /Use genuine ANOVA app/);
    assert.match(setupHtml, /Setup using your cooker&apos;s Wi‑Fi|Setup using your cooker's Wi‑Fi/);
    assert.match(setupHtml, /Setup using Bluetooth/);
    assert.equal((setupHtml.match(/>OR</g) ?? []).length, 2);
    assert.match(setupHtml, /href="\/setup-wifi"/);
    assert.match(setupHtml, /href="\/setup-bluetooth"/);

    const bluetoothRes = await fetch(`${base}/setup-bluetooth`, { headers });
    assert.equal(bluetoothRes.status, 200);
    const bluetoothHtml = await bluetoothRes.text();
    assert.match(bluetoothHtml, /Add a cooker over Bluetooth/);
    assert.match(bluetoothHtml, /Find my cooker/);
  } finally {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await once(server, 'exit');
    }
  }
});
