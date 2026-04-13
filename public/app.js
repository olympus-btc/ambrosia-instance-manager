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
const jobProgressBar = document.querySelector("#job-progress-bar");
const jobSteps = document.querySelector("#job-steps");
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
const diagnosticsServicesBar = document.querySelector("#diagnostics-services-bar");
const diagnosticsRefreshBtn = document.querySelector("#diagnostics-refresh");
const diagnosticsAutorefreshBtn = document.querySelector("#diagnostics-autorefresh");
const proxyForm = document.querySelector("#proxy-form");
const proxyDomainInput = document.querySelector("#proxy-domain");
const proxyEmailInput = document.querySelector("#proxy-email");
const proxyFeedback = document.querySelector("#proxy-feedback");
const proxyStatusBadges = document.querySelector("#proxy-status-badges");
const proxyRefreshButton = document.querySelector("#proxy-refresh-button");
const proxyRenewButton = document.querySelector("#proxy-renew-button");
const tabNgrok = document.querySelector("#tab-ngrok");
const tabNginx = document.querySelector("#tab-nginx");
const panelNgrok = document.querySelector("#panel-ngrok");
const panelNginx = document.querySelector("#panel-nginx");
const ngrokForm = document.querySelector("#ngrok-form");
const ngrokAuthtokenInput = document.querySelector("#ngrok-authtoken");
const ngrokFeedback = document.querySelector("#ngrok-feedback");
const ngrokStatusBadges = document.querySelector("#ngrok-status-badges");
const ngrokEnableButton = document.querySelector("#ngrok-enable-button");
const ngrokDisableButton = document.querySelector("#ngrok-disable-button");
const tabCloudflare = document.querySelector("#tab-cloudflare");
const panelCloudflare = document.querySelector("#panel-cloudflare");
const cloudflareForm = document.querySelector("#cloudflare-form");
const cloudflareTokenInput = document.querySelector("#cloudflare-token");
const cloudflareDomainInput = document.querySelector("#cloudflare-domain");
const cloudflareFeedback = document.querySelector("#cloudflare-feedback");
const cloudflareStatusBadges = document.querySelector("#cloudflare-status-badges");
const cloudflareEnableButton = document.querySelector("#cloudflare-enable-button");
const cloudflareDisableButton = document.querySelector("#cloudflare-disable-button");
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

