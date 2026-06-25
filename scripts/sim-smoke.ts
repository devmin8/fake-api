// Firehose streaming proof — the whole thesis of the project on the wire. Bruno
// can't speak WebSockets, so this stands in for task-013's acceptance checks. It
// opens an ANONYMOUS socket (no cookie — zero authenticated clients), subscribes
// to feed:global, then drives the feed purely through the /api/sim control
// surface and asserts a `post.created` streams in. Because bot posts go through
// the same services real writes use, the event is indistinguishable from a real
// one and the post is durable in SQLite.
//
// Exits non-zero on the first failed expectation so it gates CI directly.
// Assumes the API is running with SIM_CONTROL_ENABLED=true and seeded with bots.
//
//   bun run scripts/sim-smoke.ts
//   BASE_URL=http://localhost:3000 bun run scripts/sim-smoke.ts

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const WS_URL = BASE.replace(/^http/, "ws") + "/ws";
const TIMEOUT_MS = 8000;

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const pass = (msg: string): void => console.log(`✓ ${msg}`);

// A tiny message-matching client over one socket: `next(pred)` resolves to the
// first parsed frame satisfying `pred` (replaying anything buffered), or rejects
// on timeout. `open` resolves once connected.
const connect = (cookie?: string) => {
  const ws = new WebSocket(WS_URL, cookie ? { headers: { Cookie: cookie } } : undefined);
  const buffer: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];

  ws.addEventListener("message", (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data));
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else buffer.push(msg);
  });

  const open = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });

  const next = (pred: (m: any) => boolean, label: string): Promise<any> => {
    const i = buffer.findIndex(pred);
    if (i >= 0) return Promise.resolve(buffer.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${label}`)),
        TIMEOUT_MS,
      );
      waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  };

  return { ws, open, next };
};

const sim = (path: string, body?: unknown) =>
  fetch(`${BASE}/api/sim/${path}`, {
    method: body ? "PATCH" : "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

// Make sure we start from a stopped sim, whatever the server's SIM_ENABLED was.
await sim("stop");

// --- the anonymous socket: zero authenticated clients ----------------------

const anon = connect();
await anon.open;
pass("anonymous socket connected (no cookie)");

anon.ws.send(JSON.stringify({ action: "subscribe", topic: "feed:global" }));
await anon.next(
  (m) => m.ok && m.action === "subscribe" && m.topic === "feed:global",
  "feed:global subscribe ack",
);
pass("subscribed to feed:global");

// Crank the cadence so a create-post bucket lands fast and deterministically:
// many actions per tick, weighted hard toward post creation.
const cfgRes = await sim("config", {
  intervalMs: 150,
  actionsPerTick: 8,
  weights: { createPost: 100, comment: 1, likePost: 1, likeCommentOrFollow: 1 },
});
if (!cfgRes.ok) fail(`config patch failed: ${cfgRes.status} ${await cfgRes.text()}`);

const startRes = await sim("start");
if (!startRes.ok) fail(`start failed: ${startRes.status} ${await startRes.text()}`);
const started = (await startRes.json()) as { running: boolean };
if (!started.running) fail("status did not report running after start");
pass("sim started (status: running)");

// --- the proof: a post.created streams in with no client write -------------

const created = await anon.next(
  (m) => m.topic === "feed:global" && m.event === "post.created",
  "post.created on feed:global driven by the sim",
);
if (!created.data?.id) fail("post.created envelope missing a post id");
if (typeof created.ts !== "string") fail("post.created envelope missing ts");
if (!created.data.author) fail("post.created payload missing its author card");
pass(`feed:global → post.created streamed from the sim (post ${created.data.id})`);

const stopRes = await sim("stop");
const stopped = (await stopRes.json()) as { running: boolean };
if (stopped.running) fail("status still running after stop");
pass("sim stopped (status: not running)");

anon.ws.close();
console.log("\nAll firehose smoke checks passed.");
process.exit(0);
