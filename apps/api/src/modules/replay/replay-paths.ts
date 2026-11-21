import { join } from 'path';

export const REPLAY_FILE_PREFIX = '/api/replays/file/';
export const REPLAY_STATIC_PREFIX = '/replays/';

/** Rendered GIFs live outside `public`, so Express never serves them statically. */
export function replayRenderDir(cwd: string = process.cwd()): string {
  return join(cwd, 'private', 'replays');
}

/**
 * Replay GIFs are private. The stored pointer is only a filename; streaming is
 * done by the guarded file route after ReplayService.assertReplayAccess. The
 * legacy /replays/<id>.gif URL is kept for identifying old rows during
 * reconciliation, never for serving a file.
 */
export function replayFileUrl(replayId: string): string {
  return `${REPLAY_FILE_PREFIX}${encodeURIComponent(replayId)}.gif`;
}

export function replayGifFilename(replayId: string): string {
  return `${replayId}.gif`;
}

export function replayFilenameFromPointer(
  gifUrl: string | null | undefined,
  replayId: string,
): string | null {
  if (!gifUrl) return null;
  for (const prefix of [REPLAY_FILE_PREFIX, REPLAY_STATIC_PREFIX]) {
    if (!gifUrl.startsWith(prefix)) continue;
    const filename = gifUrl.slice(prefix.length);
    return filename === replayGifFilename(replayId) ? filename : null;
  }
  return null;
}
