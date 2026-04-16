import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const managerRoot = path.resolve(__dirname, '..');
const composeFile = path.join(managerRoot, 'docker-compose.instance.yml');
const defaultAmbrosiaSourceDir = path.join(os.homedir(), 'code', 'ambrosia');
const dataRoot = process.env.INSTANCE_DATA_DIR || path.join(managerRoot, '.ambrosia-instances');
const registryPath = path.join(dataRoot, 'instances.json');

const PORT_STARTS = {
  apiPort: 9155,
  clientPort: 3001,
  phoenixPort: 9741,
};
const PHOENIX_CHAINS = new Set(['mainnet', 'testnet']);

function createProgressReporter(reportProgress) {
  return typeof reportProgress === 'function' ? reportProgress : () => {};
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function sanitizeName(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function resolvePhoenixChain(value, { fallback = 'mainnet', strict = false } = {}) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  if (!normalized) {
    return fallback;
  }

  if (PHOENIX_CHAINS.has(normalized)) {
    return normalized;
  }

  if (strict) {
    throw createHttpError(400, 'Phoenix chain must be either mainnet or testnet');
  }

  return fallback;
}

export function resolvePhoenixAutoLiquidityOff(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value || '')
    .trim()
    .toLowerCase();

  return normalized === 'true' || normalized === '1' || normalized === 'on';
}

async function ensureDataRoot() {
  await mkdir(dataRoot, { recursive: true });

  try {
    await access(registryPath);
  } catch {
    await writeFile(registryPath, JSON.stringify({ instances: [] }, null, 2));
  }
}

async function readRegistry() {
  await ensureDataRoot();
  return JSON.parse(await readFile(registryPath, 'utf8'));
}

async function writeRegistry(registry) {
  await writeFile(registryPath, JSON.stringify(registry, null, 2));
}

function getInstanceDirectory(instanceId) {
  return path.join(dataRoot, instanceId);
}

function getEnvPath(instanceId) {
  return path.join(getInstanceDirectory(instanceId), 'instance.env');
}

function getProjectName(instanceId) {
  return `ambrosia-${instanceId}`;
}

function getAmbrosiaSourceDir() {
  return path.resolve(process.env.AMBROSIA_SOURCE_DIR || defaultAmbrosiaSourceDir);
}

async function ensureAmbrosiaSourceDir() {
  const sourceDir = getAmbrosiaSourceDir();
  const requiredPaths = [path.join(sourceDir, 'server'), path.join(sourceDir, 'client')];

  for (const requiredPath of requiredPaths) {
    try {
      await access(requiredPath);
    } catch {
      throw createHttpError(
        500,
        `AMBROSIA_SOURCE_DIR is invalid. Expected to find ${requiredPath}. Set AMBROSIA_SOURCE_DIR to your Ambrosia repo path.`,
      );
    }
  }

  return sourceDir;
}

function getLocalNetworkIp() {
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }

  return '127.0.0.1';
}

function getUrls(instance) {
  const host = getLocalNetworkIp();

  return {
    frontendUrl: `http://${host}:${instance.clientPort}`,
    apiUrl: `http://${host}:${instance.apiPort}`,
    phoenixUrl: `http://${host}:${instance.phoenixPort}`,
    localFrontendUrl: `http://localhost:${instance.clientPort}`,
  };
}

async function enhanceWithProxyUrls(instance) {
  try {
    const { getInstanceProxyUrls } = await import('./proxy.mjs');
    const proxyUrls = await getInstanceProxyUrls(instance);
    if (proxyUrls) {
      instance.proxyFrontendUrl = proxyUrls.frontendUrl;
      instance.proxyApiUrl = proxyUrls.apiUrl;
    }
  } catch { /* proxy not configured */ }

  try {
    const { getInstanceNgrokUrls } = await import('./ngrok.mjs');
    const ngrokUrls = await getInstanceNgrokUrls(instance.id);
    if (ngrokUrls) {
      instance.proxyFrontendUrl = ngrokUrls.frontendUrl;
      instance.proxyApiUrl = ngrokUrls.apiUrl;
    }
  } catch { /* ngrok not configured */ }

  try {
    const { getInstanceCloudflareUrls } = await import('./cloudflare.mjs');
    const cfUrls = await getInstanceCloudflareUrls(instance.id);
    if (cfUrls) {
      instance.proxyFrontendUrl = cfUrls.frontendUrl;
      instance.proxyApiUrl = cfUrls.apiUrl;
    }
  } catch { /* cloudflare not configured */ }

  return instance;
}

