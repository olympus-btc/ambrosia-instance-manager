import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tempDirs = [];

async function createDataDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ambrosia-proxy-test-'));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  delete process.env.INSTANCE_DATA_DIR;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.resetModules();
});

describe('getInstanceProxyUrls', () => {
  it('returns single-host public URLs for a configured proxy', async () => {
    const dataDir = await createDataDir();
    process.env.INSTANCE_DATA_DIR = dataDir;
    await writeFile(path.join(dataDir, 'proxy-config.json'), JSON.stringify({
      enabled: true,
      baseDomain: 'vidarte.site',
      mode: 'cloudflare',
      tlsMode: 'off',
    }));

    const { getInstanceProxyUrls } = await import('../src/proxy.mjs');
    const urls = await getInstanceProxyUrls({ id: 'ivan' });

    expect(urls).toEqual({
      frontendUrl: 'https://ivan.vidarte.site',
      apiUrl: 'https://ivan.vidarte.site/api',
    });
  });

  it('returns null when the proxy is disabled', async () => {
    const dataDir = await createDataDir();
    process.env.INSTANCE_DATA_DIR = dataDir;
    await writeFile(path.join(dataDir, 'proxy-config.json'), JSON.stringify({
      enabled: false,
      baseDomain: 'vidarte.site',
    }));

    const { getInstanceProxyUrls } = await import('../src/proxy.mjs');
    const urls = await getInstanceProxyUrls({ id: 'ivan' });

    expect(urls).toBeNull();
  });
});
