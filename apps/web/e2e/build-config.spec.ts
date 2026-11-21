import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * P1-04 regression: a production build with NEXT_PUBLIC_API_URL unset must not
 * embed http://localhost:3001 in the browser bundle.
 *
 * Run against a build produced with NEXT_PUBLIC_API_URL unset (the default):
 *   cd apps/web && unset NEXT_PUBLIC_API_URL && pnpm build
 *   pnpm --filter @drawbattle/web test:e2e -- --grep 'P1-04'
 */
test.describe('P1-04 build-time API URL guard', () => {
  test('production browser bundle does not embed localhost:3001', () => {
    const webDir = resolve(__dirname, '..');
    const staticDir = join(webDir, '.next', 'static');

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.js')) files.push(full);
      }
    };
    walk(staticDir);

    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      if (contents.includes('localhost:3001') || contents.includes('http://localhost:3001')) {
        offenders.push(file.replace(webDir + '/', ''));
      }
    }

    expect(
      offenders,
      `Browser bundle embeds localhost API URL: ${offenders.join(', ')}. ` +
        'Ensure NEXT_PUBLIC_API_URL is empty at build time and the client uses same-origin paths.',
    ).toEqual([]);
  });
});