function parseComposeJson(output) {
  const trimmed = output.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);

  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

async function runDockerCommand(args, options = {}) {
  try {
    return await runCommand('docker', ['compose', ...args], options);
  } catch (error) {
    const message = String(error?.message || '');
    const shouldFallback =
      message.includes('Required command not found: docker') ||
      message.includes("docker: 'compose' is not a docker command") ||
      message.includes("unknown shorthand flag: 'f' in -f") ||
      message.includes('Usage:  docker [OPTIONS] COMMAND');

    if (!shouldFallback) {
      throw error;
    }

    return await runCommand('docker-compose', args, options);
  }
}

async function isPortAvailable(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function reservePort(startPort, usedPorts) {
  let port = startPort;

  while (usedPorts.has(port) || !(await isPortAvailable(port))) {
    port += 1;
  }

  usedPorts.add(port);
  return port;
}

async function allocatePorts(existingInstances) {
  const usedPorts = new Set();

  for (const instance of existingInstances) {
    usedPorts.add(instance.apiPort);
    usedPorts.add(instance.clientPort);
    usedPorts.add(instance.phoenixPort);
  }

  return {
    clientPort: await reservePort(PORT_STARTS.clientPort, usedPorts),
    apiPort: await reservePort(PORT_STARTS.apiPort, usedPorts),
    phoenixPort: await reservePort(PORT_STARTS.phoenixPort, usedPorts),
  };
}

async function writeEnvFile(instance) {
  const sourceDir = await ensureAmbrosiaSourceDir();
  const phoenixChain = resolvePhoenixChain(instance.phoenixChain);
  const phoenixAutoLiquidityOff = resolvePhoenixAutoLiquidityOff(instance.phoenixAutoLiquidityOff);
  const publicApiUrl = 'http://ambrosia:9154';

  const envLines = [
    `INSTANCE_ID=${instance.id}`,
    `CLIENT_PORT=${instance.clientPort}`,
    `API_PORT=${instance.apiPort}`,
    `NEXT_PUBLIC_API_URL=${publicApiUrl}`,
    `PHOENIX_PORT=${instance.phoenixPort}`,
    `PHOENIX_CHAIN=${phoenixChain}`,
    `PHOENIX_AUTO_LIQUIDITY=${phoenixAutoLiquidityOff ? 'off' : ''}`,
    `PHOENIX_MAX_MINING_FEE=${phoenixAutoLiquidityOff ? '5000' : ''}`,
    'PHOENIXD_IMAGE=acinq/phoenixd:0.7.1',
    `AMBROSIA_VOLUME=${instance.projectName}-ambrosia-data`,
    `PHOENIX_VOLUME=${instance.projectName}-phoenix-data`,
    `AMBROSIA_SERVER_CONTEXT=${path.join(sourceDir, 'server')}`,
    `AMBROSIA_CLIENT_CONTEXT=${path.join(sourceDir, 'client')}`,
  ];

  await mkdir(getInstanceDirectory(instance.id), { recursive: true });
  await writeFile(getEnvPath(instance.id), `${envLines.join('\n')}\n`);
}

function composeArgs(instance, args) {
  return ['-f', composeFile, '--env-file', getEnvPath(instance.id), '-p', instance.projectName, ...args];
}

async function runCompose(instance, args) {
  return await runDockerCommand(composeArgs(instance, args));
}

async function inspectRuntimeStatus(instance) {
  try {
    const { stdout } = await runCompose(instance, ['ps', '--all', '--format', 'json']);
    const services = parseComposeJson(stdout);

    if (services.length === 0) {
      return 'missing';
    }

    const states = services
      .map((service) => `${service.State || service.Status || ''}`.toLowerCase())
      .filter(Boolean);

    if (states.length > 0 && states.every((state) => state.includes('running'))) {
      return 'running';
    }

    if (states.some((state) => state.includes('running'))) {
      return 'partial';
    }

    if (states.some((state) => state.includes('exited') || state.includes('stopped') || state.includes('created'))) {
      return 'stopped';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function getInstanceOrThrow(instanceId) {
  const registry = await readRegistry();
  const instance = registry.instances.find((entry) => entry.id === instanceId);

  if (!instance) {
    throw createHttpError(404, 'Instance not found');
  }

  return { registry, instance };
}

function decorateInstance(instance, runtimeStatus = instance.status || 'unknown') {
  return {
    ...instance,
    phoenixChain: resolvePhoenixChain(instance.phoenixChain),
    phoenixAutoLiquidityOff: resolvePhoenixAutoLiquidityOff(instance.phoenixAutoLiquidityOff),
    status: runtimeStatus,
    ...getUrls(instance),
  };
}

async function decorateInstanceWithProxy(instance, runtimeStatus = instance.status || 'unknown') {
  const decorated = decorateInstance(instance, runtimeStatus);
  return enhanceWithProxyUrls(decorated);
}

export async function listInstances() {
  const registry = await readRegistry();
  const instances = [];

  for (const instance of registry.instances) {
    const status = await inspectRuntimeStatus(instance);
    instances.push(await decorateInstanceWithProxy(instance, status));
  }

  return instances.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function getInstanceDiagnostics(instanceId) {
  const { instance } = await getInstanceOrThrow(instanceId);

  let services = [];
  try {
    const { stdout } = await runCompose(instance, ['ps', '--all', '--format', 'json']);
    services = parseComposeJson(stdout);
  } catch { /* docker compose ps may fail if not running */ }

  const normalizedServices = await Promise.all(
    services.map(async (service) => {
      const serviceName = service.Service || service.Name || 'unknown';
      let logs = '';

      try {
        const { stdout, stderr } = await runCompose(instance, ['logs', '--tail', '300', '--no-color', serviceName]);
        logs = `${stdout || ''}${stderr || ''}`.trim();
      } catch (error) {
        logs = String(error?.message || 'Unable to read logs');
      }

      const ports = Array.isArray(service.Publishers)
        ? service.Publishers.map((p) => (p.PublishedPort && p.TargetPort ? `${p.PublishedPort}->${p.TargetPort}` : null)).filter(Boolean)
        : [];

      return {
        name: serviceName,
        image: service.Image || '',
        state: service.State || service.Status || 'unknown',
        status: service.Status || '',
        health: service.Health || '',
        exitCode: service.ExitCode ?? null,
        ports,
        createdAt: service.CreatedAt || '',
        logs,
      };
    }),
  );

  const failingServices = normalizedServices.filter((service) => {
    const state = `${service.state}`.toLowerCase();
    return !state.includes('running');
  });

  const summary =
    failingServices.length === 0
      ? 'All services are running'
      : failingServices.map((service) => `${service.name}: ${service.state}`).join(' | ');

  return {
    instance: decorateInstance(instance),
    summary,
    services: normalizedServices,
  };
}

export async function createInstance(payload, options = {}) {
  const reportProgress = createProgressReporter(options.reportProgress);
  const displayName = String(payload?.name || '').trim();
  const phoenixChain = resolvePhoenixChain(payload?.phoenixChain, { strict: true });
  const phoenixAutoLiquidityOff = resolvePhoenixAutoLiquidityOff(payload?.phoenixAutoLiquidityOff);

  if (!displayName) {
    throw createHttpError(400, 'Instance name is required');
  }

  const id = sanitizeName(displayName);
  if (!id) {
    throw createHttpError(400, 'Instance name must contain letters or numbers');
  }

  const registry = await readRegistry();
  if (registry.instances.some((entry) => entry.id === id)) {
    throw createHttpError(409, 'An instance with that name already exists');
  }

  reportProgress({ step: 'allocating_ports', message: 'Allocating ports for the new instance', progress: 10 });
  const ports = await allocatePorts(registry.instances);
  const instance = {
    id,
    name: displayName,
    phoenixChain,
    phoenixAutoLiquidityOff,
    createdAt: new Date().toISOString(),
    projectName: getProjectName(id),
    ...ports,
    status: 'creating',
  };

  reportProgress({ step: 'writing_config', message: 'Writing instance configuration', progress: 25, instanceId: id });
  await writeEnvFile(instance);
  registry.instances.push(instance);
  await writeRegistry(registry);

  try {
    reportProgress({
      step: 'building_images',
      message: 'Building and starting Docker services',
      progress: 60,
      instanceId: id,
    });
    await runCompose(instance, ['up', '-d', '--build']);
  } catch (error) {
    await runCompose(instance, ['down', '-v']).catch(() => undefined);
    await rm(getInstanceDirectory(id), { recursive: true, force: true }).catch(() => undefined);
    registry.instances = registry.instances.filter((entry) => entry.id !== id);
    await writeRegistry(registry).catch(() => undefined);
    throw createHttpError(500, `Failed to create instance: ${error.message}`);
  }

  reportProgress({ step: 'completed', message: 'Instance is ready', progress: 100, instanceId: id });

  try {
    const { addInstanceToProxy } = await import('./proxy.mjs');
    const allInstances = registry.instances;
    await addInstanceToProxy(instance, allInstances);
  } catch { /* proxy not configured, skip */ }

  try {
    const { addInstanceTunnels } = await import('./ngrok.mjs');
    await addInstanceTunnels(instance, registry.instances);
  } catch { /* ngrok not configured, skip */ }

  try {
    const { addInstanceToCloudflare } = await import('./cloudflare.mjs');
    await addInstanceToCloudflare(instance, registry.instances);
  } catch { /* cloudflare not configured, skip */ }

  return decorateInstance(instance, 'running');
}

export async function startInstance(instanceId, options = {}) {
  const reportProgress = createProgressReporter(options.reportProgress);
  const { registry, instance } = await getInstanceOrThrow(instanceId);

  reportProgress({ step: 'starting_services', message: 'Starting Docker services', progress: 40, instanceId });
  await runCompose(instance, ['start']);
  instance.status = 'running';
  await writeRegistry(registry);

  try {
    const { addInstanceToProxy } = await import('./proxy.mjs');
    await addInstanceToProxy(instance, registry.instances);
  } catch { /* proxy not configured, skip */ }

  reportProgress({ step: 'completed', message: 'Instance is running', progress: 100, instanceId });
  return decorateInstance(instance, 'running');
}

export async function stopInstance(instanceId, options = {}) {
  const reportProgress = createProgressReporter(options.reportProgress);
  const { registry, instance } = await getInstanceOrThrow(instanceId);

  reportProgress({ step: 'stopping_services', message: 'Stopping Docker services', progress: 40, instanceId });
  await runCompose(instance, ['stop']);
  instance.status = 'stopped';
  await writeRegistry(registry);

  try {
    const { removeInstanceFromProxy } = await import('./proxy.mjs');
    await removeInstanceFromProxy(instanceId, registry.instances);
  } catch { /* proxy not configured, skip */ }

  reportProgress({ step: 'completed', message: 'Instance is stopped', progress: 100, instanceId });
  return decorateInstance(instance, 'stopped');
}

export async function rebuildInstance(instanceId, options = {}) {
  const reportProgress = createProgressReporter(options.reportProgress);
  const { registry, instance } = await getInstanceOrThrow(instanceId);

  instance.status = 'rebuilding';
  await writeRegistry(registry);
  await writeEnvFile(instance);
  reportProgress({
    step: 'rebuilding_images',
    message: 'Rebuilding images from current Ambrosia source',
    progress: 35,
    instanceId,
  });
  await runCompose(instance, ['up', '-d', '--build', '--force-recreate']);
  instance.status = 'running';
  await writeRegistry(registry);

  try {
    const { addInstanceToProxy } = await import('./proxy.mjs');
    await addInstanceToProxy(instance, registry.instances);
  } catch { /* proxy not configured, skip */ }

  reportProgress({ step: 'completed', message: 'Instance rebuilt successfully', progress: 100, instanceId });
  return decorateInstance(instance, 'running');
}

export async function toggleInstanceAutoLiquidity(instanceId, enabled, options = {}) {
  const reportProgress = createProgressReporter(options.reportProgress);
  const { registry, instance } = await getInstanceOrThrow(instanceId);
  const currentValue = resolvePhoenixAutoLiquidityOff(instance.phoenixAutoLiquidityOff);
  const nextValue = resolvePhoenixAutoLiquidityOff(enabled);

  if (currentValue === nextValue) {
    return decorateInstance(instance, instance.status || 'running');
  }

  instance.status = 'rebuilding';
  instance.phoenixAutoLiquidityOff = nextValue;
  await writeRegistry(registry);
  await writeEnvFile(instance);

  reportProgress({
    step: 'stopping_services',
    message: 'Stopping services before toggling auto-liquidity',
    progress: 30,
    instanceId,
  });
  await runCompose(instance, ['down']);

  reportProgress({
    step: 'starting_services',
    message: `Recreating services with ${nextValue ? 'manual' : 'auto'} liquidity`,
    progress: 70,
    instanceId,
  });
  await runCompose(instance, ['up', '-d', '--force-recreate']);

  instance.status = 'running';
  await writeRegistry(registry);

  try {
    const { addInstanceToProxy } = await import('./proxy.mjs');
    await addInstanceToProxy(instance, registry.instances);
  } catch { /* proxy not configured, skip */ }

  reportProgress({
    step: 'completed',
    message: `Instance switched to ${nextValue ? 'manual' : 'auto'} liquidity`,
    progress: 100,
    instanceId,
  });
  return decorateInstance(instance, 'running');
}

export async function switchInstancePhoenixChain(instanceId, phoenixChain, options = {}) {
  const reportProgress = createProgressReporter(options.reportProgress);
  const { registry, instance } = await getInstanceOrThrow(instanceId);
  const nextChain = resolvePhoenixChain(phoenixChain, { strict: true });

  if (resolvePhoenixChain(instance.phoenixChain) === nextChain) {
    return decorateInstance(instance, instance.status || 'running');
  }

  instance.status = 'rebuilding';
  instance.phoenixChain = nextChain;
  await writeRegistry(registry);
  await writeEnvFile(instance);

  reportProgress({
    step: 'stopping_services',
    message: 'Stopping services before switching Phoenix chain',
    progress: 30,
    instanceId,
  });
  await runCompose(instance, ['down']);

  reportProgress({
    step: 'starting_services',
    message: 'Recreating services on the selected Phoenix chain without deleting Phoenixd data',
    progress: 70,
    instanceId,
  });
  await runCompose(instance, ['up', '-d', '--force-recreate']);

  instance.status = 'running';
  await writeRegistry(registry);

  try {
    const { addInstanceToProxy } = await import('./proxy.mjs');
    await addInstanceToProxy(instance, registry.instances);
  } catch { /* proxy not configured, skip */ }

  reportProgress({
    step: 'completed',
    message: `Instance switched to ${nextChain}`,
    progress: 100,
    instanceId,
  });
  return decorateInstance(instance, 'running');
}

export async function deleteInstance(instanceId, options = {}) {
  const reportProgress = createProgressReporter(options.reportProgress);
  const { registry, instance } = await getInstanceOrThrow(instanceId);

  reportProgress({ step: 'removing_registry', message: 'Removing instance from inventory', progress: 20, instanceId });
  registry.instances = registry.instances.filter((entry) => entry.id !== instanceId);
  await writeRegistry(registry);

  try {
    const { removeInstanceFromProxy } = await import('./proxy.mjs');
    await removeInstanceFromProxy(instanceId, registry.instances);
  } catch { /* proxy not configured, skip */ }

  try {
    const { removeInstanceTunnels } = await import('./ngrok.mjs');
    await removeInstanceTunnels(instanceId, registry.instances);
  } catch { /* ngrok not configured, skip */ }

  try {
    const { removeInstanceFromCloudflare } = await import('./cloudflare.mjs');
    await removeInstanceFromCloudflare(instanceId, registry.instances);
  } catch { /* cloudflare not configured, skip */ }

  reportProgress({ step: 'removing_containers', message: 'Removing containers and volumes', progress: 65, instanceId });
  await runCompose(instance, ['down', '-v']);
  await rm(getInstanceDirectory(instanceId), { recursive: true, force: true });
  reportProgress({ step: 'completed', message: 'Instance deleted', progress: 100, instanceId });
}
