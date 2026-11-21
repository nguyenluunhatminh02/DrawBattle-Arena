/**
 * HTTP-level regression coverage for the replay static-file exposure.
 *
 * Express's path-to-regexp matches the literal path segments of a request URL,
 * not the decoded result of `%2f`. A middleware mounted only at `/replays`
 * therefore misses `/replays%2f<id>.gif`; if the whole `public` root were served
 * statically, that request could reach a legacy GIF without any visibility
 * check. Mounting the guard at both spellings and serving only the avatars
 * directory closes both holes. These tests assert the real Express routing
 * behaviour with Node's fetch, without booting Nest/Prisma/Redis.
 */
import { createServer, type Server } from 'http';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import express from 'express';

function buildApp(publicRoot: string) {
  const app = express();
  app.use('/replays', (_req, res) => res.status(404).json({ message: 'Not Found' }));
  app.use('/replays/', (_req, res) => res.status(404).json({ message: 'Not Found' }));
  app.use('/avatars/', express.static(join(publicRoot, 'avatars'), { index: false }));
  app.get('/api/replays/file/:id.gif', (_req, res) => res.status(401).json({ message: 'Unauthorized' }));
  return app;
}

const LEGACY_GIF = 'GIF89a-private-replay';
const AVATAR_WEBP = 'RIFF-avatar';

describe('legacy replay GIF static paths (P0-02)', () => {
  let dir: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'replay-static-'));
    await mkdir(join(dir, 'avatars'), { recursive: true });
    await mkdir(join(dir, 'replays'), { recursive: true });
    await writeFile(join(dir, 'replays', 'replay-1.gif'), LEGACY_GIF);
    await writeFile(join(dir, 'avatars', 'avatar.webp'), AVATAR_WEBP);

    await new Promise<void>(resolve => {
      server = createServer(buildApp(dir)).listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(err => (err ? reject(err) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    '/replays/replay-1.gif',
    '/replays/replay-1.gif?share=ANY',
    '/replays/replay-1.GIF',
    '/replays%2freplay-1.gif',
    '/replays%2Freplay-1.gif',
    '/replays%2freplay-1.GIF',
    '/replays%2f%2e%2e%2favatars%2favatar.webp',
  ])('returns 404 and never streams a GIF for %s', async path => {
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(LEGACY_GIF);
  });

  it('keeps the avatar URL served from the dedicated static directory', async () => {
    const response = await fetch(`${baseUrl}/avatars/avatar.webp`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(AVATAR_WEBP);
  });

  it('does not expose the public root or any file outside the avatars mount', async () => {
    for (const path of [
      '/replay-1.gif',
      '/avatars/../replays/replay-1.gif',
      '/avatars/%2e%2e/replays/replay-1.gif',
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).not.toBe(200);
      expect(await response.text()).not.toContain(LEGACY_GIF);
    }
  });
});
