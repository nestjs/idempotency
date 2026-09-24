import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import type { IdempotencyEvent } from './idempotency-events.interface.js';
import { channels } from './idempotency.channels.js';

/**
 * The app's idempotency events, for metrics and alerts. Each event is also
 * published on `node:diagnostics_channel`, as `nestjs:idempotency:replayed`,
 * `nestjs:idempotency:rejected` and `nestjs:idempotency:lock-lost`, for
 * tracing and APM tools.
 */
@Injectable()
export class IdempotencyEvents implements OnApplicationShutdown {
  private readonly subject = new Subject<IdempotencyEvent>();
  readonly events$: Observable<IdempotencyEvent> = this.subject.asObservable();

  /** Called by the interceptor. */
  emit(event: IdempotencyEvent): void {
    const diagnostics = channels[event.type];
    if (diagnostics.hasSubscribers) {
      diagnostics.publish(event);
    }
    this.subject.next(event);
  }

  onApplicationShutdown() {
    this.subject.complete();
  }
}
