import pty from "node-pty";
import { WebSocketServer } from "ws";
import { getInstanceDetails, isManagedName } from "./lxd.mjs";

export function attachTerminalGateway(server, { origin, project }) {
  const sessions = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on("upgrade", async (request, socket, head) => {
    try {
      const url = new URL(request.url || "/", origin);
      const name = url.searchParams.get("instance");
      if (url.pathname !== "/terminal-ws" || request.headers.origin !== origin || !isManagedName(name)) throw new Error("Forbidden");
      const instance = await getInstanceDetails(project, name);
      if (instance.status !== "running" || sessions.has(name)) throw new Error("Unavailable");
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request, name));
    } catch {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });

  wss.on("connection", (ws, _request, name) => {
    const shell = String.raw`if command -v bash >/dev/null 2>&1; then export PS1='\u@\h:\w\$ '; export HISTFILE=/root/.bash_history; exec bash --noprofile --norc -i; else export PS1="root@$(hostname):$(pwd)# "; exec sh -i; fi`;
    const terminal = pty.spawn("lxc", [
      "exec", name, "--project", project, "--mode=interactive", "--", "sh", "-lc", shell,
    ], {
      name: "xterm-256color", cols: 100, rows: 30, cwd: "/", env: { ...process.env, TERM: "xterm-256color" },
    });
    sessions.set(name, terminal);
    let closed = false;
    let idleTimer;
    let inputBytes = 0;
    let inputWindow = Date.now();

    const close = (reason) => {
      if (closed) return;
      closed = true;
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      sessions.delete(name);
      try { terminal.kill(); } catch {}
      if (ws.readyState < 2) ws.close(1000, reason);
    };
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => close("idle-timeout"), 20 * 60 * 1000);
    };
    const hardTimer = setTimeout(() => close("session-timeout"), 2 * 60 * 60 * 1000);
    resetIdle();

    terminal.onData((data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "output", data }));
    });
    terminal.onExit(() => close("shell-exited"));
    ws.on("message", (raw) => {
      resetIdle();
      const now = Date.now();
      if (now - inputWindow >= 1000) { inputWindow = now; inputBytes = 0; }
      inputBytes += raw.length;
      if (inputBytes > 64 * 1024) return close("rate-limit");
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === "input" && typeof message.data === "string" && message.data.length <= 16_384) terminal.write(message.data);
        if (message.type === "resize") {
          terminal.resize(
            Math.max(20, Math.min(300, Number(message.cols) || 80)),
            Math.max(5, Math.min(100, Number(message.rows) || 24)),
          );
        }
      } catch {}
    });
    ws.on("close", () => close("client-closed"));
    ws.on("error", () => close("socket-error"));
  });
}
