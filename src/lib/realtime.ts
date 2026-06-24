// The in-memory WebSocket hub — one fan-out point the whole app shares. Every
// service mutation calls `hub.broadcast(...)` *after* its DB transaction commits,
// so the wire is always consistent with the database (a rolled-back write throws
// before it can broadcast). The simulator drives the exact same services, so
// simulated and real events are indistinguishable on the wire.
//
// Shape is a small map of topic → Set<socket>. We key on the raw socket (stable
// for a connection's whole lifetime) and keep a reverse index socket → topics so
// a disconnect drops the socket from every topic in one pass — no leaked entries.
//
// Topic access (feed:global, tag:{slug}, post:{id} public; user:{id} per-user) is
// enforced at subscribe time by the WS route, not here — the hub just routes.

// The slice of a socket the hub needs: somewhere to write a frame. Both Elysia's
// raw Bun ServerWebSocket and a test double satisfy this.
export interface Socket {
  send(data: string): unknown;
}

// The server→client wire envelope every broadcast carries.
export interface WireEnvelope {
  topic: string;
  event: string;
  data: unknown;
  ts: string;
}

class Hub {
  // topic → its current subscribers.
  private topics = new Map<string, Set<Socket>>();
  // socket → the topics it has joined (reverse index for O(joined) cleanup).
  private bySocket = new Map<Socket, Set<string>>();

  subscribe(topic: string, socket: Socket): void {
    let subs = this.topics.get(topic);
    if (!subs) {
      subs = new Set();
      this.topics.set(topic, subs);
    }
    subs.add(socket);

    let joined = this.bySocket.get(socket);
    if (!joined) {
      joined = new Set();
      this.bySocket.set(socket, joined);
    }
    joined.add(topic);
  }

  unsubscribe(topic: string, socket: Socket): void {
    const subs = this.topics.get(topic);
    if (subs) {
      subs.delete(socket);
      if (subs.size === 0) this.topics.delete(topic);
    }
    const joined = this.bySocket.get(socket);
    if (joined) {
      joined.delete(topic);
      if (joined.size === 0) this.bySocket.delete(socket);
    }
  }

  // Drop a socket from every topic it joined — called once on disconnect so the
  // sets never accumulate dead sockets.
  cleanup(socket: Socket): void {
    const joined = this.bySocket.get(socket);
    if (!joined) return;
    for (const topic of joined) {
      const subs = this.topics.get(topic);
      if (subs) {
        subs.delete(socket);
        if (subs.size === 0) this.topics.delete(topic);
      }
    }
    this.bySocket.delete(socket);
  }

  // Fan a server→client event out to every subscriber of `topic`, wrapped in the
  // standard envelope. A send can throw on a half-closed socket; we swallow it so
  // one dead client can't break the broadcast — the close handler cleans it up.
  broadcast(topic: string, event: string, data: unknown): void {
    const subs = this.topics.get(topic);
    if (!subs || subs.size === 0) return;
    const envelope: WireEnvelope = {
      topic,
      event,
      data,
      ts: new Date().toISOString(),
    };
    const payload = JSON.stringify(envelope);
    for (const socket of subs) {
      try {
        socket.send(payload);
      } catch {
        // half-closed socket — cleanup() on close will remove it.
      }
    }
  }

  // Introspection: how many sockets are subscribed to a topic right now.
  subscriberCount(topic: string): number {
    return this.topics.get(topic)?.size ?? 0;
  }
}

// The one process-wide hub. Services import this directly; the WS route feeds it
// subscriptions. No imports back into services here, so wiring it into a service
// can never create a cycle.
export const hub = new Hub();
