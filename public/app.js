const feedback = document.querySelector("#feedback");
const tableWrapper = document.querySelector("#table-wrapper");
const createForm = document.querySelector("#create-form");
const createInput = document.querySelector("#instance-name");
const chainSelect = document.querySelector("#phoenix-chain");
const autoLiquidityCheckbox = document.querySelector("#phoenix-auto-liquidity-off");
const refreshButton = document.querySelector("#refresh-button");
const themeToggle = document.querySelector("#theme-toggle");
const jobPanel = document.querySelector("#job-panel");
const jobTitle = document.querySelector("#job-title");
const jobStatus = document.querySelector("#job-status");
const jobMessage = document.querySelector("#job-message");
const jobProgressBar = document.querySelector("#job-progress-bar");
const qrDialog = document.querySelector("#qr-dialog");
const qrTitle = document.querySelector("#qr-title");
const qrImage = document.querySelector("#qr-image");
const qrLink = document.querySelector("#qr-link");
const copyLinkButton = document.querySelector("#copy-link-button");
const confirmDialog = document.querySelector("#confirm-dialog");
const confirmTitle = document.querySelector("#confirm-title");
const confirmMessage = document.querySelector("#confirm-message");
const confirmAcceptButton = document.querySelector("#confirm-accept-button");
const diagnosticsDialog = document.querySelector("#diagnostics-dialog");
const diagnosticsTitle = document.querySelector("#diagnostics-title");
const diagnosticsSummary = document.querySelector("#diagnostics-summary");
const diagnosticsContent = document.querySelector("#diagnostics-content");
const THEME_STORAGE_KEY = "ambrosia-admin-theme";
let instancesCache = [];
let jobsCache = [];
let jobsPollTimer = null;
let confirmResolver = null;

function getThemeLabel(theme) {
  return theme === "dark" ? "Light mode" : "Dark mode";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  if (themeToggle) {
    themeToggle.textContent = getThemeLabel(theme);
    themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
  }
}

