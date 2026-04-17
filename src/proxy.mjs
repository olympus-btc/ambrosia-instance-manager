import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
const templatesDir = path.join(proxyDir, 'templates');
const instanceTemplatePath = path.join(templatesDir, 'instance.conf');

const PROXY_NETWORK = 'ambrosia-proxy';

let instanceTemplateCache = null;

async function loadInstanceTemplate() {
  if (instanceTemplateCache) return instanceTemplateCache;
  instanceTemplateCache = await readFile(instanceTemplatePath, 'utf8');
  return instanceTemplateCache;
}

function renderTemplate(template, vars) {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

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
    const parsed = JSON.parse(content);
    return {
      baseDomain: null,
      email: null,
      enabled: false,
      mode: 'public',
      tlsMode: 'letsencrypt',
      bindAddress: '0.0.0.0',
      httpPort: 80,
      httpsPort: 443,
      ...parsed,
    };
  } catch {
    return {
      baseDomain: null,
      email: null,
      enabled: false,
      mode: 'public',
      tlsMode: 'letsencrypt',
      bindAddress: '0.0.0.0',
      httpPort: 80,
      httpsPort: 443,
    };
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
  const serverName = `${instance.id}.${domain}`;
  const useTls = config.enabled && config.tlsMode === 'letsencrypt';

  const listenDirective = useTls
    ? `listen 443 ssl;\n    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;\n    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;\n    include /etc/nginx/conf.d/snippets/ssl-params.conf;`
    : `listen 80;`;

  const httpRedirect = useTls
    ? `server {\n    listen 80;\n    server_name ${serverName};\n    location /.well-known/acme-challenge/ { root /var/www/certbot; }\n    location / { return 301 https://$host$request_uri; }\n}\n`
    : '';

  const template = await loadInstanceTemplate();
  return renderTemplate(template, {
    HTTP_REDIRECT: httpRedirect,
    LISTEN_DIRECTIVE: listenDirective,
    SERVER_NAME: serverName,
    PROJECT_NAME: instance.projectName,
  });
}

async function rebuildMaps(instances) {
  const config = await readProxyConfig();
  if (!config.baseDomain) return;

  const domain = config.baseDomain;
  const clientLines = [];
  const apiLines = [];

  for (const instance of instances) {
    const clientDomain = `${instance.id}.${domain}`;
    clientLines.push(`~^${clientDomain.replace(/\./g, '\\.')}$ http://${instance.projectName}-ambrosia-client-1:3000;`);
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

function getPublishedInstances(instances) {
  return instances.filter((instance) => instance.status === 'running');
}

async function syncInstanceConfFiles(instances) {
  await mkdir(instancesConfDir, { recursive: true });
  const expected = new Set(instances.map((instance) => `${instance.id}.conf`));

  let entries = [];
  try {
    entries = await readdir(instancesConfDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.conf')) continue;
    if (expected.has(entry)) continue;
    await rm(path.join(instancesConfDir, entry), { force: true });
  }
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

function buildProxyComposeEnv(config) {
  const bindAddress = config.bindAddress === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0';
  const httpPort = Number.parseInt(`${config.httpPort || 80}`, 10) || 80;
  const httpsPort = Number.parseInt(`${config.httpsPort || 443}`, 10) || 443;
  const httpBind = bindAddress === '127.0.0.1' ? `${bindAddress}:${httpPort}` : `${httpPort}`;
  const httpsBind = bindAddress === '127.0.0.1' ? `${bindAddress}:${httpsPort}` : `${httpsPort}`;
  return {
    ...process.env,
    PROXY_HTTP_BIND: httpBind,
    PROXY_HTTPS_BIND: httpsBind,
  };
}

async function startProxy(config) {
  await runDockerCompose(['-f', proxyComposeFile, 'up', '-d'], {
    cwd: managerRoot,
    env: buildProxyComposeEnv(config),
  });
}

async function stopProxy(config) {
  await runDockerCompose(['-f', proxyComposeFile, 'down'], {
    cwd: managerRoot,
    env: buildProxyComposeEnv(config),
  });
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
    mode: 'public',
    tlsMode: 'letsencrypt',
    bindAddress: '0.0.0.0',
    httpPort: 80,
    httpsPort: 443,
  };

  await writeProxyConfig(config);
  await startProxy(config);

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
  if (!config.baseDomain) {
    throw createHttpError(400, 'Proxy must be configured with a domain and email first');
  }
  if (config.tlsMode === 'letsencrypt' && !config.email) {
    throw createHttpError(400, 'Proxy must be configured with a domain and email first');
  }
  config.enabled = true;
  await writeProxyConfig(config);
  await startProxy(config);
  return config;
}

export async function disableProxy() {
  const config = await readProxyConfig();
  config.enabled = false;
  await writeProxyConfig(config);
  await stopProxy(config);
  return config;
}

export async function addInstanceToProxy(instance, instances) {
  const config = await readProxyConfig();
  if (!config.enabled || !config.baseDomain) return;

  await connectInstanceToProxy(instance);
  await writeInstanceConf(instance);
  await rebuildMaps(getPublishedInstances(instances));

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
  const remainingInstances = getPublishedInstances(instances).filter((i) => i.id !== instanceId);
  await rebuildMaps(remainingInstances);
  await syncInstanceConfFiles(remainingInstances);

  const running = await isProxyRunning();
  if (running) {
    await reloadNginx();
  }
}

export async function refreshProxyConfig(instances) {
  const config = await readProxyConfig();
  if (!config.enabled || !config.baseDomain) return;

  const publishedInstances = getPublishedInstances(instances);

  for (const instance of publishedInstances) {
    await connectInstanceToProxy(instance);
    await writeInstanceConf(instance);
  }

  await rebuildMaps(publishedInstances);
  await syncInstanceConfFiles(publishedInstances);

  const running = await isProxyRunning();
  if (running) {
    await reloadNginx();
  }
}

export async function renewCertificates() {
  const config = await readProxyConfig();
  if (config.tlsMode !== 'letsencrypt') {
    throw createHttpError(400, 'Certificate renewal is only available in public HTTPS mode');
  }
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
    apiUrl: `https://${instance.id}.${domain}/api`,
  };
}

export async function configureCloudflareProxy({ baseDomain }, instances = []) {
  if (!baseDomain || !baseDomain.trim()) {
    throw createHttpError(400, 'Base domain is required');
  }

  const config = {
    baseDomain: baseDomain.trim().toLowerCase(),
    email: null,
    enabled: true,
    mode: 'cloudflare',
    tlsMode: 'off',
    bindAddress: '127.0.0.1',
    httpPort: 8080,
    httpsPort: 8443,
  };

  await writeProxyConfig(config);
  await startProxy(config);
  await refreshProxyConfig(instances);
  return config;
}
