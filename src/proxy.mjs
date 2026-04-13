import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const managerRoot = path.resolve(__dirname, '..');
const proxyComposeFile = path.join(managerRoot, 'docker-compose.proxy.yml');
const proxyDir = path.join(managerRoot, 'proxy');
const confDir = path.join(proxyDir, 'conf.d');
const instancesConfDir = path.join(confDir, 'instances');
const upstreamMapPath = path.join(confDir, 'upstream.map');
const apiUpstreamMapPath = path.join(confDir, 'api-upstream.map');

const PROXY_NETWORK = 'ambrosia-proxy';

function getDataRoot() {
  return process.env.INSTANCE_DATA_DIR || path.join(managerRoot, '.ambrosia-instances');
}

function getProxyConfigPath() {
  return path.join(getDataRoot(), 'proxy-config.json');
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

async function runDockerCompose(args, options = {}) {
  try {
    return await runCommand('docker', ['compose', ...args], options);
  } catch (error) {
    const message = String(error?.message || '');
    const shouldFallback =
      message.includes('Required command not found: docker') ||
      message.includes("docker: 'compose' is not a docker command") ||
      message.includes("unknown shorthand flag: 'f' in -f") ||
      message.includes('Usage:  docker [OPTIONS] COMMAND');
    if (!shouldFallback) throw error;
    return await runCommand('docker-compose', args, options);
  }
}

async function readProxyConfig() {
  try {
    const content = await readFile(getProxyConfigPath(), 'utf8');
    return JSON.parse(content);
  } catch {
    return { baseDomain: null, email: null, enabled: false };
  }
}



async function writeProxyConfig(config) {
  await mkdir(path.dirname(getProxyConfigPath()), { recursive: true });
  await writeFile(getProxyConfigPath(), JSON.stringify(config, null, 2));
}

async function isProxyRunning() {
  try {
    const { stdout } = await runCommand('docker', ['compose', '-f', proxyComposeFile, 'ps', '--format', 'json']);
    const services = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return services.some((s) => {
      const state = `${s.State || s.Status || ''}`.toLowerCase();
      return state.includes('running');
    });
  } catch {
    return false;
  }
}

async function generateInstanceConf(instance) {
  const config = await readProxyConfig();
  const domain = config.baseDomain || 'localhost';
  const clientDomain = `${instance.id}.${domain}`;
  const apiDomain = `api-${instance.id}.${domain}`;

  const sslBlock = config.enabled ? `
    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;` : `
    listen 80;`;

  const httpRedirect = config.enabled ? `
server {
    listen 80;
    server_name ${clientDomain} ${apiDomain};
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}` : '';

  return `${httpRedirect}
server {
    ${sslBlock}
    server_name ${clientDomain};

    location / {
        proxy_pass http://${instance.projectName}-ambrosia-client-1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

server {
    ${sslBlock}
    server_name ${apiDomain};

    location / {
        proxy_pass http://${instance.projectName}-ambrosia-1:9154;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
    }
}
`;
}

async function rebuildMaps(instances) {
  const config = await readProxyConfig();
  if (!config.baseDomain) return;

  const domain = config.baseDomain;
  const clientLines = [];
  const apiLines = [];

  for (const instance of instances) {
    const clientDomain = `${instance.id}.${domain}`;
    const apiDomain = `api-${instance.id}.${domain}`;
    clientLines.push(`~^${clientDomain.replace(/\./g, '\\.')}$ http://${instance.projectName}-ambrosia-client-1:3000;`);
    apiLines.push(`~^${apiDomain.replace(/\./g, '\\.')}$ http://${instance.projectName}-ambrosia-1:9154;`);
  }

  await writeFile(upstreamMapPath, `${clientLines.join('\n')}\n`);
  await writeFile(apiUpstreamMapPath, `${apiLines.join('\n')}\n`);
}

async function writeInstanceConf(instance) {
  await mkdir(instancesConfDir, { recursive: true });
  const confPath = path.join(instancesConfDir, `${instance.id}.conf`);
  const content = await generateInstanceConf(instance);
  await writeFile(confPath, content);
}

async function removeInstanceConf(instanceId) {
  const confPath = path.join(instancesConfDir, `${instanceId}.conf`);
  try {
    await rm(confPath);
  } catch { /* ignore */ }
}

async function reloadNginx() {
  try {
    await runCommand('docker', ['exec', 'ambrosia-proxy', 'nginx', '-t']);
    await runCommand('docker', ['exec', 'ambrosia-proxy', 'nginx', '-s', 'reload']);
  } catch (error) {
    throw createHttpError(500, `Failed to reload Nginx: ${error.message}`);
  }
}

async function obtainCertificate(domain, email) {
  try {
    await runCommand('docker', [
      'compose', '-f', proxyComposeFile,
      'run', '--rm', 'certbot', 'certonly',
      '--webroot', '--webroot-path', '/var/www/certbot',
      '-d', domain,
      '-d', `*.${domain}`,
      '--email', email,
      '--agree-tos',
      '--non-interactive',
    ]);
  } catch (error) {
    throw createHttpError(500, `Certificate request failed: ${error.message}`);
  }
}

async function startProxy() {
  await runDockerCompose(['-f', proxyComposeFile, 'up', '-d'], { cwd: managerRoot });
}

async function stopProxy() {
  await runDockerCompose(['-f', proxyComposeFile, 'down'], { cwd: managerRoot });
}

async function connectInstanceToProxy(instance) {
  for (const service of ['ambrosia-client-1', 'ambrosia-1']) {
    try {
      await runCommand('docker', [
        'network', 'connect', PROXY_NETWORK,
        `${instance.projectName}-${service}`,
      ]);
    } catch { /* already connected */ }
  }
}

async function disconnectInstanceFromProxy(instance) {
  for (const service of ['ambrosia-client-1', 'ambrosia-1']) {
    try {
      await runCommand('docker', [
        'network', 'disconnect', PROXY_NETWORK,
        `${instance.projectName}-${service}`,
      ]);
    } catch { /* ignore */ }
  }
}

export async function getProxyStatus() {
  const config = await readProxyConfig();
  const running = await isProxyRunning();
  return { ...config, running };
}

export async function configureProxy({ baseDomain, email }) {
  if (!baseDomain || !baseDomain.trim()) {
    throw createHttpError(400, 'Base domain is required');
  }
  if (!email || !email.trim()) {
    throw createHttpError(400, "Email is required for Let's Encrypt");
  }

  const normalizedDomain = baseDomain.trim().toLowerCase();
  const normalizedEmail = email.trim().toLowerCase();

  const config = {
    baseDomain: normalizedDomain,
    email: normalizedEmail,
    enabled: true,
  };

  await writeProxyConfig(config);
  await startProxy();

  try {
    await obtainCertificate(normalizedDomain, normalizedEmail);
  } catch (error) {
    config.enabled = false;
    await writeProxyConfig(config);
    throw error;
  }

  return config;
}

export async function enableProxy() {
  const config = await readProxyConfig();
  if (!config.baseDomain || !config.email) {
    throw createHttpError(400, 'Proxy must be configured with a domain and email first');
  }
  config.enabled = true;
  await writeProxyConfig(config);
  await startProxy();
  return config;
}

export async function disableProxy() {
  const config = await readProxyConfig();
  config.enabled = false;
  await writeProxyConfig(config);
  await stopProxy();
  return config;
}

export async function addInstanceToProxy(instance, instances) {
  const config = await readProxyConfig();
  if (!config.enabled || !config.baseDomain) return;

  await connectInstanceToProxy(instance);
  await writeInstanceConf(instance);
  await rebuildMaps(instances);

  const running = await isProxyRunning();
  if (running) {
    await reloadNginx();
  }
}

export async function removeInstanceFromProxy(instanceId, instances) {
  const config = await readProxyConfig();
  if (!config.enabled || !config.baseDomain) return;

  const instance = instances.find((i) => i.id === instanceId);
  if (instance) {
    await disconnectInstanceFromProxy(instance);
  }

  await removeInstanceConf(instanceId);
  await rebuildMaps(instances.filter((i) => i.id !== instanceId));

  const running = await isProxyRunning();
  if (running) {
    await reloadNginx();
  }
}

export async function refreshProxyConfig(instances) {
  const config = await readProxyConfig();
  if (!config.enabled || !config.baseDomain) return;

  for (const instance of instances) {
    await connectInstanceToProxy(instance);
    await writeInstanceConf(instance);
  }

  await rebuildMaps(instances);

  const running = await isProxyRunning();
  if (running) {
    await reloadNginx();
  }
}

export async function renewCertificates() {
  try {
    await runCommand('docker', [
      'compose', '-f', proxyComposeFile,
      'run', '--rm', 'certbot', 'renew',
    ]);
  } catch (error) {
    throw createHttpError(500, `Certificate renewal failed: ${error.message}`);
  }
}

export async function getInstanceProxyUrls(instance) {
  const config = await readProxyConfig();
  if (!config.enabled || !config.baseDomain) return null;
  const domain = config.baseDomain;
  return {
    frontendUrl: `https://${instance.id}.${domain}`,
    apiUrl: `https://api-${instance.id}.${domain}`,
  };
}