function setFeedback(message, tone = "neutral") {
  feedback.textContent = message;
  feedback.dataset.tone = tone;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusBadge(status) {
  const tone = {
    running: "good",
    stopped: "muted",
    partial: "warn",
    creating: "warn",
    rebuilding: "warn",
    failed: "bad",
    unknown: "muted",
    missing: "muted",
  }[status] || "muted";

  return `<span class="badge badge-${tone}">${escapeHtml(status)}</span>`;
}

function formatServiceLogs(logs) {
  if (!logs) {
    return "No logs available.";
  }

  return escapeHtml(logs);
}

function formatActionLabel(action) {
  return {
    create: "Creating instance",
    start: "Starting instance",
    stop: "Stopping instance",
    rebuild: "Rebuilding instance",
    switch_chain: "Switching Phoenix chain",
    delete: "Deleting instance",
  }[action] || "Running operation";
}

function isJobActive(job) {
  return job.status === "queued" || job.status === "running";
}

function getActiveJobs() {
  return jobsCache.filter(isJobActive);
}

function findInstanceJob(instanceId) {
  return getActiveJobs().find((job) => job.instanceId === instanceId);
}

function renderJobPanel() {
  const activeJob = getActiveJobs()[0];

  if (!activeJob) {
    jobPanel.hidden = true;
    return;
  }

  jobPanel.hidden = false;
  jobTitle.textContent = formatActionLabel(activeJob.action);
  jobStatus.textContent = activeJob.status;
  jobMessage.textContent = activeJob.message || "Running operation";
  jobProgressBar.style.width = `${Math.max(6, activeJob.progress || 0)}%`;
}

function updateBusyState() {
  const activeJobs = getActiveJobs();
  const isCreateRunning = activeJobs.some((job) => job.action === "create");

  createInput.disabled = isCreateRunning;
  if (chainSelect) {
    chainSelect.disabled = isCreateRunning;
  }
  if (autoLiquidityCheckbox) {
    autoLiquidityCheckbox.disabled = isCreateRunning;
  }
  createForm.querySelector('button[type="submit"]').disabled = isCreateRunning;
  refreshButton.disabled = activeJobs.length > 0;
}

function renderInstances(instances) {
  instancesCache = instances;
  if (instances.length === 0) {
    tableWrapper.innerHTML = `
      <div class="empty-state">
        <h3>No instances yet</h3>
        <p>Create the first local Ambrosia environment from the form above.</p>
      </div>
    `;
    return;
  }

  tableWrapper.innerHTML = `<div class="instance-grid">${instances.map(renderInstanceCard).join("")}</div>`;
}

function renderInstanceCard(instance) {
  const activeJob = findInstanceJob(instance.id);
  const isLocked = Boolean(activeJob);
  const disabled = isLocked ? "disabled" : "";
  const status = instance.status || "unknown";
  const isRunning = status === "running";
  const isStopped = status === "stopped";
  const nextChain = (instance.phoenixChain || "mainnet") === "mainnet" ? "testnet" : "mainnet";
  const switchLabel = nextChain === "mainnet" ? "Mainnet" : "Testnet";

  const jobMeta = activeJob
    ? `<div class="instance-job">${escapeHtml(activeJob.message || formatActionLabel(activeJob.action))}</div>`
    : "";

  return `
    <div class="instance-card" data-instance="${escapeHtml(instance.id)}">
      <div class="instance-card-header">
        <div class="instance-card-title">
          <strong class="instance-name">${escapeHtml(instance.name)}</strong>
          <span class="subtle">${escapeHtml(instance.id)}</span>
        </div>
        <div class="instance-card-badges">
          ${statusBadge(status)}
          ${statusBadge(instance.phoenixChain || "mainnet")}
          ${statusBadge(instance.phoenixAutoLiquidityOff ? "manual liquidity" : "auto liquidity")}
        </div>
      </div>

      ${jobMeta}

      <div class="instance-card-urls">
        <a href="${escapeHtml(instance.frontendUrl)}" target="_blank" rel="noreferrer" class="instance-url instance-url-frontend">
          <span class="instance-url-label">Frontend</span>
          <span class="instance-url-value">${escapeHtml(instance.frontendUrl)}</span>
        </a>
        <div class="instance-url-group">
          <span class="instance-url-item"><span class="instance-url-label">API</span> <code>${escapeHtml(instance.apiUrl)}</code></span>
          <span class="instance-url-item"><span class="instance-url-label">Phoenixd</span> <code>${escapeHtml(instance.phoenixUrl)}</code></span>
        </div>
      </div>

      <div class="instance-card-actions">
        <div class="action-group action-group-primary">
          <button data-action="open" data-id="${escapeHtml(instance.id)}" ${disabled}>Open</button>
          <button data-action="diagnostics" data-id="${escapeHtml(instance.id)}" class="secondary" ${disabled}>Logs</button>
          <button data-action="qr" data-id="${escapeHtml(instance.id)}" data-url="${escapeHtml(instance.frontendUrl)}" data-name="${escapeHtml(instance.name)}" class="secondary" ${disabled}>QR</button>
          <button data-action="copy-local" data-id="${escapeHtml(instance.id)}" data-url="${escapeHtml(instance.localFrontendUrl)}" class="secondary" ${disabled}>Copy localhost</button>
        </div>
        <div class="action-group action-group-secondary">
          ${isStopped ? `<button data-action="start" data-id="${escapeHtml(instance.id)}" class="secondary" ${disabled}>Start</button>` : ""}
          ${isRunning ? `<button data-action="stop" data-id="${escapeHtml(instance.id)}" class="secondary" ${disabled}>Stop</button>` : ""}
          <button data-action="switch-chain" data-id="${escapeHtml(instance.id)}" data-chain="${escapeHtml(nextChain)}" class="secondary" ${disabled}>${switchLabel}</button>
          <button data-action="rebuild" data-id="${escapeHtml(instance.id)}" class="secondary" ${disabled}>Rebuild</button>
        </div>
        <div class="action-group action-group-danger">
          <button data-action="delete" data-id="${escapeHtml(instance.id)}" class="danger" ${disabled}>Delete</button>
        </div>
        <div class="instance-card-meta">
          <span class="subtle">Created ${new Date(instance.createdAt).toLocaleDateString()}</span>
        </div>
      </div>
    </div>
  `;
}

async function fetchInstances() {
  const response = await fetch("/api/instances");
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Failed to load instances");
  }

  renderInstances(payload.instances);
}

