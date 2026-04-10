import { createServer } from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import qrcode from "qr.js";

import {
  createInstance,
  deleteInstance,
  getInstanceDiagnostics,
  listInstances,
  rebuildInstance,
  startInstance,
  stopInstance,
  switchInstancePhoenixChain,
  toggleInstanceAutoLiquidity,
} from "./src/instances.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;
const publicDir = path.join(projectRoot, "public");
const port = Number.parseInt(process.env.ADMIN_PORT || "3010", 10);
const host = process.env.ADMIN_HOST || "127.0.0.1";
const jobs = new Map();

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
};

function log(level, message, extra) {
  const timestamp = new Date().toISOString();
  if (extra === undefined) {
    console[level](`[${timestamp}] ${message}`);
    return;
  }

  console[level](`[${timestamp}] ${message}`, extra);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function listJobs() {
  return Array.from(jobs.values()).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function createJob({ action, instanceId = null, targetName = null }) {
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    action,
    instanceId,
    targetName,
    status: "queued",
    progress: 0,
    step: "queued",
    message: "Queued",
    steps: [{ step: "queued", message: "Queued", progress: 0, at: now }],
    startedAt: now,
    finishedAt: null,
    error: null,
  };
  jobs.set(job.id, job);
  return job;
}

function updateJob(jobId, patch) {
  const existing = jobs.get(jobId);
  if (!existing) return;
  const updated = { ...existing, ...patch };
  if (patch.step && patch.step !== existing.step) {
    updated.steps = [
      ...(existing.steps || []),
      { step: patch.step, message: patch.message || "", progress: patch.progress ?? 0, at: new Date().toISOString() },
    ];
  }
  jobs.set(jobId, updated);
}

function runJob(job, task) {
  updateJob(job.id, { status: "running", progress: 5, message: "Starting operation" });

  task({
    reportProgress: ({ step, message, progress, instanceId }) => {
      updateJob(job.id, {
        status: "running",
        step: step || "running",
        message: message || "Running operation",
        progress: typeof progress === "number" ? progress : jobs.get(job.id)?.progress ?? 0,
        instanceId: instanceId ?? jobs.get(job.id)?.instanceId ?? null,
      });
    },
  })
    .then(() => {
      updateJob(job.id, {
        status: "completed",
        step: "completed",
        message: "Operation completed",
        progress: 100,
        finishedAt: new Date().toISOString(),
      });
    })
    .catch((error) => {
      log("error", `Background ${job.action} failed for ${job.instanceId || job.targetName || job.id}`, error);
      updateJob(job.id, {
        status: "failed",
        step: "failed",
        message: error.message || "Operation failed",
        error: error.message || "Operation failed",
        finishedAt: new Date().toISOString(),
      });
    });
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function generateQrSvg(text) {
  const code = qrcode(text, { errorCorrectLevel: qrcode.ErrorCorrectLevel.M });
  const modules = code.modules || [];
  const size = modules.length;
  const quietZone = 2;
  const viewBoxSize = size + quietZone * 2;

  const pathData = modules
    .map((row, rowIndex) =>
      row
        .map((cell, cellIndex) =>
          cell ? `M ${cellIndex + quietZone} ${rowIndex + quietZone} l 1 0 0 1 -1 0 Z` : "",
        )
        .join(" "),
    )
    .join(" ");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" shape-rendering="crispEdges" role="img" aria-label="QR code for ${escapeXml(text)}">\n  <rect width="${viewBoxSize}" height="${viewBoxSize}" fill="#fffaf2"/>\n  <path d="${pathData}" fill="#14213d"/>\n</svg>`;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(response, assetPath) {
  const extension = path.extname(assetPath);
  const fileContents = await readFile(assetPath);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
  });
  response.end(fileContents);
}

