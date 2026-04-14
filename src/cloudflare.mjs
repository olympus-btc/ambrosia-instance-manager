import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const managerRoot = path.resolve(__dirname, '..');

function dataRoot() {
  return process.env.INSTANCE_DATA_DIR || path.join(managerRoot, '.ambrosia-instances');
}

function getConfigPath() {
  return path.join(dataRoot(), 'cloudflare-config.json');
}

function getCredentialsPath() {
  return path.join(dataRoot(), 'cloudflared-credentials.json');
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function runCommand(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: managerRoot,
      maxBuffer: 1024 * 1024 * 10,
      ...options,
    });
    return { stdout, stderr };
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw createHttpError(500, `Required command not found: ${command}`);
    }
    if (typeof error.stderr === 'string' && error.stderr.trim()) {
      throw createHttpError(500, error.stderr.trim());
    }
    throw error;
  }
}

async function readConfig() {
  try {
    return JSON.parse(await readFile(getConfigPath(), 'utf8'));
  } catch {
    return { tunnelToken: null, enabled: false, domain: null, tunnelName: null };
  }
}

async function writeConfig(config) {
  await mkdir(path.dirname(getConfigPath()), { recursive: true });
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2));
}

async function isInstalled() {
  try {
    await runCommand('cloudflared', ['--version']);
    return true;
  } catch {
    return false;
  }
}

let tunnelProcess = null;