function formatActionLabel(action) {
  return {
    create: "Creating instance",
    start: "Starting instance",
    stop: "Stopping instance",
    rebuild: "Rebuilding instance",
    switch_chain: "Switching Phoenix chain",
    toggle_autoliquidity: "Toggling auto-liquidity",
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
  jobProgressBar.style.width = `${Math.max(6, activeJob.progress || 0)}%`;

  const steps = activeJob.steps || [];
  const isTerminal = activeJob.status === "completed" || activeJob.status === "failed";

  jobSteps.innerHTML = steps.map((s, i) => {
    const isLast = i === steps.length - 1;
    let icon;
    let cls;
    if (activeJob.status === "failed" && isLast) {
      icon = "\u2717";
      cls = "job-step-failed";
    } else if (isTerminal && isLast) {
      icon = "\u2713";
      cls = "job-step-done";
    } else if (isLast && activeJob.status === "running") {
      icon = "\u25CF";
      cls = "job-step-active";
    } else {
      icon = "\u2713";
      cls = "job-step-done";
    }
    return `<div class="job-step ${cls}"><span class="job-step-icon">${icon}</span> <span class="job-step-text">${escapeHtml(s.message)}</span></div>`;
  }).join("");

  jobSteps.scrollTop = jobSteps.scrollHeight;
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
  const liquidityLabel = instance.phoenixAutoLiquidityOff ? "Auto liquidity" : "Manual liquidity";
  const liquidityNext = instance.phoenixAutoLiquidityOff ? false : true;

  const displayUrl = instance.proxyFrontendUrl || instance.frontendUrl;
  const displayApiUrl = instance.proxyApiUrl || instance.apiUrl;

  const jobMeta = activeJob
    ? `<div class="instance-card-progress">
         <div class="instance-card-progress-bar" style="width:${Math.max(6, activeJob.progress || 0)}%"></div>
       </div>
       <div class="instance-job">${escapeHtml(activeJob.message || formatActionLabel(activeJob.action))}</div>`
    : "";

  const proxyBadge = instance.proxyFrontendUrl
    ? '<span class="badge badge-good">https</span>'
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
          ${proxyBadge}
        </div>
      </div>

      ${jobMeta}

      <div class="instance-card-urls">
        <a href="${escapeHtml(displayUrl)}" target="_blank" rel="noreferrer" class="instance-url instance-url-frontend">
          <span class="instance-url-label">Frontend</span>
          <span class="instance-url-value">${escapeHtml(displayUrl)}</span>
        </a>
        <div class="instance-url-group">
          <span class="instance-url-item"><span class="instance-url-label">API</span> <code>${escapeHtml(displayApiUrl)}</code></span>
          <span class="instance-url-item"><span class="instance-url-label">Phoenixd</span> <code>${escapeHtml(instance.phoenixUrl)}</code></span>
        </div>
      </div>

      <div class="instance-card-actions">
        <div class="action-group action-group-primary">
          <button data-action="open" data-id="${escapeHtml(instance.id)}" ${disabled}>Open</button>
          <button data-action="diagnostics" data-id="${escapeHtml(instance.id)}" class="secondary" ${disabled}>Logs</button>
          <button data-action="qr" data-id="${escapeHtml(instance.id)}" data-url="${escapeHtml(displayUrl)}" data-name="${escapeHtml(instance.name)}" class="secondary" ${disabled}>QR</button>
          <button data-action="copy-local" data-id="${escapeHtml(instance.id)}" data-url="${escapeHtml(instance.localFrontendUrl)}" class="secondary" ${disabled}>Copy localhost</button>
        </div>
        <div class="action-group action-group-secondary">
          ${isStopped ? `<button data-action="start" data-id="${escapeHtml(instance.id)}" class="secondary" ${disabled}>Start</button>` : ""}
          ${isRunning ? `<button data-action="stop" data-id="${escapeHtml(instance.id)}" class="secondary" ${disabled}>Stop</button>` : ""}
          <button data-action="switch-chain" data-id="${escapeHtml(instance.id)}" data-chain="${escapeHtml(nextChain)}" class="secondary" ${disabled}>${switchLabel}</button>
          <button data-action="toggle-liquidity" data-id="${escapeHtml(instance.id)}" data-enabled="${escapeHtml(String(liquidityNext))}" class="secondary" ${disabled}>${liquidityLabel}</button>
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

let diagnosticsState = { instanceId: null, services: [], activeService: null, autoRefresh: false, autoRefreshTimer: null };

function formatLogLines(raw) {
  if (!raw) return '<span class="log-empty">No logs available.</span>';
  const lines = raw.split("\n");
  return lines.map((line, i) => {
    const num = String(i + 1).padStart(String(lines.length).length, " ");
    return `<span class="log-ln">${num}</span><span class="log-lv">${escapeHtml(line)}</span>`;
  }).join("\n");
}

function renderDiagnosticsServices() {
  const { services, activeService } = diagnosticsState;
  diagnosticsServicesBar.innerHTML = services.map((s) => {
    const isActive = s.name === activeService;
    const stateNorm = `${s.state}`.toLowerCase();
    const dotCls = stateNorm.includes("running") ? "svc-dot-good" : stateNorm.includes("exited") || stateNorm.includes("stopped") ? "svc-dot-bad" : "svc-dot-warn";
    return `<button type="button" class="diagnostics-tab ${isActive ? "diagnostics-tab-active" : ""}" data-svc="${escapeHtml(s.name)}"><span class="svc-dot ${dotCls}"></span>${escapeHtml(s.name)}</button>`;
  }).join("");
}

function renderDiagnosticsContent() {
  const { services, activeService } = diagnosticsState;
  const svc = services.find((s) => s.name === activeService);
  if (!svc) return;

  const meta = [
    svc.image ? `<span class="diag-meta"><span class="diag-meta-label">Image</span> <code>${escapeHtml(svc.image)}</code></span>` : "",
    svc.ports.length ? `<span class="diag-meta"><span class="diag-meta-label">Ports</span> <code>${svc.ports.map(escapeHtml).join(", ")}</code></span>` : "",
    svc.exitCode !== null ? `<span class="diag-meta"><span class="diag-meta-label">Exit</span> <code>${svc.exitCode}</code></span>` : "",
  ].filter(Boolean).join("");

  diagnosticsSummary.textContent = diagnosticsState.summary || "No summary available";
  diagnosticsContent.innerHTML = `
    <section class="diagnostic-service">
      <div class="diagnostic-service-header">
        <div class="diag-header-left">
          ${statusBadge(svc.state || "unknown")}
          ${meta ? `<div class="diag-meta-row">${meta}</div>` : ""}
        </div>
      </div>
      <pre class="log-output">${formatLogLines(svc.logs)}</pre>
    </section>
  `;
  diagnosticsContent.scrollTop = diagnosticsContent.scrollHeight;
}

async function loadDiagnostics(instanceId) {
  const response = await fetch(`/api/instances/${instanceId}/diagnostics`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Failed to load diagnostics");

  const prevActive = diagnosticsState.activeService;
  diagnosticsState.services = payload.services || [];
  diagnosticsState.summary = payload.summary || "";
  diagnosticsState.activeService = prevActive && diagnosticsState.services.some((s) => s.name === prevActive)
    ? prevActive
    : (diagnosticsState.services[0]?.name || null);

  renderDiagnosticsServices();
  renderDiagnosticsContent();
}

function stopDiagnosticsAutoRefresh() {
  if (diagnosticsState.autoRefreshTimer) {
    window.clearInterval(diagnosticsState.autoRefreshTimer);
    diagnosticsState.autoRefreshTimer = null;
  }
}

async function openDiagnosticsDialog(instanceId) {
  diagnosticsState = { instanceId, services: [], activeService: null, autoRefresh: false, autoRefreshTimer: null };
  diagnosticsTitle.textContent = `Diagnostics for ${instanceId}`;
  diagnosticsSummary.textContent = "Loading diagnostics...";
  diagnosticsContent.innerHTML = "";
  diagnosticsServicesBar.innerHTML = "";
  diagnosticsAutorefreshBtn.textContent = "Auto-refresh: off";
  diagnosticsDialog.showModal();

  await loadDiagnostics(instanceId);
}

diagnosticsServicesBar.addEventListener("click", (event) => {
  const tab = event.target.closest(".diagnostics-tab");
  if (!tab) return;
  diagnosticsState.activeService = tab.dataset.svc;
  renderDiagnosticsServices();
  renderDiagnosticsContent();
});

diagnosticsRefreshBtn.addEventListener("click", async () => {
  if (!diagnosticsState.instanceId) return;
  try {
    await loadDiagnostics(diagnosticsState.instanceId);
  } catch (error) {
    setFeedback(error.message, "bad");
  }
});

diagnosticsAutorefreshBtn.addEventListener("click", () => {
  diagnosticsState.autoRefresh = !diagnosticsState.autoRefresh;
  diagnosticsAutorefreshBtn.textContent = `Auto-refresh: ${diagnosticsState.autoRefresh ? "on" : "off"}`;
  if (diagnosticsState.autoRefresh) {
    diagnosticsState.autoRefreshTimer = window.setInterval(async () => {
      try {
        await loadDiagnostics(diagnosticsState.instanceId);
      } catch {}
    }, 3000);
  } else {
    stopDiagnosticsAutoRefresh();
  }
});

diagnosticsDialog.addEventListener("close", () => {
  stopDiagnosticsAutoRefresh();
});

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

    if (action === "toggle-liquidity") {
      const enabled = button.dataset.enabled === "true";
      const modeLabel = enabled ? "manual liquidity" : "auto liquidity";
      const confirmed = await openConfirmDialog({
        title: `Switch ${instanceId} to ${modeLabel}`,
        message: `This will stop the instance and recreate its services with ${modeLabel}. Existing Phoenixd data will be kept.`,
        confirmLabel: `Switch to ${modeLabel}`,
      });
      if (!confirmed) {
        return;
      }

      await mutateInstance(
        `/api/instances/${instanceId}/toggle-autoliquidity`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phoenixAutoLiquidityOff: enabled }),
        },
        `Switch to ${modeLabel} started`,
      );
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

function setProxyFeedback(message, tone = "neutral") {
  if (!proxyFeedback) return;
  proxyFeedback.textContent = message;
  proxyFeedback.dataset.tone = tone;
}

function setNgrokFeedback(message, tone = "neutral") {
  if (!ngrokFeedback) return;
  ngrokFeedback.textContent = message;
  ngrokFeedback.dataset.tone = tone;
}

if (tabNgrok && tabNginx && tabCloudflare && panelNgrok && panelNginx && panelCloudflare) {
  const allTabs = [tabCloudflare, tabNgrok, tabNginx];
  const allPanels = [panelCloudflare, panelNgrok, panelNginx];

  function switchTab(activeTab, activePanel) {
    allTabs.forEach((t) => t.classList.remove("active"));
    allPanels.forEach((p) => p.hidden = true);
    activeTab.classList.add("active");
    activePanel.hidden = false;
  }

  tabCloudflare.addEventListener("click", () => switchTab(tabCloudflare, panelCloudflare));
  tabNgrok.addEventListener("click", () => switchTab(tabNgrok, panelNgrok));
  tabNginx.addEventListener("click", () => switchTab(tabNginx, panelNginx));
}

async function loadNgrokStatus() {
  try {
    const response = await fetch("/api/ngrok");
    const ngrok = await response.json();
    if (!response.ok) return;

    if (ngrokStatusBadges) {
      const badges = [];
      if (!ngrok.installed) {
        badges.push('<span class="badge badge-bad">ngrok not installed</span>');
      } else if (ngrok.enabled) {
        badges.push('<span class="badge badge-good">Ngrok enabled</span>');
      } else {
        badges.push('<span class="badge badge-muted">Ngrok disabled</span>');
      }
      if (ngrok.running) badges.push('<span class="badge badge-good">Tunnels active</span>');
      if (ngrok.authtoken) badges.push('<span class="badge badge-muted">Token configured</span>');
      badges.push(`<span class="badge badge-muted">Limit: ${ngrok.maxTunnels || 3} tunnels (free plan)</span>`);
      ngrokStatusBadges.innerHTML = badges.join("");
    }

    if (ngrok.tunnels && Object.keys(ngrok.tunnels).length > 0) {
      const tunnelList = Object.entries(ngrok.tunnels).map(([name, url]) => {
        return `<span class="instance-url-item"><span class="instance-url-label">${escapeHtml(name)}</span> <code>${escapeHtml(url)}</code></span>`;
      }).join("");
      ngrokStatusBadges.innerHTML += `<div class="ngrok-tunnel-list">${tunnelList}</div>`;
    }
  } catch { /* ignore */ }
}

if (ngrokForm) {
  ngrokForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const authtoken = ngrokAuthtokenInput?.value?.trim();
    if (!authtoken) {
      setNgrokFeedback("Authtoken is required", "bad");
      return;
    }
    try {
      setNgrokFeedback("Configuring ngrok...", "neutral");
      const response = await fetch("/api/ngrok/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authtoken }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Configuration failed");
      setNgrokFeedback("Ngrok configured. Start tunnels to expose instances.", "good");
      ngrokAuthtokenInput.value = "";
      await loadNgrokStatus();
    } catch (error) {
      setNgrokFeedback(error.message, "bad");
    }
  });
}

