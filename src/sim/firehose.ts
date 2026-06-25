// The firehose simulator — the payoff of the whole project. A timer fires every
// `intervalMs`; each tick runs `actionsPerTick` weighted-random actions as
// `is_bot` users, driving the EXACT services real requests use. Because the
// services are the one write path, every bot action lands in SQLite and
// broadcasts the same WS events as a real write — so the feed visibly streams
// with zero authenticated clients connected, and simulated/real data can never
// diverge.
//
// Resilience: a single action can fail (e.g. nothing to comment on yet on a
// fresh db); we swallow per-action so one bad draw never kills the timer.

import { eq, sql } from "drizzle-orm";

import { config } from "~/config.ts";
import { db } from "~/db/index.ts";
import { comments, posts, users } from "~/db/schema.ts";
import { createComment } from "~/services/comments.ts";
import { follow } from "~/services/follows.ts";
import { like } from "~/services/likes.ts";
import { createPost } from "~/services/posts.ts";

// The four weighted buckets. Defaults match the ticket: create post 20% ·
// comment 35% · like post 30% · like-comment/follow 15%. The last bucket splits
// 50/50 between liking a comment and following someone.
export interface SimWeights {
  createPost: number;
  comment: number;
  likePost: number;
  likeCommentOrFollow: number;
}

export interface SimConfig {
  intervalMs: number;
  actionsPerTick: number;
  weights: SimWeights;
}

export interface SimStatus extends SimConfig {
  running: boolean;
}

// A partial config patch — every field optional; weights merge field-by-field.
export interface SimConfigPatch {
  intervalMs?: number;
  actionsPerTick?: number;
  weights?: Partial<SimWeights>;
}

// --- random content (self-contained, no faker at runtime) -------------------

const choice = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

const TITLE_OPENERS = [
  "TIL", "Hot take", "Why I switched to", "A quick note on", "Shipping",
  "Debugging", "Lessons from", "The case for", "Rethinking", "Notes on",
];
const TOPICS = [
  "Bun", "SQLite", "WebSockets", "keyset pagination", "Drizzle", "Elysia",
  "type safety", "edge caching", "cookie auth", "the event loop", "WAL mode",
];
const BODIES = [
  "Spent the afternoon on this and it finally clicked.",
  "Curious whether anyone else has hit the same wall.",
  "Turns out the docs were right all along.",
  "Small change, big difference in latency.",
  "Wrote it three ways before the simple one won.",
  "The fix was one line. Finding it was not.",
];
const COMMENTS = [
  "Great write-up, thanks for sharing!",
  "I ran into this exact thing last week.",
  "Have you tried benchmarking it?",
  "This is the way.",
  "Source? Would love to read more.",
  "Saved me a few hours — appreciated.",
  "Disagree slightly, but solid points.",
];
const SEED_TAGS = ["Bun", "TypeScript", "Databases", "WebDev", "AI", "Testing"];

const botTitle = (): string => `${choice(TITLE_OPENERS)} ${choice(TOPICS)}`;
const botImage = (): string =>
  // Deterministic placeholder service; the seed makes each image distinct.
  `https://picsum.photos/seed/${Math.floor(Math.random() * 1_000_000)}/800/600`;

// --- random row pickers (ORDER BY RANDOM() — fine at sim scale) --------------

const randomBotId = (): string | null =>
  db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isBot, true))
    .orderBy(sql`RANDOM()`)
    .limit(1)
    .get()?.id ?? null;

const randomPostId = (): string | null =>
  db
    .select({ id: posts.id })
    .from(posts)
    .orderBy(sql`RANDOM()`)
    .limit(1)
    .get()?.id ?? null;

const randomCommentId = (): string | null =>
  db
    .select({ id: comments.id })
    .from(comments)
    .orderBy(sql`RANDOM()`)
    .limit(1)
    .get()?.id ?? null;

const randomUser = (): { id: string; username: string } | null =>
  db
    .select({ id: users.id, username: users.username })
    .from(users)
    .orderBy(sql`RANDOM()`)
    .limit(1)
    .get() ?? null;

class Firehose {
  private timer: ReturnType<typeof setInterval> | null = null;

  intervalMs = config.simIntervalMs;
  actionsPerTick = config.simActionsPerTick;
  weights: SimWeights = {
    createPost: 20,
    comment: 35,
    likePost: 30,
    likeCommentOrFollow: 15,
  };

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  status(): SimStatus {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      actionsPerTick: this.actionsPerTick,
      weights: { ...this.weights },
    };
  }

  // Apply a partial patch live. Changing the interval while running re-arms the
  // timer so the new cadence takes effect immediately, not on the next restart.
  configure(patch: SimConfigPatch): SimStatus {
    if (patch.actionsPerTick !== undefined) {
      this.actionsPerTick = Math.max(1, Math.floor(patch.actionsPerTick));
    }
    if (patch.weights) {
      this.weights = { ...this.weights, ...patch.weights };
    }
    if (patch.intervalMs !== undefined) {
      this.intervalMs = Math.max(50, Math.floor(patch.intervalMs));
      if (this.running) {
        this.stop();
        this.start();
      }
    }
    return this.status();
  }

  private async tick(): Promise<void> {
    for (let i = 0; i < this.actionsPerTick; i++) {
      try {
        await this.runAction();
      } catch {
        // A bad draw (e.g. no posts yet, a self-follow) is expected churn — the
        // services threw before any broadcast, so nothing leaked. Keep ticking.
      }
    }
  }

  // Weighted pick over the four buckets, then perform one as a random bot.
  private async runAction(): Promise<void> {
    const actor = randomBotId();
    if (!actor) return; // no bots seeded — nothing to drive.

    const w = this.weights;
    const total = w.createPost + w.comment + w.likePost + w.likeCommentOrFollow;
    if (total <= 0) return;
    let roll = Math.random() * total;

    if ((roll -= w.createPost) < 0) return this.doCreatePost(actor);
    if ((roll -= w.comment) < 0) return this.doComment(actor);
    if ((roll -= w.likePost) < 0) return this.doLikePost(actor);
    return this.doLikeCommentOrFollow(actor);
  }

  private async doCreatePost(actor: string): Promise<void> {
    await createPost(actor, {
      title: botTitle(),
      body: choice(BODIES),
      imageUrl: botImage(),
      tags: [choice(SEED_TAGS)],
    });
  }

  private async doComment(actor: string): Promise<void> {
    const postId = randomPostId();
    if (!postId) return;
    await createComment(postId, actor, { body: choice(COMMENTS) });
  }

  private async doLikePost(actor: string): Promise<void> {
    const postId = randomPostId();
    if (!postId) return;
    await like(actor, "post", postId);
  }

  private async doLikeCommentOrFollow(actor: string): Promise<void> {
    if (Math.random() < 0.5) {
      const commentId = randomCommentId();
      if (commentId) await like(actor, "comment", commentId);
      return;
    }
    const target = randomUser();
    // follow() rejects self-follows; skip rather than churn an expected throw.
    if (target && target.id !== actor) await follow(actor, target.username);
  }
}

// The one process-wide simulator. Routes toggle it; index.ts auto-starts it when
// SIM_ENABLED. It holds no client state, so start/stop are cheap and idempotent.
export const firehose = new Firehose();
