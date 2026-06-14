import type { EventStream } from '@croo-network/sdk';
import type { Event } from '@croo-network/sdk';

/**
 * Wraps one CAP WebSocket stream with a single dispatcher + a short replay buffer.
 *
 * Why the buffer: the event we are waiting for (e.g. OrderCreated for a negotiation we
 * just opened) can arrive on the wire BEFORE we call `wait()`, because the provider
 * accepts the negotiation almost immediately. `wait()` therefore checks already-seen
 * events first, then waits for a live one. Using one `onAny` dispatcher (instead of a
 * fresh `on()` per hire) avoids leaking handlers across many hires.
 */
export class EventBus {
  private readonly recent: Event[] = [];
  private readonly waiters: {
    pred: (e: Event) => boolean;
    resolve: (e: Event) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  constructor(stream: EventStream, private readonly bufferSize = 200) {
    stream.onAny((e) => this.dispatch(e));
  }

  private dispatch(e: Event): void {
    this.recent.push(e);
    if (this.recent.length > this.bufferSize) this.recent.shift();
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (w.pred(e)) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve(e);
      }
    }
  }

  /** Resolve with the first event matching `pred` (checking recent events first). */
  wait(pred: (e: Event) => boolean, timeoutMs: number, label: string): Promise<Event> {
    const buffered = this.recent.find(pred);
    if (buffered) return Promise.resolve(buffered);
    return new Promise<Event>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timed out waiting for ${label} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }
}
