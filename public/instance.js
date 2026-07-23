const name = new URLSearchParams(window.location.search).get("name") || "";
if (!/^yts-[a-z0-9]+-[0-9]{17}$/.test(name)) window.location.replace("/");

const elements = {
  name: document.querySelector("#instance-name"), meta: document.querySelector("#instance-meta"),
  notification: document.querySelector("#notification"), controls: document.querySelector("#instance-controls"),
  refresh: document.querySelector("#refresh-button"), specifications: document.querySelector("#specifications"),
  snapshotForm: document.querySelector("#snapshot-form"), snapshotName: document.querySelector("#snapshot-name"),
  snapshotCount: document.querySelector("#snapshot-count"), snapshotList: document.querySelector("#snapshot-list"),
  domainForm: document.querySelector("#domain-form"), domainName: document.querySelector("#domain-name"),
  domainPort: document.querySelector("#domain-port"), domainList: document.querySelector("#domain-list"),
  deleteInstance: document.querySelector("#delete-instance"), dialog: document.querySelector("#confirm-dialog"),
  confirmTitle: document.querySelector("#confirm-title"), confirmDescription: document.querySelector("#confirm-description"),
  confirmAction: document.querySelector("#confirm-action"),
};

let payload = null;
let pending = false;
let confirmTask = null;

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function notify(message, type = "information") {
  elements.notification.textContent = message;
  elements.notification.className = `notification notification-${type}`;
  elements.notification.hidden = !message;
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new Error(`Invalid server response (HTTP ${response.status})`); }
}

function bytes(value, rate = false) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = Number(value || 0);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}${rate ? "/s" : ""}`;
}

function uptime(seconds) {
  if (!seconds) return "Not running";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${minutes}m`].filter(Boolean).join(" ");
}

function date(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Unknown";
}

function metric(id, value, total) {
  document.querySelector(`#metric-${id}`).textContent = id === "cpu" ? `${value.toFixed(1)}%` : `${bytes(value)} / ${bytes(total)}`;
  const percent = id === "cpu" ? value : total ? value / total * 100 : 0;
  document.querySelector(`#${id}-progress`).value = Math.max(0, Math.min(100, percent));
}

function renderControls(instance) {
  const status = instance.status;
  const buttons = [];
  if (["stopped", "frozen"].includes(status)) buttons.push(`<button class="button button-positive" data-action="start">${status === "frozen" ? "Unfreeze" : "Start"}</button>`);
  if (status === "running") buttons.push('<button class="button button-secondary" data-action="restart">Restart</button>');
  if (status === "running") buttons.push('<button class="button button-secondary" data-action="freeze">Freeze</button>');
  if (["running", "frozen"].includes(status)) buttons.push('<button class="button button-secondary" data-action="stop">Stop</button>');
  if (status === "running") buttons.push(`<a class="button button-secondary" href="/terminal.html?name=${encodeURIComponent(instance.name)}">Terminal</a>`);
  elements.controls.innerHTML = buttons.join("");
}

function renderSnapshots(instance) {
  elements.snapshotCount.textContent = `${instance.snapshots.length} / ${instance.snapshotLimit}`;
  elements.snapshotName.disabled = pending || instance.snapshots.length >= instance.snapshotLimit;
  elements.snapshotForm.querySelector("button").disabled = pending || instance.snapshots.length >= instance.snapshotLimit;
  elements.snapshotList.innerHTML = instance.snapshots.length ? instance.snapshots.map((snapshot) => `
    <div class="list-item">
      <div><strong><code>${escapeHtml(snapshot.name)}</code></strong><small>Created ${escapeHtml(date(snapshot.createdAt))}</small></div>
      <div class="row-actions"><button class="button button-secondary button-small" data-snapshot-restore="${escapeHtml(snapshot.name)}">Restore</button><button class="button button-negative button-small" data-snapshot-delete="${escapeHtml(snapshot.name)}">Delete</button></div>
    </div>`).join("") : '<p class="empty-state">No snapshots yet.</p>';
}

function renderDomains(domains) {
  elements.domainList.innerHTML = domains.length ? domains.map((route) => `
    <div class="list-item">
      <div><strong>${route.status === "active" ? `<a href="https://${escapeHtml(route.domain)}" target="_blank" rel="noreferrer">${escapeHtml(route.domain)}</a>` : escapeHtml(route.domain)}</strong><small>Internal port ${route.targetPort} - ${escapeHtml(route.status)}</small>${route.errorMessage ? `<small class="error-text">${escapeHtml(route.errorMessage)}</small>` : ""}</div>
      <button class="button button-negative button-small" data-domain-delete="${escapeHtml(route.id)}">Remove</button>
    </div>`).join("") : '<p class="empty-state">No web domains configured.</p>';
}

