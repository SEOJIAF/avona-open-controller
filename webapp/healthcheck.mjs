// Container health check: the server answers /api/config over HTTP, or HTTPS when TLS_CERT is set.
import http from 'node:http';
import https from 'node:https';

const tls = Boolean(process.env.TLS_CERT && process.env.TLS_KEY);
const req = (tls ? https : http).get(
  { host: '127.0.0.1', port: Number(process.env.PORT ?? 8080), path: '/api/config', rejectUnauthorized: false, timeout: 4000 },
  (res) => process.exit(res.statusCode === 200 ? 0 : 1),
);
req.on('error', () => process.exit(1));
req.on('timeout', () => req.destroy(new Error('timeout')));
