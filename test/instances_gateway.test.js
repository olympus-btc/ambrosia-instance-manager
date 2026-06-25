import { mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (callback) {
      setTimeout(() => callback(null, { stdout: '' }, ''), 0);
    }
    return {
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      kill: vi.fn(),
    };
  }),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(__dirname, 'tmp-instances-test');
const mockAmbrosiaDir = path.join(__dirname, 'tmp-mock-ambrosia');

describe('Instance Logic Integration (Gateway Architecture)', () => {
  beforeAll(async () => {
    process.env.INSTANCE_DATA_DIR = testDataDir;
    process.env.AMBROSIA_SOURCE_DIR = mockAmbrosiaDir;

    await mkdir(path.join(mockAmbrosiaDir, 'server'), { recursive: true });
    await mkdir(path.join(mockAmbrosiaDir, 'client'), { recursive: true });
    await mkdir(testDataDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDataDir, { recursive: true, force: true });
    await rm(mockAmbrosiaDir, { recursive: true, force: true });
  });

  it('writeEnvFile should include gateway architecture variables', async () => {
    const instancesMod = await import('../src/instances.mjs');

    try {
      await instancesMod.createInstance({ name: 'test-env', phoenixChain: 'testnet' });
    } catch {
    }

    const envPath = path.join(testDataDir, 'test-env', 'instance.env');
    const envContent = await readFile(envPath, 'utf8');

    expect(envContent).toContain('NEXT_PUBLIC_API_URL=/api');
    expect(envContent).toContain('INTERNAL_ORIGIN=http://gateway');
  });

  it('docker-compose.instance.yml should contain the gateway service', async () => {
    const composePath = path.join(__dirname, '../docker-compose.instance.yml');
    const composeContent = await readFile(composePath, 'utf8');

    expect(composeContent).toContain('gateway:');
    expect(composeContent).toContain('image: nginx:alpine');
    expect(composeContent).toContain('proxy_pass http://ambrosia:9154/;');
    expect(composeContent).toContain('proxy_pass http://ambrosia-client:3000;');
  });
});