async function fetchJobs() {
  const response = await fetch("/api/jobs");
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Failed to load jobs");
  }

  jobsCache = payload.jobs;
  renderJobPanel();
  renderInstances(instancesCache);
  updateBusyState();
}

function stopJobsPolling() {
  if (!jobsPollTimer) {
    return;
  }

  window.clearInterval(jobsPollTimer);
  jobsPollTimer = null;
}

function ensureJobsPolling() {
  if (jobsPollTimer) {
    return;
  }

  jobsPollTimer = window.setInterval(async () => {
    try {
      await fetchJobs();
      if (getActiveJobs().length === 0) {
        stopJobsPolling();
        await fetchInstances();
        setFeedback("Operation finished", "good");
      }
    } catch (error) {
      setFeedback(error.message, "bad");
    }
  }, 1500);
}

async function mutateInstance(url, options, successMessage) {
  setFeedback("Starting operation...", "neutral");

  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }

  setFeedback(successMessage, "good");
  await fetchJobs();
  ensureJobsPolling();
  await fetchInstances();
}

function openQrDialog(name, url) {
  qrTitle.textContent = `${name} access`;
  qrLink.href = url;
  qrLink.textContent = url;
  qrImage.src = `/api/qr?text=${encodeURIComponent(url)}`;
  qrImage.alt = `QR code for ${name}`;
  copyLinkButton.dataset.url = url;
  qrDialog.showModal();
}

function openConfirmDialog({ title, message, confirmLabel = "Confirm" }) {
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmAcceptButton.textContent = confirmLabel;
  confirmDialog.showModal();

  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

async function copyUrl(url, successMessage) {
  await navigator.clipboard.writeText(url);
  setFeedback(successMessage, "good");
}

async function openDiagnosticsDialog(instanceId) {
  diagnosticsTitle.textContent = `Diagnostics for ${instanceId}`;
  diagnosticsSummary.textContent = "Loading diagnostics...";
  diagnosticsContent.innerHTML = "";
  diagnosticsDialog.showModal();

  const response = await fetch(`/api/instances/${instanceId}/diagnostics`);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Failed to load diagnostics");
  }

  diagnosticsSummary.textContent = payload.summary || "No summary available";
  diagnosticsContent.innerHTML = payload.services
    .map(
      (service) => `
        <section class="diagnostic-service">
          <div class="section-header diagnostic-service-header">
            <div>
              <h3>${escapeHtml(service.name)}</h3>
              <p class="subtle">${escapeHtml(service.status || service.state || "unknown")}</p>
            </div>
            ${statusBadge(service.state || "unknown")}
          </div>
          <pre class="log-output">${formatServiceLogs(service.logs)}</pre>
        </section>
      `,
    )
    .join("");
}

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(createForm);
  const name = formData.get("name");
  const phoenixChain = formData.get("phoenixChain");
  const phoenixAutoLiquidityOff = formData.get("phoenixAutoLiquidityOff") === "on";

  try {
    setFeedback("Creating instance. The first build can take a while...", "neutral");
    const response = await fetch("/api/instances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, phoenixChain, phoenixAutoLiquidityOff }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Failed to create instance");
    }

    createForm.reset();
    setFeedback("Instance creation started", "good");
    await fetchJobs();
    ensureJobsPolling();
    await fetchInstances();
  } catch (error) {
    setFeedback(error.message, "bad");
  }
});