const server = createServer(async (request, response) => {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const startedAt = Date.now();
  let statusCode = 500;

  log("info", `--> ${method} ${url.pathname}`);

  try {
    if (method === "GET" && url.pathname === "/api/health") {
      statusCode = 200;
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (method === "GET" && url.pathname === "/api/instances") {
      statusCode = 200;
      sendJson(response, 200, { instances: await listInstances() });
      return;
    }

    if (method === "GET" && url.pathname === "/api/jobs") {
      statusCode = 200;
      sendJson(response, 200, { jobs: listJobs() });
      return;
    }

    const diagnosticsMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/diagnostics$/);
    if (method === "GET" && diagnosticsMatch) {
      const [, instanceId] = diagnosticsMatch;
      statusCode = 200;
      sendJson(response, 200, await getInstanceDiagnostics(instanceId));
      return;
    }

    if (method === "GET" && url.pathname === "/api/qr") {
      const text = url.searchParams.get("text");
      if (!text) {
        statusCode = 400;
        sendJson(response, 400, { error: "Missing text query parameter" });
        return;
      }

      const svg = generateQrSvg(text);
      statusCode = 200;
      response.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
      response.end(svg);
      return;
    }

    if (method === "POST" && url.pathname === "/api/instances") {
      const body = await readJsonBody(request);
      log("info", "Creating instance request received", body);
      const job = createJob({ action: "create", targetName: String(body?.name || "").trim() || null });
      runJob(job, (options) => createInstance(body, options));
      statusCode = 202;
      sendJson(response, 202, { job });
      return;
    }

    const instanceActionMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/(start|stop|rebuild)$/);
    if (method === "POST" && instanceActionMatch) {
      const [, instanceId, action] = instanceActionMatch;
      const job = createJob({ action, instanceId });
      runJob(job, (options) =>
        action === "start"
          ? startInstance(instanceId, options)
          : action === "stop"
            ? stopInstance(instanceId, options)
            : rebuildInstance(instanceId, options),
      );
      statusCode = 202;
      sendJson(response, 202, { job });
      return;
    }

    const chainSwitchMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/phoenix-chain$/);
    if (method === "POST" && chainSwitchMatch) {
      const [, instanceId] = chainSwitchMatch;
      const body = await readJsonBody(request);
      const job = createJob({ action: "switch_chain", instanceId });
      runJob(job, (options) => switchInstancePhoenixChain(instanceId, body?.phoenixChain, options));
      statusCode = 202;
      sendJson(response, 202, { job });
      return;
    }

    const autoLiquidityMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/toggle-autoliquidity$/);
    if (method === "POST" && autoLiquidityMatch) {
      const [, instanceId] = autoLiquidityMatch;
      const body = await readJsonBody(request);
      const job = createJob({ action: "toggle_autoliquidity", instanceId });
      runJob(job, (options) => toggleInstanceAutoLiquidity(instanceId, body?.phoenixAutoLiquidityOff, options));
      statusCode = 202;
      sendJson(response, 202, { job });
      return;
    }

    const deleteMatch = url.pathname.match(/^\/api\/instances\/([^/]+)$/);
    if (method === "DELETE" && deleteMatch) {
      const [, instanceId] = deleteMatch;
      const job = createJob({ action: "delete", instanceId });
      runJob(job, (options) => deleteInstance(instanceId, options));
      statusCode = 202;
      sendJson(response, 202, { job });
      return;
    }

    if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      statusCode = 200;
      await serveStatic(response, path.join(publicDir, "index.html"));
      return;
    }

    if (method === "GET" && ["/app.js", "/styles.css", "/ambrosia-icon.png"].includes(url.pathname)) {
      statusCode = 200;
      await serveStatic(response, path.join(publicDir, url.pathname.slice(1)));
      return;
    }

    statusCode = 404;
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    statusCode = error.statusCode || 500;
    log("error", `${method} ${url.pathname} failed`, error);
    sendJson(response, statusCode, { error: error.message || "Internal server error" });
  } finally {
    const durationMs = Date.now() - startedAt;
    log("info", `<-- ${method} ${url.pathname} ${statusCode} ${durationMs}ms`);
  }
});

server.listen(port, host, () => {
  log("info", `Ambrosia instance manager available at http://${host}:${port}`);
});

process.on("uncaughtException", (error) => {
  log("error", "Uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled rejection", reason);
});