async function isRunning() {
  if (tunnelProcess && !tunnelProcess.killed) return true;

  try {
    const { stdout } = await runCommand('pgrep', ['-f', 'cloudflared']);
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

async function startTunnel() {
  if (tunnelProcess) {
    try { tunnelProcess.kill(); } catch { /* ignore */ }
    tunnelProcess = null;
  }

  const config = await readConfig();
  if (!config.tunnelToken) {
    throw createHttpError(400, 'Tunnel token not configured');
  }

  const credentialsPath = getCredentialsPath();

  return new Promise((resolve, reject) => {
    tunnelProcess = spawn('cloudflared', [
      'tunnel', '--credentials-file', credentialsPath, 'run',
    ], {
      cwd: managerRoot,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    let lastError = '';
    const timeout = setTimeout(() => {
      if (!started) {
        tunnelProcess?.kill();
        tunnelProcess = null;
        reject(createHttpError(500, lastError || 'Cloudflare tunnel failed to start within timeout'));
      }
    }, 20000);

    tunnelProcess.stdout.on('data', (data) => {
      const line = data.toString();
      if (line.toLowerCase().includes('error') || line.toLowerCase().includes('err')) {
        lastError = line.trim();
      }
      if ((line.includes('Registered tunnel connection') || line.includes('Connection')) && !started) {
        started = true;
        clearTimeout(timeout);
        resolve();
      }
    });

    tunnelProcess.stderr.on('data', (data) => {
      const line = data.toString();
      if (line.toLowerCase().includes('error')) {
        lastError = line.trim();
      }
      if ((line.includes('Registered tunnel connection') || line.includes('connection registered')) && !started) {
        started = true;
        clearTimeout(timeout);
        resolve();
      }
    });

    tunnelProcess.on('error', (error) => {
      clearTimeout(timeout);
      if (!started) reject(createHttpError(500, `Failed to start cloudflared: ${error.message}`));
    });

    tunnelProcess.on('exit', (code) => {
      clearTimeout(timeout);
      tunnelProcess = null;
      if (!started) {
        reject(createHttpError(500, lastError || `cloudflared exited with code ${code}`));
      }
    });

    setTimeout(async () => {
      if (!started) {
        const running = await isRunning();
        if (running) {
          started = true;
          clearTimeout(timeout);
          resolve();
        }
      }
    }, 8000);
  });
}

async function stopTunnel() {
  if (tunnelProcess) {
    try { tunnelProcess.kill('SIGTERM'); } catch { /* ignore */ }
    tunnelProcess = null;
  }

  try {
    await runCommand('pkill', ['-f', 'cloudflared']);
  } catch { /* ignore */ }
}

export async function getCloudflareStatus() {
  const config = await readConfig();
  const installed = await isInstalled();
  const running = await isRunning();

  return {
    enabled: config.enabled,
    installed,
    running,
    tunnelToken: config.tunnelToken ? '••••••' : null,
    domain: config.domain || null,
    tunnelName: config.tunnelName || null,
  };
}

export async function configureCloudflare({ tunnelToken }) {
  if (!tunnelToken || !tunnelToken.trim()) {
    throw createHttpError(400, 'Tunnel token is required');
  }

  const installed = await isInstalled();
  if (!installed) {
    throw createHttpError(400, 'cloudflared is not installed. Install it with: sudo pacman -S cloudflared');
  }

  const token = tunnelToken.trim();
  const config = await readConfig();

  let tunnelInfo;
  try {
    const { stdout } = await runCommand('cloudflared', ['tunnel', 'info', '--output', 'json'], {
      env: { ...process.env, TUNNEL_TOKEN: token },
    });
    tunnelInfo = JSON.parse(stdout);
  } catch { /* ignore, info may not be available */ }

  const credentialsPath = getCredentialsPath();
  try {
    await runCommand('cloudflared', ['tunnel', 'token', '--output', credentialsPath], {
      env: { ...process.env, TUNNEL_TOKEN: token },
    });
  } catch {
    await mkdir(path.dirname(credentialsPath), { recursive: true });
    await writeFile(credentialsPath, JSON.stringify({ AccountTag: '', TunnelSecret: token, TunnelID: '' }));
  }

  config.tunnelToken = token;
  config.enabled = true;
  config.tunnelName = tunnelInfo?.name || config.tunnelName || 'ambrosia';
  await writeConfig(config);

  return config;
}

export async function enableCloudflare(instances) {
  const config = await readConfig();
  if (!config.domain) {
    throw createHttpError(400, 'Domain must be configured first');
  }

  const installed = await isInstalled();
  if (!installed) {
    throw createHttpError(400, 'cloudflared is not installed. Install it first on this machine.');
  }

  const running = await isRunning();
  if (!config.tunnelToken && !running) {
    throw createHttpError(400, 'Tunnel token must be configured first, or cloudflared must already be running');
  }

  config.enabled = true;
  await writeConfig(config);

  try {
    const { configureCloudflareProxy } = await import('./proxy.mjs');
    await configureCloudflareProxy({ baseDomain: config.domain }, instances);
  } catch (error) {
    throw createHttpError(error.statusCode || 500, error.message || 'Failed to configure local proxy for Cloudflare');
  }

  if (!running) {
    await startTunnel();
  }
  return config;
}

export async function disableCloudflare() {
  const config = await readConfig();
  config.enabled = false;
  await writeConfig(config);
  await stopTunnel();
  return config;
}

export async function getInstanceCloudflareUrls(instanceId) {
  const config = await readConfig();
  if (!config.enabled || !config.domain) return null;

  const running = await isRunning();
  if (!running) return null;

  return {
    frontendUrl: `https://${instanceId}.${config.domain}`,
    apiUrl: `https://${instanceId}.${config.domain}/api`,
  };
}

export async function addInstanceToCloudflare(_instance, _instances) {
  const config = await readConfig();
  if (!config.enabled || !config.tunnelToken) return;
}

export async function removeInstanceFromCloudflare(_instanceId, _instances) {
  const config = await readConfig();
  if (!config.enabled || !config.tunnelToken) return;
}

export async function setCloudflareDomain({ domain }) {
  if (!domain || !domain.trim()) {
    throw createHttpError(400, 'Domain is required');
  }

  const config = await readConfig();
  config.domain = domain.trim().toLowerCase();
  await writeConfig(config);

  if (config.enabled && config.tunnelToken) {
    try {
      const { listInstances } = await import('./instances.mjs');
      const { configureCloudflareProxy } = await import('./proxy.mjs');
      await configureCloudflareProxy({ baseDomain: config.domain }, await listInstances());
    } catch { /* ignore until Cloudflare mode is enabled */ }
  }

  return config;
}