function render(data) {
  payload = data;
  const instance = data.instance;
  elements.name.textContent = instance.name;
  elements.meta.innerHTML = `<span class="status status-${escapeHtml(instance.status)}">${escapeHtml(instance.status)}</span> ${escapeHtml(instance.profile.name)} - Created ${escapeHtml(date(instance.createdAt))}`;
  renderControls(instance);
  const metrics = instance.metrics;
  metric("cpu", Number(metrics.cpuPercent || 0), 100);
  metric("memory", Number(metrics.memoryUsedBytes || 0), Number(metrics.memoryTotalBytes || 0));
  metric("disk", Number(metrics.diskUsedBytes || 0), Number(metrics.diskTotalBytes || 0));
  document.querySelector("#metric-network").textContent = `RX ${bytes(metrics.networkRxBps, true)} - TX ${bytes(metrics.networkTxBps, true)}`;
  document.querySelector("#metric-network-total").textContent = `${bytes(Number(metrics.networkRxBytes || 0) + Number(metrics.networkTxBytes || 0))} transferred`;
  elements.specifications.innerHTML = `
    <div><dt>Profile</dt><dd>${escapeHtml(instance.profile.name)}</dd></div>
    <div><dt>Resources</dt><dd>${escapeHtml(instance.profile.cpu)} vCPU - ${escapeHtml(instance.profile.memory)} RAM - ${escapeHtml(instance.profile.disk)} disk</dd></div>
    <div><dt>Private IPv4</dt><dd><code>${escapeHtml(instance.ipv4 || "Pending")}</code></dd></div>
    <div><dt>Private IPv6</dt><dd><code>${escapeHtml(instance.ipv6 || "Pending")}</code></dd></div>
    <div><dt>Processes</dt><dd>${Number(metrics.processes || 0)}</dd></div>
    <div><dt>Uptime</dt><dd>${escapeHtml(uptime(metrics.uptimeSeconds))}</dd></div>`;
  renderSnapshots(instance);
  renderDomains(data.domains || []);
  document.querySelectorAll("button, input").forEach((control) => { if (!control.closest("dialog")) control.disabled = pending || data.busy; });
  const snapshotLimitReached = instance.snapshots.length >= instance.snapshotLimit;
  elements.snapshotName.disabled = pending || data.busy || snapshotLimitReached;
  elements.snapshotForm.querySelector("button").disabled = pending || data.busy || snapshotLimitReached;
}

async function load(quiet = false) {
  try {
    const response = await fetch(`/api/instances/${encodeURIComponent(name)}`, { headers: { accept: "application/json" } });
    const data = await responseJson(response);
    if (!response.ok) throw new Error(data.error || "Unable to load instance");
    render(data);
  } catch (error) {
    if (!quiet) notify(error.message, "negative");
  }
}

async function mutate(path, options, success) {
  pending = true;
  if (payload) render(payload);
  notify("Operation in progress...", "information");
  try {
    const response = await fetch(path, options);
    const data = await responseJson(response);
    if (!response.ok) throw new Error(data.error || "Operation failed");
    notify(success, "positive");
    await load(true);
  } catch (error) { notify(error.message, "negative"); }
  finally { pending = false; if (payload) render(payload); }
}

function confirm(title, description, label, task) {
  elements.confirmTitle.textContent = title;
  elements.confirmDescription.textContent = description;
  elements.confirmAction.textContent = label;
  confirmTask = task;
  elements.dialog.showModal();
}

async function runAction(action) {
  await mutate(`/api/instances/${encodeURIComponent(name)}/actions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }),
  }, `Instance ${action} completed.`);
}

elements.controls.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || pending) return;
  const action = button.dataset.action;
  if (["restart", "stop"].includes(action)) {
    confirm(`${action === "restart" ? "Restart" : "Stop"} instance?`, action === "restart" ? "Running services will restart." : "Applications will be unavailable until the instance is started again.", action === "restart" ? "Restart" : "Stop", () => runAction(action));
  } else void runAction(action);
});

elements.snapshotForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const snapshot = elements.snapshotName.value.trim().toLowerCase();
  void mutate(`/api/instances/${encodeURIComponent(name)}/snapshots`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: snapshot }),
  }, `Snapshot ${snapshot} created.`).then(() => { elements.snapshotName.value = ""; });
});

elements.snapshotList.addEventListener("click", (event) => {
  const restore = event.target.closest("[data-snapshot-restore]");
  const remove = event.target.closest("[data-snapshot-delete]");
  const snapshot = restore?.dataset.snapshotRestore || remove?.dataset.snapshotDelete;
  if (!snapshot) return;
  if (restore) confirm("Restore snapshot?", `All changes made after ${snapshot} will be lost.`, "Restore", () => mutate(`/api/instances/${encodeURIComponent(name)}/snapshots`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: snapshot }) }, `Snapshot ${snapshot} restored.`));
  if (remove) confirm("Delete snapshot?", `${snapshot} will be permanently deleted.`, "Delete snapshot", () => mutate(`/api/instances/${encodeURIComponent(name)}/snapshots`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: snapshot }) }, `Snapshot ${snapshot} deleted.`));
});

elements.domainForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const domain = elements.domainName.value.trim().toLowerCase();
  void mutate(`/api/instances/${encodeURIComponent(name)}/domains`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ domain, targetPort: Number(elements.domainPort.value) }),
  }, `${domain} is online with HTTPS.`).then(() => { elements.domainName.value = ""; elements.domainPort.value = "80"; });
});

elements.domainList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-domain-delete]");
  if (!button) return;
  confirm("Remove web domain?", "The reverse proxy and certificate will be removed.", "Remove domain", () => mutate(`/api/instances/${encodeURIComponent(name)}/domains`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: button.dataset.domainDelete }) }, "Web domain removed."));
});

elements.deleteInstance.addEventListener("click", () => {
  confirm("Delete instance?", `${name}, all snapshots, domains and stored data will be permanently deleted.`, "Delete instance", async () => {
    const response = await fetch(`/api/instances/${encodeURIComponent(name)}`, { method: "DELETE" });
    const data = await responseJson(response);
    if (!response.ok) throw new Error(data.error || "Unable to delete instance");
    window.location.replace("/");
  });
});

elements.dialog.addEventListener("close", () => {
  if (elements.dialog.returnValue === "confirm" && confirmTask) void Promise.resolve(confirmTask()).catch((error) => notify(error.message, "negative"));
  confirmTask = null;
});
elements.refresh.addEventListener("click", () => load());

void load();
setInterval(() => { if (!pending && !elements.dialog.open) void load(true); }, 5_000);
