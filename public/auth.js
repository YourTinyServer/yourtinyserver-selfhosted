const dialog = document.createElement("dialog");
dialog.id = "password-dialog";
dialog.innerHTML = `
  <form id="password-form">
    <h2>Change administrator password</h2>
    <p>Use at least 12 characters with uppercase, lowercase, number and special character.</p>
    <div id="password-message" class="notification notification-negative" role="alert" hidden></div>
    <div class="field"><label for="new-password">New password</label><input id="new-password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required /></div>
    <div class="dialog-actions"><button class="button" type="button" data-password-cancel>Cancel</button><button class="button button-positive" type="submit">Change password</button></div>
  </form>`;
document.body.append(dialog);
const notification = document.createElement("div");
notification.className = "notification notification-positive auth-notification";
notification.setAttribute("role", "status");
notification.hidden = true;
document.querySelector("main")?.prepend(notification);

document.querySelectorAll("[data-change-password]").forEach((button) => button.addEventListener("click", () => {
  document.querySelector("#new-password").value = "";
  document.querySelector("#password-message").hidden = true;
  dialog.showModal();
}));
document.querySelector("[data-password-cancel]").addEventListener("click", () => dialog.close());
document.querySelector("#password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  const message = document.querySelector("#password-message");
  submit.disabled = true;
  try {
    const response = await fetch("/api/auth/password", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: document.querySelector("#new-password").value }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Unable to change password");
    dialog.close();
    notification.textContent = "Administrator password changed. Other sessions were closed.";
    notification.hidden = false;
  } catch (cause) {
    message.textContent = cause instanceof Error ? cause.message : "Unable to change password";
    message.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

document.querySelectorAll("[data-logout]").forEach((button) => button.addEventListener("click", async () => {
  button.disabled = true;
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  window.location.replace("/login.html");
}));
