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
let selectedForDeletion = null;

function setPending(value) {
  pending = value;
  createButton.disabled = value || !profileSelect.value;
  profileSelect.disabled = value;
  refreshButton.disabled = value;
  document.querySelectorAll("[data-delete]").forEach((button) => { button.disabled = value; });
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
  const normalized = String(status || "unknown").toLowerCase();
  return `<span class="status status-${normalized}">${normalized}</span>`;
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

function renderInstances(instances) {
  instanceCount.textContent = String(instances.length);
  if (!instances.length) {
    instancesBody.innerHTML = '<tr><td colspan="6" class="empty">No instances.</td></tr>';
    return;
  }
  instancesBody.innerHTML = instances.map((instance) => `
    <tr>
      <td data-label="Name"><code>${instance.name}</code></td>
      <td data-label="Profile">${instance.profile}</td>
      <td data-label="Status">${statusLabel(instance.status)}</td>
      <td data-label="IPv4"><code>${instance.ipv4 || "Pending"}</code></td>
      <td data-label="Created">${formatDate(instance.createdAt)}</td>
      <td class="actions"><button class="button button-negative button-small" type="button" data-delete="${instance.name}">Delete</button></td>
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
    projectName.textContent = data.project;
    const current = profileSelect.value;
    profileSelect.innerHTML = '<option value="">Select a profile</option>' + data.profiles.map((profile) => (
      `<option value="${profile.name}">${profile.name} - ${profile.cpu} vCPU - ${profile.memory} RAM - ${profile.disk}</option>`
    )).join("");
    if (data.profiles.some((profile) => profile.name === current)) profileSelect.value = current;
    profileSelect.disabled = pending;
    createButton.disabled = pending || !profileSelect.value;
    renderInstances(data.instances);
  } catch (error) {
    if (showError) notify(error.message, "negative");
  }
}

profileSelect.addEventListener("change", () => { createButton.disabled = pending || !profileSelect.value; });
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
    notify(`${data.name} was created.`, "positive");
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
setInterval(() => { if (!pending && !deleteDialog.open) void load(false); }, 10_000);
