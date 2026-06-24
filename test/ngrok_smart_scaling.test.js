import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:child_process', () => {
  const { EventEmitter } = require('node:events');
  return {
    execFile: vi.fn((cmd, args, opts, cb) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (callback) setTimeout(() => callback(null, { stdout: '' }, ''), 0);
      return { on: vi.fn() };
    }),
    spawn: vi.fn(() => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const proc = new EventEmitter();
      proc.stdout = stdout;
      proc.stderr = stderr;
      proc.kill = vi.fn();

      setTimeout(() => {
        stdout.emit('data', 'started tunnel name=inst-1');
      }, 10);

      return proc;
    }),
  };
});

const tempDirs = [];

async function createDataDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ambrosia-ngrok-test-'));
  tempDirs.push(dir);
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

describe('Ngrok Smart Scaling', () => {
  it('respects maxTunnels limit and prioritizes frontends', async () => {
    const dataDir = await createDataDir();
    process.env.INSTANCE_DATA_DIR = dataDir;

    await writeFile(path.join(dataDir, 'ngrok-config.json'), JSON.stringify({
      enabled: true,
      authtoken: 'fake-token',
      maxTunnels: 1,
    }));

    const { addInstanceTunnels } = await import('../src/ngrok.mjs');

    const instances = [
      { id: 'inst-1', clientPort: 3001, apiPort: 9155, status: 'running' },
      { id: 'inst-2', clientPort: 3002, apiPort: 9156, status: 'running' },
    ];

    await addInstanceTunnels(instances[0], instances);

    const yamlPath = path.join(dataDir, 'ngrok-tunnels.yml');
    const yamlContent = await readFile(yamlPath, 'utf8');

    expect(yamlContent).toContain('inst-1:');
    expect(yamlContent).not.toContain('inst-1-api:');
    expect(yamlContent).not.toContain('inst-2:');
  });

  it('allows multiple tunnels when maxTunnels is high enough', async () => {
    const dataDir = await createDataDir();
    process.env.INSTANCE_DATA_DIR = dataDir;

    await writeFile(path.join(dataDir, 'ngrok-config.json'), JSON.stringify({
      enabled: true,
      authtoken: 'fake-token',
      maxTunnels: 10,
    }));

    const { addInstanceTunnels } = await import('../src/ngrok.mjs');

    const instances = [
      { id: 'inst-1', clientPort: 3001, apiPort: 9155, status: 'running' },
      { id: 'inst-2', clientPort: 3002, apiPort: 9156, status: 'running' },
    ];

    await addInstanceTunnels(instances[0], instances);

    const yamlContent = await readFile(path.join(dataDir, 'ngrok-tunnels.yml'), 'utf8');

    expect(yamlContent).toContain('inst-1:');
    expect(yamlContent).toContain('inst-2:');
  });
});

async function readFile(path, encoding) {
  const { readFile } = await import('node:fs/promises');
  return await readFile(path, encoding);
}
