// WebSocket smoke test — Bruno can't speak WebSockets, so this stands in for the
// realtime acceptance checks. It logs in, opens a socket, and drives real REST
// writes while asserting the matching events arrive on the wire:
//
//   1. feed:global   → post.created  when a post is created
//   2. post:{id}      → post.liked    with a fresh count when the post is liked
//   3. user:{id}      → auth gate: anonymous subscribe is rejected, the owner's
//                       own subscribe is accepted
//
// Exits non-zero on the first failed expectation so it gates CI directly.
// Assumes the API is already running and seeded (bun run dev; bun run db:seed).
//
//   bun run scripts/ws-smoke.ts
//   BASE_URL=http://localhost:3000 TEST_EMAIL=alice@example.com bun run scripts/ws-smoke.ts

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const WS_URL = BASE.replace(/^http/, "ws") + "/ws";
const EMAIL = process.env.TEST_EMAIL ?? "alice@example.com";
const PASSWORD = process.env.TEST_PASSWORD ?? "password123";
const TIMEOUT_MS = 5000;

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
const pass = (msg: string): void => console.log(`✓ ${msg}`);

// A tiny message-matching client over a single socket: `next(pred)` resolves to
// the first parsed frame satisfying `pred` (replaying anything already buffered),
// or rejects on timeout. `open` resolves once the socket is connected.
interface Client {
  ws: WebSocket;
  open: Promise<void>;
  next: (pred: (m: any) => boolean, label: string) => Promise<any>;
}

const connect = (cookie?: string): Client => {
  const ws = new WebSocket(WS_URL, cookie ? { headers: { Cookie: cookie } } : undefined);
  const buffer: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];

  ws.addEventListener("message", (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data));
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      w.resolve(msg);
    } else {
      buffer.push(msg);
    }
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

// --- log in (capture cookies straight off Set-Cookie, like the Bruno suite) ---

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!loginRes.ok) fail(`login failed: ${loginRes.status} ${await loginRes.text()}`);

const me = (await loginRes.json()) as { id: string };
const setCookies = loginRes.headers.getSetCookie();
const pick = (name: string): string | null => {
  const hit = setCookies.find((c) => c.startsWith(name + "="));
  return hit ? hit.split(";")[0].slice(name.length + 1) : null;
};
const access = pick("access_token");
const csrf = pick("csrf_token");
if (!access || !csrf) fail("login did not return access_token / csrf_token cookies");

const cookieHeader = `access_token=${access}; csrf_token=${csrf}`;
const restHeaders = {
  "content-type": "application/json",
  cookie: cookieHeader,
  "x-csrf-token": csrf!,
};
pass(`logged in as ${EMAIL} (${me.id})`);

// --- the authenticated socket the happy-path tests run on -------------------

const client = connect(cookieHeader);
await client.open;
pass("socket connected");

// 1 · feed:global receives post.created -------------------------------------

client.ws.send(JSON.stringify({ action: "subscribe", topic: "feed:global" }));
await client.next(
  (m) => m.ok && m.action === "subscribe" && m.topic === "feed:global",
  "feed:global subscribe ack",
);

const title = `ws-smoke ${me.id}-${access!.slice(0, 8)}`;
const createRes = await fetch(`${BASE}/api/posts`, {
  method: "POST",
  headers: restHeaders,
  body: JSON.stringify({ title, body: "smoke test post", tags: ["ws-smoke"] }),
});
if (createRes.status !== 201) fail(`create post failed: ${createRes.status} ${await createRes.text()}`);
const post = (await createRes.json()) as { id: string };

const created = await client.next(
  (m) => m.topic === "feed:global" && m.event === "post.created",
  "post.created on feed:global",
);
if (created.data?.id !== post.id) fail(`post.created carried the wrong post id: ${created.data?.id}`);
if (typeof created.ts !== "string") fail("post.created envelope missing ts");
pass("feed:global → post.created (matching id + ts)");

// 2 · post:{id} receives post.liked with a fresh count -----------------------

client.ws.send(JSON.stringify({ action: "subscribe", topic: `post:${post.id}` }));
await client.next(
  (m) => m.ok && m.action === "subscribe" && m.topic === `post:${post.id}`,
  "post topic subscribe ack",
);

const likeRes = await fetch(`${BASE}/api/posts/${post.id}/like`, {
  method: "POST",
  headers: restHeaders,
});
if (!likeRes.ok) fail(`like failed: ${likeRes.status} ${await likeRes.text()}`);

const liked = await client.next(
  (m) => m.topic === `post:${post.id}` && m.event === "post.liked",
  "post.liked on post topic",
);
if (liked.data?.likeCount !== 1) fail(`post.liked carried likeCount=${liked.data?.likeCount}, expected 1`);
pass("post:{id} → post.liked (likeCount=1)");

// 3 · user:{id} auth gate ----------------------------------------------------

// Owner may subscribe to their own user topic.
client.ws.send(JSON.stringify({ action: "subscribe", topic: `user:${me.id}` }));
await client.next(
  (m) => m.ok && m.action === "subscribe" && m.topic === `user:${me.id}`,
  "own user topic subscribe ack",
);
pass("user:{id} → owner may subscribe");

// An anonymous socket (no cookie) must be refused the same topic.
const anon = connect();
await anon.open;
anon.ws.send(JSON.stringify({ action: "subscribe", topic: `user:${me.id}` }));
const refused = await anon.next(
  (m) => m.error?.code === "FORBIDDEN",
  "FORBIDDEN for anonymous user-topic subscribe",
);
if (!refused.error) fail("anonymous user-topic subscribe was not refused");
pass("user:{id} → anonymous subscribe rejected (FORBIDDEN)");

client.ws.close();
anon.ws.close();
console.log("\nAll WebSocket smoke checks passed.");
process.exit(0);
