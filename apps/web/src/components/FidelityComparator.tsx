import React, { useState } from 'react';
import { Eye, Lock, MoveHorizontal, ZoomIn } from 'lucide-react';

interface FidelityComparatorProps {
  originalUrl: string;
  generatedUrl: string;
  preserveSubjectLocked?: boolean;
  originalLabel?: string;
  generatedLabel?: string;
}

export const FidelityComparator: React.FC<FidelityComparatorProps> = ({
  originalUrl,
  generatedUrl,
  preserveSubjectLocked = true,
  originalLabel = '商品原图',
  generatedLabel = '生成成品',
}) => {
  const [mode, setMode] = useState<'split' | 'overlay'>('split');
  const [splitPct, setSplitPct] = useState(50);
  const [opacityPct, setOpacityPct] = useState(45);
  const [zoom, setZoom] = useState<1 | 2 | 4>(1);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded-md bg-subtle p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setMode('split')}
            className={`inline-flex items-center gap-1 rounded-sm px-2.5 py-1 font-medium ${
              mode === 'split'
                ? 'bg-surface text-ink-primary shadow-xs'
                : 'text-ink-secondary hover:text-ink-primary'
            }`}
          >
            <MoveHorizontal className="h-3.5 w-3.5" />
            <span>左右卷帘对比</span>
          </button>
          <button
            type="button"
            onClick={() => setMode('overlay')}
            className={`inline-flex items-center gap-1 rounded-sm px-2.5 py-1 font-medium ${
              mode === 'overlay'
                ? 'bg-surface text-ink-primary shadow-xs'
                : 'text-ink-secondary hover:text-ink-primary'
            }`}
          >
            <Eye className="h-3.5 w-3.5" />
            <span>透明度叠加透视</span>
          </button>
        </div>

        <div className="flex items-center gap-1.5 text-xs">
          <ZoomIn className="h-3.5 w-3.5 text-ink-tertiary" />
          {([1, 2, 4] as const).map((z) => (
            <button
              key={z}
              type="button"
              onClick={() => setZoom(z)}
              className={`tabular-metric rounded-sm px-2 py-0.5 font-medium ${
                zoom === z
                  ? 'bg-ai-soft text-ai font-semibold'
                  : 'bg-subtle text-ink-secondary hover:bg-hover'
              }`}
            >
              {z}x
            </button>
          ))}
        </div>
      </div>

      {/* Checkerboard Stage (independent of light/dark shell theme) */}
      <div className="relative mx-auto aspect-square w-full max-w-[460px] overflow-hidden rounded-xl border border-line-default checkerboard-bg">
        <div
          className="relative h-full w-full transition-transform duration-150"
          style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
        >
          {/* Generated Image Base */}
          <img
            src={generatedUrl}
            alt={generatedLabel}
            className="h-full w-full object-contain select-none"
          />

          {mode === 'split' ? (
            <>
              <div
                className="absolute inset-0 overflow-hidden"
                style={{ clipPath: `inset(0 ${100 - splitPct}% 0 0)` }}
              >
                <img
                  src={originalUrl}
                  alt={originalLabel}
                  className="h-full w-full object-contain select-none"
                />
              </div>
              <div
                className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-ai"
                style={{ left: `${splitPct}%` }}
              >
                <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-full border-2 border-ai bg-elevated text-ai shadow-popover">
                  <MoveHorizontal className="h-4 w-4" />
                </div>
              </div>
            </>
          ) : (
            <img
              src={originalUrl}
              alt={originalLabel}
              className="pointer-events-none absolute inset-0 h-full w-full object-contain select-none"
              style={{ opacity: opacityPct / 100 }}
            />
          )}
        </div>

        {/* Corner Labels */}
        <span
          className="absolute left-2 top-2 rounded-xs px-2 py-0.5 text-[11px] font-medium"
          style={{ backgroundColor: 'var(--bg-modal-overlay)', color: 'var(--showcase-fg)' }}
        >
          {originalLabel}
        </span>
        <span
          className="absolute right-2 top-2 rounded-xs px-2 py-0.5 text-[11px] font-medium"
          style={{ backgroundColor: 'var(--bg-modal-overlay)', color: 'var(--showcase-fg)' }}
        >
          {generatedLabel}
        </span>
      </div>

      {/* Control Slider */}
      {mode === 'split' ? (
        <label className="flex items-center gap-3 text-xs text-ink-secondary">
          <span className="shrink-0">卷帘位置</span>
          <input
            type="range"
            min={0}
            max={100}
            value={splitPct}
            onChange={(e) => setSplitPct(Number(e.target.value))}
            className="flex-1 accent-ai"
          />
          <span className="tabular-metric w-9 text-right">{splitPct}%</span>
        </label>
      ) : (
        <label className="flex items-center gap-3 text-xs text-ink-secondary">
          <span className="shrink-0">原图透明度</span>
          <input
            type="range"
            min={0}
            max={100}
            value={opacityPct}
            onChange={(e) => setOpacityPct(Number(e.target.value))}
            className="flex-1 accent-ai"
          />
          <span className="tabular-metric w-9 text-right">{opacityPct}%</span>
        </label>
      )}

      {preserveSubjectLocked && (
        <div className="inline-flex items-center gap-1.5 rounded-full bg-status-success-bg px-3 py-1 text-xs font-semibold text-status-success-fg">
          <Lock className="h-3.5 w-3.5" />
          <span>主体轮廓与 Logo 像素保真锁定已开启</span>
        </div>
      )}
    </div>
  );
};
