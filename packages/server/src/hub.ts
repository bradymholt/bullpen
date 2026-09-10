import type { WebSocket } from "ws";

type Subscriber = { ws: WebSocket; runId: string };

/**
 * WebSocket fan-out. Clients subscribe to one run and get everything past a
 * seq they already have; replay and live streaming are the same path, so a
 * reconnect and a server restart look identical to the client.
 */
class Hub {
  #subs = new Set<Subscriber>();

  subscribe(ws: WebSocket, runId: string): Subscriber {
    const sub = { ws, runId };
    this.#subs.add(sub);
    return sub;
  }

  unsubscribe(sub: Subscriber): void {
    this.#subs.delete(sub);
  }

  unsubscribeSocket(ws: WebSocket): void {
    for (const sub of this.#subs) if (sub.ws === ws) this.#subs.delete(sub);
  }

  broadcast(runId: string, message: unknown): void {
    const payload = JSON.stringify(message);
    for (const sub of this.#subs) {
      if (sub.runId !== runId) continue;
      if (sub.ws.readyState !== sub.ws.OPEN) continue;
      sub.ws.send(payload);
    }
  }
}

export const hub = new Hub();
