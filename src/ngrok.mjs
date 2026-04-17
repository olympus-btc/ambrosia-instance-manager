import { execFile, spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const managerRoot = path.resolve(__dirname, '..');
const NGROK_API_URL = 'http://127.0.0.1:4040';

function dataRoot() {
  return process.env.INSTANCE_DATA_DIR || path.join(managerRoot, '.ambrosia-instances');
}

function getConfigPath() {
  return path.join(dataRoot(), 'ngrok-config.json');
}

function getYamlPath() {
  return path.join(dataRoot(), 'ngrok-tunnels.yml');
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
    return { authtoken: null, enabled: false, tunnels: {} };
  }
}

async function writeConfig(config) {
  await mkdir(path.dirname(getConfigPath()), { recursive: true });
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2));
}

async function isNgrokInstalled() {
  try {
    await runCommand('ngrok', ['version']);
    return true;
  } catch {
    return false;
  }
}

async function isNgrokRunning() {
  try {
    const response = await fetch(NGROK_API_URL);
    return response.ok;
  } catch {
    return false;
  }
}

async function getTunnelUrls() {
  try {
    const response = await fetch(`${NGROK_API_URL}/api/tunnels`);
    if (!response.ok) return {};
    const data = await response.json();
    const urls = {};
    for (const tunnel of data.tunnels || []) {
      urls[tunnel.name] = tunnel.public_url;
    }
    return urls;
  } catch {
    return {};
  }
}

async function generateYamlConfig(instances) {
  const config = await readConfig();
  if (!config.authtoken) return;

  const maxTunnels = config.maxTunnels || 3;
  const tunnelEntries = [];

  for (const instance of instances) {
    if (config.excludedInstances && config.excludedInstances.includes(instance.id)) continue;

    if (tunnelEntries.length + 1 > maxTunnels) break;
    tunnelEntries.push({
      name: `${instance.id}-client`,
      proto: 'http',
      addr: String(instance.clientPort),
    });

    if (tunnelEntries.length + 1 > maxTunnels) break;
    tunnelEntries.push({
      name: `${instance.id}-api`,
      proto: 'http',
      addr: String(instance.apiPort),
    });
  }

  if (tunnelEntries.length === 0) {
    const yaml = `version: "2"
authtoken: ${config.authtoken}
web_addr: 127.0.0.1:4040
tunnels: {}
`;
    await writeFile(getYamlPath(), yaml);
    return;
  }

  const tunnelsBlock = tunnelEntries.map((t) => `  ${t.name}:
    proto: ${t.proto}
    addr: "${t.addr}"`).join('\n');

  const yaml = `version: "2"
authtoken: ${config.authtoken}
web_addr: 127.0.0.1:4040
tunnels:
${tunnelsBlock}
`;

  await writeFile(getYamlPath(), yaml);
}

let ngrokProcess = null;

async function startNgrok() {
  if (ngrokProcess) {
    try { ngrokProcess.kill(); } catch { }
    ngrokProcess = null;
  }

  const yamlPath = getYamlPath();

  try {
    await access(yamlPath);
  } catch {
    throw createHttpError(400, 'No tunnel configuration found. Create instances first.');
  }

  return new Promise((resolve, reject) => {
    ngrokProcess = spawn('ngrok', ['start', '--config', yamlPath, '--all', '--log=stdout'], {
      cwd: managerRoot,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    let lastError = '';
    const timeout = setTimeout(() => {
      if (!started) {
        ngrokProcess?.kill();
        ngrokProcess = null;
        reject(createHttpError(500, lastError || 'Ngrok failed to start within timeout'));
      }
    }, 15000);

    ngrokProcess.stdout.on('data', (data) => {
      const line = data.toString();
      if (line.includes('lvl=eror') || line.includes('ERROR:') || line.includes('ERR_NGROK')) {
        lastError = line.replace(/^.*lvl=eror\s+msg="([^"]*)".*$/gm, '$1').replace(/^ERROR:\s*/gm, '').trim();
      }
      if (line.includes('started tunnel') && !started) {
        started = true;
        clearTimeout(timeout);
        resolve();
      }
    });

    ngrokProcess.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) lastError = line;
    });

    ngrokProcess.on('error', (error) => {
      clearTimeout(timeout);
      if (!started) reject(createHttpError(500, `Failed to start ngrok: ${error.message}`));
    });

    ngrokProcess.on('exit', (code) => {
      clearTimeout(timeout);
      ngrokProcess = null;
      if (!started) {
        const msg = lastError || `Ngrok exited with code ${code}`;
        reject(createHttpError(500, msg));
      }
    });

    setTimeout(async () => {
      if (!started) {
        const running = await isNgrokRunning();
        if (running) {
          started = true;
          clearTimeout(timeout);
          resolve();
        }
      }
    }, 5000);
  });
}

