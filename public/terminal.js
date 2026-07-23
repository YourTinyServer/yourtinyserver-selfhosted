const name = new URLSearchParams(window.location.search).get("name") || "";
const status = document.querySelector("#terminal-status");
const error = document.querySelector("#terminal-error");
const host = document.querySelector("#terminal");
const back = document.querySelector("#back-to-instance");
back.href = `/instance.html?name=${encodeURIComponent(name)}`;

if (!/^yts-[a-z0-9]+-[0-9]{17}$/.test(name)) window.location.replace("/");

try {
  const terminal = new globalThis.Terminal({
    cursorBlink: true, convertEol: true, scrollback: 5000,
    fontFamily: "Ubuntu Mono, Consolas, monospace", fontSize: 14, lineHeight: 1.2,
    theme: { background: "#262626", foreground: "#f7f7f7", cursor: "#f7f7f7", selectionBackground: "#666666", green: "#0e8420", blue: "#06c" },
  });
  const fit = new globalThis.FitAddon.FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);
  fit.fit();
  terminal.focus();
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/terminal-ws?instance=${encodeURIComponent(name)}`);
  socket.addEventListener("open", () => {
    status.textContent = "Root console - Connected";
    fit.fit();
    socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
  });
  socket.addEventListener("message", (event) => {
    try { const message = JSON.parse(String(event.data)); if (message.type === "output") terminal.write(message.data); } catch {}
  });
  socket.addEventListener("close", () => { status.textContent = "Root console - Disconnected"; });
  socket.addEventListener("error", () => { error.textContent = "The terminal connection failed."; error.hidden = false; });
  terminal.onData((data) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data })); });
  const resize = () => { fit.fit(); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows })); };
  new ResizeObserver(resize).observe(host);
  document.querySelector("#fit-terminal").addEventListener("click", resize);
} catch (cause) {
  status.textContent = "Unavailable";
  error.textContent = cause instanceof Error ? cause.message : "Unable to initialize terminal";
  error.hidden = false;
}
