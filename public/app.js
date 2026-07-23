const profileSelect = document.querySelector("#profile");
const createForm = document.querySelector("#create-form");
const createButton = document.querySelector("#create-button");
const refreshButton = document.querySelector("#refresh-button");
const instancesBody = document.querySelector("#instances-body");
const instanceCount = document.querySelector("#instance-count");
const notification = document.querySelector("#notification");
const projectName = document.querySelector("#project-name");
const deleteDialog = document.querySelector("#delete-dialog");
const deleteName = document.querySelector("#delete-name");
const confirmDelete = document.querySelector("#confirm-delete");

let pending = false;
let serverBusy = false;
let selectedForDeletion = null;
let shownOperation = null;

function updateControls() {
  const disabled = pending || serverBusy;
  createButton.disabled = disabled || !profileSelect.value;
  createButton.textContent = serverBusy ? "LXD operation in progress" : "Create instance";
  profileSelect.disabled = disabled;
  refreshButton.disabled = pending;
  document.querySelectorAll("[data-delete]").forEach((button) => { button.disabled = disabled; });
}

function setPending(value) {
  pending = value;
  updateControls();
}

function notify(message, type = "information") {
  notification.textContent = message;
  notification.className = `notification notification-${type}`;
  notification.hidden = !message;
}

function formatDate(value) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function statusLabel(status) {
  const normalized = String(status || "unknown").toLowerCase().replace(/[^a-z-]/g, "");
  return `<span class="status status-${normalized}">${normalized}</span>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    if (response.status === 502 || response.status === 504) {
      throw new Error(`The server returned HTTP ${response.status}. The LXD operation may still be running; wait a moment and refresh.`);
    }
    throw new Error(`The server returned an invalid response (HTTP ${response.status}).`);
  }
}

function renderInstances(instances, activeOperation, lxdOperations) {
  const rows = instances.map((instance) => ({ ...instance }));
  if (activeOperation?.type === "delete") {
    const deleting = rows.find((instance) => instance.name === activeOperation.name);
    if (deleting) deleting.status = "deleting";
  }
  if (activeOperation?.type === "create" && !rows.some((instance) => instance.name === activeOperation.name)) {
    rows.unshift({
      name: activeOperation.name,
      profile: activeOperation.profile,
      status: "creating",
      ipv4: null,
      createdAt: activeOperation.startedAt,
      pending: true,
    });
  }
  if (!activeOperation && lxdOperations.length) {
    rows.unshift(...lxdOperations.map((operation) => ({
      name: operation.description || "LXD operation",
      profile: "System",
      status: "working",
      ipv4: null,
      createdAt: operation.createdAt,
      pending: true,
    })));
  }

  instanceCount.textContent = String(rows.length);
  if (!rows.length) {
    instancesBody.innerHTML = '<tr><td colspan="6" class="empty">No instances.</td></tr>';
    return;
  }
  instancesBody.innerHTML = rows.map((instance) => `
    <tr>
      <td data-label="Name"><code>${escapeHtml(instance.name)}</code></td>
      <td data-label="Profile">${escapeHtml(instance.profile)}</td>
      <td data-label="Status">${statusLabel(instance.status)}</td>
      <td data-label="IPv4"><code>${escapeHtml(instance.ipv4 || "Pending")}</code></td>
      <td data-label="Created">${formatDate(instance.createdAt)}</td>
      <td class="actions">${instance.pending ? "" : `<button class="button button-negative button-small" type="button" data-delete="${escapeHtml(instance.name)}">Delete</button>`}</td>
    </tr>
  `).join("");
  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedForDeletion = button.dataset.delete;
      deleteName.textContent = selectedForDeletion;
      deleteDialog.showModal();
    });
  });
}

async function load(showError = true) {
  try {
    const response = await fetch("/api/overview", { headers: { accept: "application/json" } });
    const data = await responseJson(response);
    if (!response.ok) throw new Error(data.error || "Unable to load LXD state");
    const lxdOperations = data.lxdOperations || [];
    serverBusy = Boolean(data.activeOperation || lxdOperations.length);
    projectName.textContent = data.project;
    const current = profileSelect.value;
    profileSelect.innerHTML = '<option value="">Select a profile</option>' + data.profiles.map((profile) => (
      `<option value="${profile.name}">${profile.name} - ${profile.cpu} vCPU - ${profile.memory} RAM - ${profile.disk}</option>`
    )).join("");
    if (data.profiles.some((profile) => profile.name === current)) profileSelect.value = current;
    renderInstances(data.instances, data.activeOperation, lxdOperations);
    updateControls();
    const activeOperationKey = data.activeOperation ? `${data.activeOperation.id}:${data.activeOperation.status}` : null;
    const lastOperationKey = data.lastOperation ? `${data.lastOperation.id}:${data.lastOperation.status}` : null;
    if (data.activeOperation?.type === "create" && shownOperation !== activeOperationKey) {
      shownOperation = activeOperationKey;
      notify(`${data.activeOperation.name} is being created. The first Ubuntu download can take several minutes.`, "information");
    } else if (data.lastOperation?.id && shownOperation !== lastOperationKey) {
      shownOperation = lastOperationKey;
      if (data.lastOperation.status === "failed") {
        notify(data.lastOperation.error || `${data.lastOperation.name} failed.`, "negative");
      } else if (data.lastOperation.type === "create") {
        notify(`${data.lastOperation.name} was created.`, "positive");
      }
    }
  } catch (error) {
    if (showError) notify(error.message, "negative");
  }
}

profileSelect.addEventListener("change", updateControls);
refreshButton.addEventListener("click", () => load());

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setPending(true);
  notify("Creating instance...", "information");
  try {
    const response = await fetch("/api/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: profileSelect.value }),
    });
    const data = await responseJson(response);
    if (!response.ok) throw new Error(data.error || "Unable to create instance");
    serverBusy = true;
    notify(`${data.name} creation started.`, "information");
    await load(false);
  } catch (error) {
    notify(error.message, "negative");
  } finally {
    setPending(false);
  }
});

deleteDialog.addEventListener("close", async () => {
  if (deleteDialog.returnValue !== "confirm" || !selectedForDeletion) {
    selectedForDeletion = null;
    return;
  }
  const name = selectedForDeletion;
  selectedForDeletion = null;
  setPending(true);
  notify(`Deleting ${name}...`, "information");
  try {
    const response = await fetch(`/api/instances/${encodeURIComponent(name)}`, { method: "DELETE" });
    const data = await responseJson(response);
    if (!response.ok) throw new Error(data.error || "Unable to delete instance");
    notify(`${name} was deleted.`, "positive");
    await load(false);
  } catch (error) {
    notify(error.message, "negative");
  } finally {
    setPending(false);
  }
});

void load();
setInterval(() => { if (!pending && !deleteDialog.open) void load(false); }, 3_000);
