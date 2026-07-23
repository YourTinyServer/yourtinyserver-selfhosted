const form = document.querySelector("#login-form");
const error = document.querySelector("#login-error");
const button = document.querySelector("#login-button");

async function responseJson(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; }
  catch { return {}; }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  button.disabled = true;
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: document.querySelector("#username").value.trim(),
        password: document.querySelector("#password").value,
      }),
    });
    const data = await responseJson(response);
    if (!response.ok) throw new Error(data.error || "Sign in failed");
    window.location.replace("/");
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : "Sign in failed";
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});

fetch("/api/auth/session").then((response) => { if (response.ok) window.location.replace("/"); }).catch(() => {});
