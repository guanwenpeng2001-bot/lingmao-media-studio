import { API_BASE } from './client';
import type { Job, JobEvent } from './types';

export interface JobStreamOptions {
  onJobEvent: (event: JobEvent) => void;
  onSyncFallback: () => Promise<boolean>; // returns true if active jobs still exist
  onConnectionChange?: (connected: boolean) => void;
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

export function shouldApplyJobUpdate(current: Job | undefined, incomingRevision: number): boolean {
  if (!current) return true;
  return incomingRevision >= current.revision;
}

export function isTerminalJobStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Manages SSE /api/v1/events/jobs subscription with:
 * - eventId deduplication
 * - monotonic revision guard
 * - Last-Event-ID reconnect via fetch streaming / EventSource
 * - exponential backoff polling fallback when SSE disconnects or is unsupported
 */
export class JobEventStream {
  private seenEventIds = new Set<string>();
  private latestRevisionByJob = new Map<string, number>();
  private lastEventId: string | null = null;
  private eventSource: EventSource | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private backoffMs = 2000;
  private readonly options: JobStreamOptions;

  constructor(options: JobStreamOptions) {
    this.options = options;
  }

  start(): void {
    this.stopped = false;
    this.connectSse();
  }

  stop(): void {
    this.stopped = true;
    this.cleanupTimers();
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  private cleanupTimers(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleEventData(raw: string, idHeader?: string | null): void {
    try {
      const ev = JSON.parse(raw) as JobEvent;
      if (!ev || typeof ev.eventId !== 'string' || typeof ev.jobId !== 'string') return;
      if (this.seenEventIds.has(ev.eventId)) return;
      this.seenEventIds.add(ev.eventId);
      if (this.seenEventIds.size > 2000) {
        const first = this.seenEventIds.values().next().value;
        if (first) this.seenEventIds.delete(first);
      }

      const prevRev = this.latestRevisionByJob.get(ev.jobId) ?? -1;
      if (typeof ev.revision === 'number' && ev.revision < prevRev) {
        return; // reject stale out-of-order status regression
      }
      if (typeof ev.revision === 'number') {
        this.latestRevisionByJob.set(ev.jobId, ev.revision);
      }
      this.lastEventId = idHeader || ev.eventId;
      this.options.onJobEvent(ev);
    } catch {
      // ignore malformed SSE chunk
    }
  }

  private connectSse(): void {
    if (this.stopped) return;
    if (typeof EventSource === 'undefined') {
      this.startPollingFallback();
      return;
    }

    const url = this.lastEventId
      ? `${API_BASE}/events/jobs?lastEventId=${encodeURIComponent(this.lastEventId)}`
      : `${API_BASE}/events/jobs`;

    try {
      const es = new EventSource(url, { withCredentials: true });
      this.eventSource = es;

      es.onopen = () => {
        this.backoffMs = 2000;
        this.options.onConnectionChange?.(true);
      };

      const onMsg = (evt: MessageEvent) => {
        this.handleEventData(String(evt.data), evt.lastEventId);
      };

      es.onmessage = onMsg;
      es.addEventListener('job', onMsg as EventListener);

      es.onerror = () => {
        this.options.onConnectionChange?.(false);
        es.close();
        this.eventSource = null;
        if (this.stopped) return;
        // Reconcile state via GET /jobs and schedule reconnect with exponential backoff
        void this.options.onSyncFallback().catch(() => false);
        this.scheduleReconnect();
      };
    } catch {
      this.startPollingFallback();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.cleanupTimers();
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    this.reconnectTimer = setTimeout(() => {
      this.connectSse();
    }, delay);
  }

  private startPollingFallback(): void {
    if (this.stopped) return;
    this.cleanupTimers();
    const tick = async () => {
      if (this.stopped) return;
      try {
        const hasActive = await this.options.onSyncFallback();
        if (!hasActive) {
          this.backoffMs = 2000;
          return; // stop polling once all active jobs reach terminal state
        }
      } catch {
        // backoff on error
      }
      const delay = this.backoffMs;
      this.backoffMs = Math.min(Math.round(this.backoffMs * 1.5), 15000);
      this.pollTimer = setTimeout(() => {
        void tick();
      }, delay);
    };
    void tick();
  }
}