if (ngrokEnableButton) {
  ngrokEnableButton.addEventListener("click", async () => {
    try {
      setNgrokFeedback("Starting ngrok tunnels...", "neutral");
      const response = await fetch("/api/ngrok/enable", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Failed to start");
      setNgrokFeedback("Tunnels started", "good");
      await Promise.all([loadNgrokStatus(), fetchInstances()]);
    } catch (error) {
      setNgrokFeedback(error.message, "bad");
    }
  });
}

if (ngrokDisableButton) {
  ngrokDisableButton.addEventListener("click", async () => {
    try {
      setNgrokFeedback("Stopping ngrok tunnels...", "neutral");
      const response = await fetch("/api/ngrok/disable", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Failed to stop");
      setNgrokFeedback("Tunnels stopped", "good");
      await Promise.all([loadNgrokStatus(), fetchInstances()]);
    } catch (error) {
      setNgrokFeedback(error.message, "bad");
    }
  });
}

async function loadProxyStatus() {
  try {
    const response = await fetch("/api/proxy");
    const proxy = await response.json();
    if (!response.ok) return;

    if (proxyStatusBadges) {
      const badges = [];
      if (proxy.enabled) badges.push('<span class="badge badge-good">HTTPS enabled</span>');
      else badges.push('<span class="badge badge-muted">HTTPS disabled</span>');
      if (proxy.running) badges.push('<span class="badge badge-good">Nginx running</span>');
      else badges.push('<span class="badge badge-muted">Nginx stopped</span>');
      if (proxy.baseDomain) badges.push(`<span class="badge badge-muted">${escapeHtml(proxy.baseDomain)}</span>`);
      proxyStatusBadges.innerHTML = badges.join("");
    }

    if (proxyDomainInput && proxy.baseDomain) proxyDomainInput.value = proxy.baseDomain;
    if (proxyEmailInput && proxy.email) proxyEmailInput.value = proxy.email;
  } catch { /* ignore */ }
}

if (proxyForm) {
  proxyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const baseDomain = proxyDomainInput?.value?.trim();
    const email = proxyEmailInput?.value?.trim();

    if (!baseDomain || !email) {
      setProxyFeedback("Domain and email are required", "bad");
      return;
    }

    try {
      setProxyFeedback("Configuring proxy and requesting certificate...", "neutral");
      const response = await fetch("/api/proxy/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseDomain, email }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Configuration failed");
      setProxyFeedback("Proxy configured and certificate obtained", "good");
      await Promise.all([loadProxyStatus(), fetchInstances()]);
    } catch (error) {
      setProxyFeedback(error.message, "bad");
    }
  });
}

