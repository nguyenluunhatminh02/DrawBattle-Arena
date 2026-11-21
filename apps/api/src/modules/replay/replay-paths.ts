import { basename, join } from 'path';

export const REPLAY_FILE_PREFIX = '/api/replays/file/';
export const REPLAY_STATIC_PREFIX = '/replays/';

/**
 * Rendered GIFs are private and persistent. In Compose a dedicated named volume
 * is mounted here (outside the static `public` root), so the files survive
 * container recreation but can only be read via the guarded file route.
 */
export function replayRenderDir(cwd: string = process.cwd()): string {
  return join(cwd, 'private-replays');
}

/** The legacy public directory is migration input only; it is never trusted for reads. */
export function replayLegacyRenderDir(cwd: string = process.cwd()): string {
  return join(cwd, 'public', 'replays');
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

/** Decode a guarded pointer filename once, so both helpers share the same rule. */
function decodedPointerFilename(gifUrl: string, prefix: string): string | null {
  if (!gifUrl.startsWith(prefix)) return null;
  const raw = gifUrl.slice(prefix.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Accept only pointers that name exactly this replay's GIF. Encoded ids are
 * decoded before comparison, so replayFileUrl and this helper always agree.
 * Rejects traversal (decoded `/`, `\`, `..` segments) and anything outside the
 * strict replay-id charset.
 */
export function replayFilenameFromPointer(
  gifUrl: string | null | undefined,
  replayId: string,
): string | null {
  if (!gifUrl) return null;
  for (const prefix of [REPLAY_FILE_PREFIX, REPLAY_STATIC_PREFIX]) {
    const filename = decodedPointerFilename(gifUrl, prefix);
    if (!filename) continue;
    if (filename !== replayGifFilename(replayId)) return null;
    if (filename !== basename(filename) || !/^[A-Za-z0-9_-]+\.gif$/.test(filename)) return null;
    return filename;
  }
  return null;
}

export function isLegacyReplayPointer(gifUrl: string | null | undefined): boolean {
  return typeof gifUrl === 'string' && gifUrl.startsWith(REPLAY_STATIC_PREFIX);
}
