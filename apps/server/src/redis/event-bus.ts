import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { InMemoryEventBus, type BusMessage, type EventBus } from "../realtime/bus.js";

const CHANNEL_PREFIX = "ff:";

function isBusMessage(value: unknown): value is BusMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (m["type"] === "config") return typeof m["environmentId"] === "string" && Number.isInteger(m["version"]);
  if (m["type"] === "key_revoked") return typeof m["apiKeyId"] === "string";
  return false;
}

/**
 * Event bus that works across several server instances using Redis pub/sub.
 *
 * Delivery on the publishing instance is LOCAL and immediate, independent of Redis, so Redis
 * trouble never breaks the instance's own streams. Redis only carries events to the OTHER
 * instances. Each message is tagged with this instance's id and we ignore our own echo, so
 * nothing is delivered twice.
 *
 * Pub/sub does not store messages: anything published while this instance was disconnected from
 * Redis is gone. So when the subscriber reconnects we fire `onResync`, and the stream manager
 * sends every connected SDK a fresh `hello` so they compare versions and catch up.
 */
export class RedisEventBus implements EventBus {
  readonly #local = new InMemoryEventBus();
  readonly #topicRefs = new Map<string, number>();
  readonly #resyncHandlers = new Set<() => void>();
  readonly #healthHandlers = new Set<(healthy: boolean) => void>();
  /** True once the subscriber connection is up: only then can we hear other instances. */
  #healthy = false;
  readonly #instanceId = randomUUID();
  #everReady = false;

  /** `sub` must be a dedicated connection: Redis forbids normal commands on a subscribed connection. */
  constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
  ) {
    sub.on("message", (channel: string, raw: string) => this.#onMessage(channel, raw));
    sub.on("close", () => this.#setHealthy(false));
    sub.on("ready", () => {
      this.#setHealthy(true);
      if (this.#everReady) {
        // A reconnect: events may have been missed while we were away.
        for (const handler of [...this.#resyncHandlers]) {
          try {
            handler();
          } catch {
            // one broken handler must not stop the others
          }
        }
      }
      this.#everReady = true;
    });
  }

  get instanceId() {
    return this.#instanceId;
  }

  #setHealthy(healthy: boolean) {
    if (this.#healthy === healthy) return;
    this.#healthy = healthy;
    for (const handler of [...this.#healthHandlers]) {
      try {
        handler(healthy);
      } catch {
        // one broken handler must not stop the others
      }
    }
  }

  isHealthy(): boolean {
    return this.#healthy;
  }

  onHealthChange(handler: (healthy: boolean) => void): () => void {
    this.#healthHandlers.add(handler);
    return () => this.#healthHandlers.delete(handler);
  }

  #onMessage(channel: string, raw: string) {
    if (!channel.startsWith(CHANNEL_PREFIX)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    // JSON can be null, a number, an array... Anything that is not a plain object is junk, and this
    // runs inside an event emitter, so a throw here would be an uncaught exception that kills the process.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const envelope = parsed as { from?: unknown; message?: unknown };
    if (envelope.from === this.#instanceId || !isBusMessage(envelope.message)) return; // own echo, or malformed
    void this.#local.publish(channel.slice(CHANNEL_PREFIX.length), envelope.message);
  }

  async publish(topic: string, message: BusMessage): Promise<void> {
    await this.#local.publish(topic, message);
    try {
      await this.pub.publish(CHANNEL_PREFIX + topic, JSON.stringify({ from: this.#instanceId, message }));
    } catch {
      // Other instances miss this event; their SDKs catch up on resync or the next poll.
    }
  }

  subscribe(topic: string, handler: (message: BusMessage) => void): () => void {
    const off = this.#local.subscribe(topic, handler);
    const refs = (this.#topicRefs.get(topic) ?? 0) + 1;
    this.#topicRefs.set(topic, refs);
    if (refs === 1) this.sub.subscribe(CHANNEL_PREFIX + topic).catch(() => {}); // re-sent automatically on reconnect
    let released = false;
    return () => {
      if (released) return;
      released = true;
      off();
      const left = (this.#topicRefs.get(topic) ?? 1) - 1;
      if (left <= 0) {
        this.#topicRefs.delete(topic);
        this.sub.unsubscribe(CHANNEL_PREFIX + topic).catch(() => {});
      } else {
        this.#topicRefs.set(topic, left);
      }
    };
  }

  onResync(handler: () => void): () => void {
    this.#resyncHandlers.add(handler);
    return () => this.#resyncHandlers.delete(handler);
  }

  async close(): Promise<void> {
    await this.#local.close();
    this.#topicRefs.clear();
    this.#resyncHandlers.clear();
    this.#healthHandlers.clear();
  }

  get topicCount() {
    return this.#topicRefs.size;
  }
}
