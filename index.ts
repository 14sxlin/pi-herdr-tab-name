// pi-herdr-tab-name — sync the pi session display name to the herdr tab label.
//
// Active only inside herdr panes: herdr's pi integration injects HERDR_ENV=1,
// HERDR_SOCKET_PATH and HERDR_PANE_ID into the processes it hosts. Everywhere
// else (plain terminals, headless runs) this extension registers nothing.
//
// Behavior:
//   - session named (/name, pi -n, pi.setSessionName) -> tab label = session name
//   - session name cleared (/name with no argument)   -> tab label restored to the
//     value observed before the first rename
//   - unnamed session                                 -> tab label untouched

import net from "node:net";

type Ctx = { mode?: string };

interface PiApi {
  on(
    event: "session_start",
    handler: (event: { reason?: string }, ctx: Ctx) => void | Promise<void>,
  ): void;
  on(
    event: "session_info_changed",
    handler: (event: { name?: string }, ctx: Ctx) => void | Promise<void>,
  ): void;
  getSessionName(): string | null | undefined;
}

interface PaneGetResult {
  pane?: { tab_id?: string };
}

interface TabResult {
  tab?: { label?: string };
}

const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
// Windows: herdr exposes its API as a named pipe; elsewhere a Unix domain socket.
const socketEndpoint =
  process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const paneId = process.env.HERDR_PANE_ID;

const REQUEST_TIMEOUT_MS = 2000;
const MAX_LABEL_LENGTH = 80;

function enabled(): boolean {
  return HERDR_ENV === "1" && !!socketEndpoint && !!paneId;
}

function normalizeLabel(name: unknown): string | undefined {
  if (typeof name !== "string") {
    return undefined;
  }
  const label = name.replace(/[\p{C}\s]+/gu, " ").trim().slice(0, MAX_LABEL_LENGTH);
  return label.length > 0 ? label : undefined;
}

let requestSeq = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One-shot JSON-RPC over herdr's socket; resolves undefined on
// timeout/transport/protocol error. Never rejects.
function request(method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve) => {
    const id = `herdr:pi-tab-name:${Date.now()}:${requestSeq++}`;
    let settled = false;
    let buf = "";

    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(value);
    };

    const socket = net.createConnection(socketEndpoint!);
    const timeout = setTimeout(() => finish(undefined), REQUEST_TIMEOUT_MS);
    timeout.unref?.();

    socket.on("error", () => finish(undefined));
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { id?: string; result?: unknown; error?: unknown };
          if (msg?.id === id) {
            finish(msg?.error ? undefined : msg.result);
          }
        } catch {
          // tolerate non-JSON noise on the socket
        }
      }
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  });
}

// herdr's socket server intermittently ignores rapid successive connections
// (observed ~1 in 5); every method used here is idempotent, so bounded
// retries are safe.
async function requestWithRetry(
  method: string,
  params: Record<string, unknown>,
  attempts = 3,
): Promise<unknown> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await request(method, params);
    if (result !== undefined) {
      return result;
    }
    if (attempt < attempts - 1) {
      await sleep(100 * (attempt + 1));
    }
  }
  return undefined;
}

export default function (pi: PiApi): void {
  if (!enabled()) {
    return;
  }

  let tabId: string | undefined;
  let originalLabel: string | undefined;
  let renamed = false;
  let chain: Promise<void> = Promise.resolve();

  async function sync(rawName: unknown): Promise<void> {
    try {
      if (!tabId) {
        const info = (await requestWithRetry("pane.get", { pane_id: paneId! })) as
          | PaneGetResult
          | undefined;
        tabId = info?.pane?.tab_id;
        if (!tabId) return;
      }

      const label = normalizeLabel(rawName);

      if (label) {
        // Capture the pre-sync tab label once, so a later /name clear can restore it.
        if (!renamed) {
          const tab = (await requestWithRetry("tab.get", { tab_id: tabId })) as
            | TabResult
            | undefined;
          originalLabel = tab?.tab?.label;
        }
        if (await requestWithRetry("tab.rename", { tab_id: tabId, label })) {
          renamed = true;
        }
        return;
      }

      // Name cleared: restore the label only if we changed it before.
      if (renamed && originalLabel) {
        if (await requestWithRetry("tab.rename", { tab_id: tabId, label: originalLabel })) {
          renamed = false;
        }
      }
    } catch {
      // never let sync failures affect pi
    }
  }

  function enqueue(rawName: unknown): Promise<void> {
    chain = chain.then(() => sync(rawName));
    return chain;
  }

  pi.on("session_start", async (_event, ctx) => {
    // TUI only: herdr tabs exist for PTY panes; headless runs must not touch the label.
    if (ctx?.mode !== "tui") {
      return;
    }
    let name: string | undefined;
    try {
      name = pi.getSessionName() ?? undefined;
    } catch {
      name = undefined;
    }
    await enqueue(name);
  });

  pi.on("session_info_changed", async (event, ctx) => {
    if (ctx && ctx.mode !== "tui") {
      return;
    }
    await enqueue(event?.name ?? undefined);
  });
}
