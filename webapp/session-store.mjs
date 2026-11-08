import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

// Refresh tokens are credentials. Keep the file private and replace it atomically.
export class SessionStore {
  constructor(file) {
    this.file = file;
    this.pending = Promise.resolve();
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const data = JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.sessions)) throw new Error('Invalid session file');
    return data.sessions;
  }

  save(sessions) {
    const data = JSON.stringify({ version: 1, sessions });
    const write = async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.file);
      } catch (err) {
        await unlink(temporary).catch(() => {});
        throw err;
      }
    };
    const result = this.pending.then(write);
    this.pending = result.catch(() => {});
    return result;
  }
}