if (proxyRefreshButton) {
  proxyRefreshButton.addEventListener("click", async () => {
    try {
      setProxyFeedback("Refreshing proxy configuration...", "neutral");
      const response = await fetch("/api/proxy/refresh", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Refresh failed");
      setProxyFeedback("Proxy configuration refreshed", "good");
      await fetchInstances();
    } catch (error) {
      setProxyFeedback(error.message, "bad");
    }
  });
}

if (proxyRenewButton) {
  proxyRenewButton.addEventListener("click", async () => {
    try {
      setProxyFeedback("Renewing SSL certificates...", "neutral");
      const response = await fetch("/api/proxy/renew-certs", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Renewal failed");
      setProxyFeedback("Certificates renewed successfully", "good");
    } catch (error) {
      setProxyFeedback(error.message, "bad");
    }
  });
}

function setCloudflareFeedback(message, tone = "neutral") {
  if (!cloudflareFeedback) return;
  cloudflareFeedback.textContent = message;
  cloudflareFeedback.dataset.tone = tone;
}

async function loadCloudflareStatus() {
  try {
    const response = await fetch("/api/cloudflare");
    const cf = await response.json();
    if (!response.ok) return;

    if (cloudflareStatusBadges) {
      const badges = [];
      if (!cf.installed) {
        badges.push('<span class="badge badge-bad">cloudflared not installed</span>');
      } else if (cf.enabled) {
        badges.push('<span class="badge badge-good">Cloudflare enabled</span>');
      } else {
        badges.push('<span class="badge badge-muted">Cloudflare disabled</span>');
      }
      if (cf.running) badges.push('<span class="badge badge-good">Tunnel active</span>');
      if (cf.tunnelToken) badges.push('<span class="badge badge-muted">Token configured</span>');
      if (cf.domain) badges.push(`<span class="badge badge-muted">${escapeHtml(cf.domain)}</span>`);
      badges.push('<span class="badge badge-muted">Free, unlimited tunnels</span>');
      cloudflareStatusBadges.innerHTML = badges.join("");
    }

    if (cloudflareDomainInput && cf.domain) cloudflareDomainInput.value = cf.domain;
  } catch { /* ignore */ }
}

if (cloudflareForm) {
  cloudflareForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const tunnelToken = cloudflareTokenInput?.value?.trim();
    const domain = cloudflareDomainInput?.value?.trim();

    if (!tunnelToken && !domain) {
      setCloudflareFeedback("Tunnel token or domain is required", "bad");
      return;
    }

    try {
      if (tunnelToken) {
        setCloudflareFeedback("Configuring Cloudflare tunnel...", "neutral");
        const res = await fetch("/api/cloudflare/configure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tunnelToken }),
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || "Configuration failed");
      }

      if (domain) {
        setCloudflareFeedback("Setting domain...", "neutral");
        const res = await fetch("/api/cloudflare/domain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain }),
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || "Failed to set domain");
      }

      setCloudflareFeedback("Cloudflare tunnel configured", "good");
      cloudflareTokenInput.value = "";
      await Promise.all([loadCloudflareStatus(), fetchInstances()]);
    } catch (error) {
      setCloudflareFeedback(error.message, "bad");
    }
  });
}

