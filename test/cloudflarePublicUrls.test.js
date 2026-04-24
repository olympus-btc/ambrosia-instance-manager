import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  spawn: vi.fn(),
}));

const tempDirs = [];

async function createDataDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ambrosia-cloudflare-test-'));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  delete process.env.INSTANCE_DATA_DIR;
  execFileMock.mockReset();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.resetModules();
});

describe('getInstanceCloudflareUrls', () => {
  it('returns null when cloudflared is not running', async () => {
    const dataDir = await createDataDir();
    process.env.INSTANCE_DATA_DIR = dataDir;
    await writeFile(path.join(dataDir, 'cloudflare-config.json'), JSON.stringify({
      enabled: true,
      domain: 'vidarte.site',
      tunnelToken: null,
    }));

    execFileMock.mockImplementation((_command, _args, ...rest) => {
      const callback = rest.at(-1);
      const error = new Error('not running');
      error.code = 1;
      callback(error, '', '');
    });

    const { getInstanceCloudflareUrls } = await import('../src/cloudflare.mjs');
    const urls = await getInstanceCloudflareUrls('ivan');

    expect(urls).toBeNull();
  });

  it('returns null when Cloudflare is disabled even if a domain is configured', async () => {
    const dataDir = await createDataDir();
    process.env.INSTANCE_DATA_DIR = dataDir;
    await writeFile(path.join(dataDir, 'cloudflare-config.json'), JSON.stringify({
      enabled: false,
      domain: 'vidarte.site',
      tunnelToken: null,
    }));

    const { getInstanceCloudflareUrls } = await import('../src/cloudflare.mjs');
    const urls = await getInstanceCloudflareUrls('ivan');

    expect(urls).toBeNull();
  });
});
