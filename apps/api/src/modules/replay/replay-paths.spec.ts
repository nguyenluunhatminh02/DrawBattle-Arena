import {
  REPLAY_FILE_PREFIX,
  REPLAY_STATIC_PREFIX,
  isLegacyReplayPointer,
  replayFileUrl,
  replayFilenameFromPointer,
  replayGifFilename,
  replayLegacyRenderDir,
  replayRenderDir,
} from './replay-paths';
import { join } from 'path';

describe('replay paths', () => {
  it('keeps private GIF storage on a persistent volume path outside the static root', () => {
    expect(replayRenderDir('/app/apps/api')).toBe('/app/apps/api/private-replays');
    expect(replayRenderDir('/app/apps/api')).not.toContain('public');
    expect(replayLegacyRenderDir('/app/apps/api')).toBe(
      join('/app/apps/api', 'public', 'replays'),
    );
  });

  it('agrees with pointer parsing for encoded ids', () => {
    const id = 'abc%2Fdef'; // encoded slash: must decode and then be rejected
    const url = replayFileUrl(id);
    expect(url).toBe(`${REPLAY_FILE_PREFIX}abc%252Fdef.gif`);
    expect(replayFilenameFromPointer(url, id)).toBeNull();
  });

  it('accepts only exact, safe filenames for either pointer prefix', () => {
    expect(replayFilenameFromPointer(replayFileUrl('replay-1'), 'replay-1')).toBe(
      replayGifFilename('replay-1'),
    );
    expect(replayFilenameFromPointer(`${REPLAY_STATIC_PREFIX}replay-1.gif`, 'replay-1')).toBe(
      replayGifFilename('replay-1'),
    );
    expect(
      replayFilenameFromPointer(`${REPLAY_FILE_PREFIX}other.gif`, 'replay-1'),
    ).toBeNull();
    expect(
      replayFilenameFromPointer(`${REPLAY_FILE_PREFIX}..%2Fsecret.gif`, 'replay-1'),
    ).toBeNull();
    expect(replayFilenameFromPointer('https://example.com/x.gif', 'x')).toBeNull();
  });

  it('distinguishes legacy pointers from guarded ones', () => {
    expect(isLegacyReplayPointer(`${REPLAY_STATIC_PREFIX}replay-1.gif`)).toBe(true);
    expect(isLegacyReplayPointer(replayFileUrl('replay-1'))).toBe(false);
    expect(isLegacyReplayPointer(null)).toBe(false);
  });
});