async function stopNgrok() {
  if (ngrokProcess) {
    try { ngrokProcess.kill('SIGTERM'); } catch { }
    ngrokProcess = null;
  }

  try {
    await runCommand('pkill', ['-f', 'ngrok start']);
  } catch { }
}

async function refreshTunnelConfig(instances) {
  const config = await readConfig();
  if (!config.enabled || !config.authtoken) return;

  await generateYamlConfig(instances);

  const running = await isNgrokRunning();
  if (running) {
    await stopNgrok();
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (instances.length > 0) {
    await startNgrok();
  }
}

export async function getNgrokStatus() {
  const config = await readConfig();
  const installed = await isNgrokInstalled();
  const running = await isNgrokRunning();
  const tunnelUrls = running ? await getTunnelUrls() : {};

  return {
    authtoken: config.authtoken ? '••••••' : null,
    enabled: config.enabled,
    installed,
    running,
    maxTunnels: config.maxTunnels || 3,
    excludedInstances: config.excludedInstances || [],
    tunnels: tunnelUrls,
  };
}

export async function configureNgrok({ authtoken, maxTunnels }) {
  if (!authtoken || !authtoken.trim()) {
    throw createHttpError(400, 'Ngrok authtoken is required');
  }

  const installed = await isNgrokInstalled();
  if (!installed) {
    throw createHttpError(400, 'ngrok is not installed. Install it from https://ngrok.com/download');
  }

  const config = await readConfig();
  config.authtoken = authtoken.trim();
  config.enabled = true;
  config.maxTunnels = maxTunnels || 3;
  config.excludedInstances = config.excludedInstances || [];
  await writeConfig(config);

  try {
    await runCommand('ngrok', ['config', 'add-authtoken', authtoken.trim()]);
  } catch (error) {
    throw createHttpError(500, `Failed to configure ngrok authtoken: ${error.message}`);
  }

  return config;
}

export async function enableNgrok(instances) {
  const config = await readConfig();
  if (!config.authtoken) {
    throw createHttpError(400, 'Ngrok authtoken must be configured first');
  }
  config.enabled = true;
  await writeConfig(config);

  if (instances.length > 0) {
    await refreshTunnelConfig(instances);
  }

  return config;
}

export async function disableNgrok() {
  const config = await readConfig();
  config.enabled = false;
  await writeConfig(config);
  await stopNgrok();
  return config;
}

export async function addInstanceTunnels(instance, instances) {
  const config = await readConfig();
  if (!config.enabled || !config.authtoken) return;

  await refreshTunnelConfig(instances);
}

export async function removeInstanceTunnels(instanceId, instances) {
  const config = await readConfig();
  if (!config.enabled || !config.authtoken) return;

  await refreshTunnelConfig(instances);
}

export async function getInstanceNgrokUrls(instanceId) {
  const config = await readConfig();
  if (!config.enabled || !config.authtoken) return null;

  const running = await isNgrokRunning();
  if (!running) return null;

  const urls = await getTunnelUrls();
  const clientUrl = urls[`${instanceId}-client`] || null;
  const apiUrl = urls[`${instanceId}-api`] || null;

  if (!clientUrl && !apiUrl) return null;

  return {
    frontendUrl: clientUrl,
    apiUrl,
  };
}
