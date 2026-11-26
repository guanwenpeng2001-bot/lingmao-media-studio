import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Film, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import { api } from '../api/client';
import type { Cue } from '../api/types';

export interface TimelineClip {
  nodeId: string;
  label: string;
  assetId?: string;
  durationSeconds: number;
  cues?: Cue[];
}

interface MultiVideoTimelineProps {
  clips: TimelineClip[];
  onClose: () => void;
}

export const MultiVideoTimeline: React.FC<MultiVideoTimelineProps> = ({ clips, onClose }) => {
  const [playing, setPlaying] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const timelineSegments = useMemo(() => {
    let cursor = 0;
    return clips.map((c) => {
      const start = cursor;
      const dur = Math.max(1, c.durationSeconds || 5);
      cursor += dur;
      return { ...c, start, end: cursor, durationSeconds: dur };
    });
  }, [clips]);

  const totalDuration = useMemo(
    () => timelineSegments.reduce((acc, s) => acc + s.durationSeconds, 0),
    [timelineSegments]
  );

  const activeIndex = useMemo(() => {
    const idx = timelineSegments.findIndex(
      (seg) => currentTimeSec >= seg.start && currentTimeSec < seg.end
    );
    return idx === -1 ? Math.max(0, timelineSegments.length - 1) : idx;
  }, [timelineSegments, currentTimeSec]);

  const activeSegment = timelineSegments[activeIndex];
  const localTimeSec = activeSegment ? Math.max(0, currentTimeSec - activeSegment.start) : 0;

  // Unified playback clock advancing across multiple sequential clips
  useEffect(() => {
    if (!playing || totalDuration <= 0) return;
    const timer = window.setInterval(() => {
      setCurrentTimeSec((prev) => {
        const next = prev + 0.1;
        if (next >= totalDuration) {
          setPlaying(false);
          return totalDuration;
        }
        return next;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing, totalDuration]);

  // Sync HTML5 video element to active clip local time when available
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !activeSegment?.assetId) return;
    if (Math.abs(el.currentTime - localTimeSec) > 0.35) {
      try {
        el.currentTime = localTimeSec;
      } catch {
        // ignore unready video seek
      }
    }
    if (playing) {
      void el.play().catch(() => {});
    } else {
      el.pause();
    }
  }, [activeSegment?.assetId, localTimeSec, playing]);

  const activeCueText = useMemo(() => {
    const cues = activeSegment?.cues || [];
    const ms = localTimeSec * 1000;
    const matched = cues.find((c) => ms >= c.startMs && ms <= c.endMs);
    return matched?.text || '';
  }, [activeSegment, localTimeSec]);

  if (clips.length === 0) return null;

  return (
    <div
      data-testid="multi-video-timeline"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 w-[min(920px,94vw)] rounded-xl border border-line-default bg-elevated shadow-modal overflow-hidden"
      style={{ zIndex: 'var(--z-canvas-hud)' }}
    >
      <div className="flex items-center justify-between border-b border-line-subtle px-4 py-2.5">
        <div className="flex items-center gap-2 text-xs font-semibold text-ink-primary">
          <Film className="h-4 w-4 text-node-video" />
          <span>多视频共享时间轴联动预览</span>
          <span className="tabular-metric rounded-full bg-subtle px-2 py-0.5 text-[11px] text-ink-secondary">
            共 {clips.length} 镜 · {totalDuration.toFixed(1)}s
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-ink-tertiary hover:bg-hover hover:text-ink-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-[260px_1fr]">
        {/* Active Clip Preview */}
        <div className="relative aspect-video overflow-hidden rounded-lg border border-line-subtle bg-canvas flex items-center justify-center">
          {activeSegment?.assetId ? (
            <video
              ref={videoRef}
              key={activeSegment.assetId}
              src={api.getAssetContentUrl(activeSegment.assetId, 'preview')}
              muted
              playsInline
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-1 text-xs text-ink-muted">
              <Film className="h-6 w-6 text-node-video" />
              <span>{activeSegment?.label || '视频待生成'}</span>
              <span className="tabular-metric text-[11px]">
                镜头 #{activeIndex + 1} · {localTimeSec.toFixed(1)}s
              </span>
            </div>
          )}

          {activeCueText && (
            <div
              className="absolute bottom-2 left-2 right-2 rounded px-2 py-1 text-center text-[11px] font-medium"
              style={{
                backgroundColor: 'var(--bg-modal-overlay)',
                color: 'var(--showcase-fg)',
              }}
            >
              {activeCueText}
            </div>
          )}
        </div>

        {/* Shared Controls & Track */}
        <div className="flex flex-col justify-between space-y-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const prevSeg = timelineSegments[Math.max(0, activeIndex - 1)];
                if (prevSeg) setCurrentTimeSec(prevSeg.start);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-line-default bg-surface text-ink-primary hover:bg-hover"
              title="上一镜头"
            >
              <SkipBack className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (currentTimeSec >= totalDuration) setCurrentTimeSec(0);
                setPlaying((p) => !p);
              }}
              className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
            >
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              <span>{playing ? '暂停' : '联动播放'}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const nextSeg =
                  timelineSegments[Math.min(timelineSegments.length - 1, activeIndex + 1)];
                if (nextSeg) setCurrentTimeSec(nextSeg.start);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-line-default bg-surface text-ink-primary hover:bg-hover"
              title="下一镜头"
            >
              <SkipForward className="h-3.5 w-3.5" />
            </button>
            <span className="ml-auto tabular-metric text-xs font-medium text-ink-secondary">
              {currentTimeSec.toFixed(1)}s / {totalDuration.toFixed(1)}s
            </span>
          </div>

          <input
            type="range"
            min={0}
            max={totalDuration}
            step={0.1}
            value={currentTimeSec}
            onChange={(e) => setCurrentTimeSec(Number(e.target.value))}
            className="w-full accent-ai"
            aria-label="共享时间轴进度"
          />

          {/* Multi-clip Track */}
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {timelineSegments.map((seg, idx) => {
              const isCurrent = idx === activeIndex;
              const widthPct = Math.max(15, (seg.durationSeconds / Math.max(1, totalDuration)) * 100);
              return (
                <button
                  key={seg.nodeId}
                  type="button"
                  onClick={() => setCurrentTimeSec(seg.start)}
                  style={{ flexBasis: `${widthPct}%` }}
                  className={`min-w-[96px] rounded-md border px-2.5 py-2 text-left transition-colors ${
                    isCurrent
                      ? 'border-ai bg-ai-soft text-ink-primary'
                      : 'border-line-subtle bg-surface text-ink-secondary hover:bg-hover'
                  }`}
                >
                  <div className="truncate text-[11px] font-semibold">
                    #{idx + 1} {seg.label}
                  </div>
                  <div className="tabular-metric text-[10px] text-ink-muted">
                    {seg.start.toFixed(0)}s - {seg.end.toFixed(0)}s ({seg.durationSeconds}s)
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