if (cloudflareEnableButton) {
  cloudflareEnableButton.addEventListener("click", async () => {
    try {
      setCloudflareFeedback("Starting Cloudflare tunnel...", "neutral");
      const response = await fetch("/api/cloudflare/enable", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Failed to start");
      setCloudflareFeedback("Tunnel started", "good");
      await Promise.all([loadCloudflareStatus(), fetchInstances()]);
    } catch (error) {
      setCloudflareFeedback(error.message, "bad");
    }
  });
}

if (cloudflareDisableButton) {
  cloudflareDisableButton.addEventListener("click", async () => {
    try {
      setCloudflareFeedback("Stopping Cloudflare tunnel...", "neutral");
      const response = await fetch("/api/cloudflare/disable", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Failed to stop");
      setCloudflareFeedback("Tunnel stopped", "good");
      await Promise.all([loadCloudflareStatus(), fetchInstances()]);
    } catch (error) {
      setCloudflareFeedback(error.message, "bad");
    }
  });
}

applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");

Promise.all([fetchInstances(), fetchJobs(), loadProxyStatus(), loadNgrokStatus(), loadCloudflareStatus()])
  .then(() => {
    if (getActiveJobs().length > 0) {
      ensureJobsPolling();
      setFeedback("Operation in progress", "neutral");
      return;
    }

    setFeedback("Instance inventory loaded", "good");
  })
  .catch((error) => setFeedback(error.message, "bad"));
