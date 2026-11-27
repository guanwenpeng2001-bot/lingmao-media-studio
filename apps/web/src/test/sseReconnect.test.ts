import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { JobEventStream } from '../api/sse';

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState: number = FakeEventSource.OPEN;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closedCount = 0;
  private listeners = new Map<string, ((ev: MessageEvent) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: MessageEvent) => void) {
    const arr = this.listeners.get(type) || [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }

  close() {
    this.closedCount += 1;
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type: string, data: unknown, lastEventId = '') {
    const evt = { data: JSON.stringify(data), lastEventId } as MessageEvent;
    if (type === 'message') {
      this.onmessage?.(evt);
    } else {
      for (const cb of this.listeners.get(type) || []) cb(evt);
    }
  }
}

describe('P1-1 SSE JobEventStream Last-Event-ID Reconnect, Dedup & Revision Guard', () => {
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.EventSource = originalEventSource;
  });

  it('tracks cursor, keeps native EventSource alive while CONNECTING, and rebuilds with ?lastEventId= only when CLOSED', () => {
    const onJobEvent = vi.fn();
    const onSyncFallback = vi.fn().mockResolvedValue(false);

    const stream = new JobEventStream({ onJobEvent, onSyncFallback });
    stream.start();

    expect(FakeEventSource.instances).toHaveLength(1);
    const firstEs = FakeEventSource.instances[0];
    expect(firstEs.url).toBe('/api/v1/events/jobs');

    // Receive event with lastEventId header -> advances cursor
    firstEs.emit(
      'job',
      { eventId: 'evt-42', jobId: 'job-1', revision: 2, status: 'running', at: '2026-11-27T00:00:00Z' },
      '42'
    );
    expect(stream.getLastEventId()).toBe('42');
    expect(onJobEvent).toHaveBeenCalledTimes(1);

    // Duplicate eventId must be deduplicated
    firstEs.emit(
      'job',
      { eventId: 'evt-42', jobId: 'job-1', revision: 2, status: 'running', at: '2026-11-27T00:00:00Z' },
      '42'
    );
    expect(onJobEvent).toHaveBeenCalledTimes(1);

    // Lower revision for same job must be rejected (no status regression)
    firstEs.emit(
      'job.updated',
      { eventId: 'evt-43', jobId: 'job-1', revision: 1, status: 'queued', at: '2026-11-27T00:00:01Z' },
      ''
    );
    expect(onJobEvent).toHaveBeenCalledTimes(1);
    // Fallback to JobEvent.eventId advances cursor
    expect(stream.getLastEventId()).toBe('evt-43');

    // Transient error while CONNECTING: MUST NOT call close() (preserves browser native Last-Event-ID header)
    firstEs.readyState = FakeEventSource.CONNECTING;
    firstEs.onerror?.(new Event('error'));
    expect(firstEs.closedCount).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(1);

    // Fatal CLOSED error: schedules backoff rebuild carrying ?lastEventId=evt-43
    firstEs.readyState = FakeEventSource.CLOSED;
    firstEs.onerror?.(new Event('error'));

    vi.advanceTimersByTime(2000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toBe('/api/v1/events/jobs?lastEventId=evt-43');

    stream.stop();
  });
});