refreshButton.addEventListener("click", async () => {
  try {
    setFeedback("Refreshing instance inventory...", "neutral");
    await fetchInstances();
    setFeedback("Inventory refreshed", "good");
  } catch (error) {
    setFeedback(error.message, "bad");
  }
});

tableWrapper.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.action;
  const instanceId = button.dataset.id;

  try {
    if (action === "open") {
      const rowLink = button.closest("tr")?.querySelector("a");
      if (rowLink) {
        window.open(rowLink.href, "_blank", "noopener,noreferrer");
      }
      return;
    }

    if (action === "qr") {
      openQrDialog(button.dataset.name || instanceId, button.dataset.url);
      return;
    }

    if (action === "copy-local") {
      await copyUrl(button.dataset.url, "Localhost URL copied to clipboard");
      return;
    }

    if (action === "diagnostics") {
      await openDiagnosticsDialog(instanceId);
      return;
    }

    if (action === "switch-chain") {
      const nextChain = button.dataset.chain || "mainnet";
      const confirmed = await openConfirmDialog({
        title: `Switch ${instanceId} to ${nextChain}`,
        message: `This will stop the instance and recreate its services on ${nextChain}. Existing Phoenixd data will be kept.`,
        confirmLabel: `Switch to ${nextChain}`,
      });
      if (!confirmed) {
        return;
      }

      await mutateInstance(
        `/api/instances/${instanceId}/phoenix-chain`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phoenixChain: nextChain }),
        },
        `Instance switch to ${nextChain} started`,
      );
      return;
    }

    if (action === "start") {
      await mutateInstance(`/api/instances/${instanceId}/start`, { method: "POST" }, "Instance started");
      return;
    }

    if (action === "stop") {
      await mutateInstance(`/api/instances/${instanceId}/stop`, { method: "POST" }, "Instance stopped");
      return;
    }

    if (action === "rebuild") {
      await mutateInstance(`/api/instances/${instanceId}/rebuild`, { method: "POST" }, "Instance rebuild started");
      return;
    }

    if (action === "delete") {
      const confirmed = await openConfirmDialog({
        title: `Delete ${instanceId}`,
        message: `This will remove the instance "${instanceId}", its containers, Phoenix node data, and Ambrosia database volumes.`,
        confirmLabel: "Delete instance",
      });
      if (!confirmed) {
        return;
      }

      await mutateInstance(`/api/instances/${instanceId}`, { method: "DELETE" }, "Instance deleted");
    }
  } catch (error) {
    setFeedback(error.message, "bad");
  }
});

copyLinkButton.addEventListener("click", async () => {
  const url = copyLinkButton.dataset.url;
  if (!url) {
    return;
  }

  try {
    await copyUrl(url, "Instance URL copied to clipboard");
  } catch (error) {
    setFeedback(`Could not copy URL: ${error.message}`, "bad");
  }
});

confirmAcceptButton.addEventListener("click", () => {
  confirmDialog.close("confirm");
});

confirmDialog.addEventListener("close", () => {
  if (!confirmResolver) {
    return;
  }

  const resolver = confirmResolver;
  confirmResolver = null;
  resolver(confirmDialog.returnValue === "confirm");
});

themeToggle?.addEventListener("click", () => {
  const currentTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const nextTheme = currentTheme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  applyTheme(nextTheme);
});

applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");

Promise.all([fetchInstances(), fetchJobs()])
  .then(() => {
    if (getActiveJobs().length > 0) {
      ensureJobsPolling();
      setFeedback("Operation in progress", "neutral");
      return;
    }

    setFeedback("Instance inventory loaded", "good");
  })
  .catch((error) => setFeedback(error.message, "bad"));
