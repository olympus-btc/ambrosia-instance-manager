import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('../src/instances.mjs', () => ({
  createInstance: vi.fn(async (payload, _opts) => {
    if (!payload?.name) {
      const err = new Error('Instance name is required');
      err.statusCode = 400;
      throw err;
    }
    return { id: payload.name.toLowerCase(), name: payload.name, status: 'running' };
  }),
  deleteInstance: vi.fn(async () => ({ id: 'test', status: 'deleted' })),
  getInstanceDiagnostics: vi.fn(async () => ({
    instance: { id: 'test', status: 'running' },
    summary: 'All services running',
    services: [],
  })),
  listInstances: vi.fn(async () => [
    { id: 'demo', name: 'Demo', status: 'running', phoenixChain: 'mainnet', phoenixAutoLiquidityOff: false },
  ]),
  rebuildInstance: vi.fn(async () => ({ id: 'test', status: 'running' })),
  startInstance: vi.fn(async () => ({ id: 'test', status: 'running' })),
  stopInstance: vi.fn(async () => ({ id: 'test', status: 'stopped' })),
  switchInstancePhoenixChain: vi.fn(async () => ({ id: 'test', status: 'running' })),
  toggleInstanceAutoLiquidity: vi.fn(async () => ({ id: 'test', status: 'running' })),
}));

vi.mock('../src/proxy.mjs', () => ({
  addInstanceToProxy: vi.fn(),
  configureProxy: vi.fn(async () => ({ baseDomain: 'example.com', email: 'admin@example.com', enabled: true })),
  disableProxy: vi.fn(async () => ({ enabled: false })),
  enableProxy: vi.fn(async () => ({ enabled: true })),
  getInstanceProxyUrls: vi.fn(async () => null),
  getProxyStatus: vi.fn(async () => ({ enabled: false, running: false, baseDomain: null, email: null })),
  refreshProxyConfig: vi.fn(async () => {}),
  removeInstanceFromProxy: vi.fn(),
  renewCertificates: vi.fn(async () => {}),
}));

vi.mock('../src/ngrok.mjs', () => ({
  addInstanceTunnels: vi.fn(),
  configureNgrok: vi.fn(async () => ({ enabled: true })),
  disableNgrok: vi.fn(async () => ({ enabled: false })),
  enableNgrok: vi.fn(async () => ({ enabled: true })),
  getInstanceNgrokUrls: vi.fn(async () => null),
  getNgrokStatus: vi.fn(async () => ({ enabled: false, running: false, installed: true })),
  removeInstanceTunnels: vi.fn(),
}));

vi.mock('../src/cloudflare.mjs', () => ({
  addInstanceToCloudflare: vi.fn(),
  configureCloudflare: vi.fn(async () => ({ enabled: true, tunnelName: 'ambrosiapay' })),
  disableCloudflare: vi.fn(async () => ({ enabled: false })),
  enableCloudflare: vi.fn(async () => ({ enabled: true, domain: 'vidarte.site' })),
  getCloudflareStatus: vi.fn(async () => ({
    enabled: true,
    installed: true,
    running: true,
    tunnelToken: null,
    domain: 'vidarte.site',
    tunnelName: 'ambrosiapay',
  })),
  getInstanceCloudflareUrls: vi.fn(async () => null),
  removeInstanceFromCloudflare: vi.fn(),
  setCloudflareDomain: vi.fn(async ({ domain }) => ({ domain })),
}));

let baseUrl;
let server;

beforeAll(async () => {
  const mod = await import('../server.mjs');
  server = mod.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  server.close();
});

async function api(path, { method = 'GET', body = null } = {}) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, opts);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('API endpoints', () => {
  describe('GET /api/health', () => {
    it('returns ok status', async () => {
      const res = await api('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('GET /api/instances', () => {
    it('returns list of instances', async () => {
      const res = await api('/api/instances');
      expect(res.status).toBe(200);
      expect(res.body.instances).toHaveLength(1);
      expect(res.body.instances[0].id).toBe('demo');
    });
  });

  describe('GET /api/jobs', () => {
    it('returns jobs list', async () => {
      const res = await api('/api/jobs');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.jobs)).toBe(true);
    });
  });

  describe('GET /api/cloudflare', () => {
    it('returns Cloudflare status', async () => {
      const res = await api('/api/cloudflare');
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.domain).toBe('vidarte.site');
    });
  });

  describe('POST /api/cloudflare/enable', () => {
    it('enables Cloudflare mode', async () => {
      const res = await api('/api/cloudflare/enable', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.domain).toBe('vidarte.site');
    });
  });

  describe('GET /api/instances/:id/diagnostics', () => {
    it('returns diagnostics for an instance', async () => {
      const res = await api('/api/instances/test/diagnostics');
      expect(res.status).toBe(200);
      expect(res.body.instance.id).toBe('test');
    });
  });

  describe('GET /api/qr', () => {
    it('returns QR SVG when text is provided', async () => {
      const res = await fetch(`${baseUrl}/api/qr?text=hello`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      const svg = await res.text();
      expect(svg).toContain('<svg');
    });

    it('returns 400 when text is missing', async () => {
      const res = await api('/api/qr');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Missing text query parameter');
    });
  });

  describe('POST /api/instances', () => {
    it('creates an instance and returns a job', async () => {
      const res = await api('/api/instances', {
        method: 'POST',
        body: { name: 'my-store', phoenixChain: 'mainnet' },
      });
      expect(res.status).toBe(202);
      expect(res.body.job).toBeDefined();
      expect(res.body.job.action).toBe('create');
    });
  });

  describe('POST /api/instances/:id/start', () => {
    it('starts an instance and returns a job', async () => {
      const res = await api('/api/instances/test/start', { method: 'POST' });
      expect(res.status).toBe(202);
      expect(res.body.job.action).toBe('start');
    });
  });

  describe('POST /api/instances/:id/stop', () => {
    it('stops an instance and returns a job', async () => {
      const res = await api('/api/instances/test/stop', { method: 'POST' });
      expect(res.status).toBe(202);
      expect(res.body.job.action).toBe('stop');
    });
  });

  describe('POST /api/instances/:id/rebuild', () => {
    it('rebuilds an instance and returns a job', async () => {
      const res = await api('/api/instances/test/rebuild', { method: 'POST' });
      expect(res.status).toBe(202);
      expect(res.body.job.action).toBe('rebuild');
    });
  });

  describe('POST /api/instances/:id/phoenix-chain', () => {
    it('switches chain and returns a job', async () => {
      const res = await api('/api/instances/test/phoenix-chain', {
        method: 'POST',
        body: { phoenixChain: 'testnet' },
      });
      expect(res.status).toBe(202);
      expect(res.body.job.action).toBe('switch_chain');
    });
  });

  describe('POST /api/instances/:id/toggle-autoliquidity', () => {
    it('toggles auto-liquidity and returns a job', async () => {
      const res = await api('/api/instances/test/toggle-autoliquidity', {
        method: 'POST',
        body: { phoenixAutoLiquidityOff: true },
      });
      expect(res.status).toBe(202);
      expect(res.body.job.action).toBe('toggle_autoliquidity');
    });
  });

  describe('DELETE /api/instances/:id', () => {
    it('deletes an instance and returns a job', async () => {
      const res = await api('/api/instances/test', { method: 'DELETE' });
      expect(res.status).toBe(202);
      expect(res.body.job.action).toBe('delete');
    });
  });

  describe('unknown routes', () => {
    it('returns 404', async () => {
      const res = await api('/api/unknown');
      expect(res.status).toBe(404);
    });
  });
});
