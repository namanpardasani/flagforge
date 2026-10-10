export type BusMessage =
  | { type: "config"; environmentId: string; version: number }
  | { type: "key_revoked"; apiKeyId: string };

export const envTopic = (environmentId: string) => `env:${environmentId}`;
export const keyTopic = (apiKeyId: string) => `key:${apiKeyId}`;

/**
 * Carries "something changed" hints between parts of the system. The database is always the source
 * of truth; a lost message only delays an SDK until its next poll. Phase 9 adds a Redis
 * implementation of this interface so several server instances can share events.
 */
export interface EventBus {
  publish(topic: string, message: BusMessage): Promise<void>;
  subscribe(topic: string, handler: (message: BusMessage) => void): () => void;
  /**
   * Called when the bus may have missed messages (e.g. Redis reconnected after an outage).
   * Listeners should re-check the database instead of trusting what they heard.
   */
  onResync(handler: () => void): () => void;
  /**
   * False while this instance cannot hear events from other instances (e.g. its Redis connection is
   * down). Streams use it to tell SDKs to poll normally instead of trusting the stream.
   */
  isHealthy(): boolean;
  onHealthChange(handler: (healthy: boolean) => void): () => void;
  close(): Promise<void>;
}

export class InMemoryEventBus implements EventBus {
  #handlers = new Map<string, Set<(message: BusMessage) => void>>();

  async publish(topic: string, message: BusMessage): Promise<void> {
    for (const handler of [...(this.#handlers.get(topic) ?? [])]) {
      try {
        handler(message);
      } catch {
        // One broken subscriber must not stop delivery to the others.
      }
    }
  }

  subscribe(topic: string, handler: (message: BusMessage) => void): () => void {
    let set = this.#handlers.get(topic);
    if (!set) this.#handlers.set(topic, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0 && this.#handlers.get(topic) === set) this.#handlers.delete(topic);
    };
  }

  /** Nothing in this process can be missed, so a resync is never needed. */
  onResync(_handler: () => void): () => void {
    return () => {};
  }

  /** Everything happens inside this process, so the bus cannot be cut off from other publishers. */
  isHealthy(): boolean {
    return true;
  }

  onHealthChange(_handler: (healthy: boolean) => void): () => void {
    return () => {};
  }

  async close(): Promise<void> {
    this.#handlers.clear();
  }

  get topicCount() {
    return this.#handlers.size;
  }
}

/** Publishing is best-effort: the change is already committed, so a bus failure must not fail the request. */
export async function publishQuietly(bus: EventBus, topic: string, message: BusMessage): Promise<void> {
  try {
    await bus.publish(topic, message);
  } catch {
    // SDKs will catch up on their next poll.
  }
}
