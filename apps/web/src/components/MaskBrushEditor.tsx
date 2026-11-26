import React, { useEffect, useRef, useState } from 'react';
import { Brush, Check, Eraser, RotateCcw, Sparkles } from 'lucide-react';

interface MaskBrushEditorProps {
  imageUrl: string;
  onSaveMask: (blob: Blob) => Promise<void> | void;
  saving?: boolean;
  saveLabel?: string;
}

export const MaskBrushEditor: React.FC<MaskBrushEditorProps> = ({
  imageUrl,
  onSaveMask,
  saving = false,
  saveLabel = '保存蒙版（0 积分）',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [tool, setTool] = useState<'keep' | 'erase'>('keep');
  const [brushSize, setBrushSize] = useState(24);
  const [bgMode, setBgMode] = useState<'checker' | 'dark' | 'light'>('checker');
  const drawingRef = useRef(false);
  const hasStrokesRef = useRef(false);

  const resetCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasStrokesRef.current = false;
  };

  useEffect(() => {
    resetCanvas();
  }, [imageUrl]);

  const getCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
      y: ((e.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
    };
  };

  const drawDot = (x: number, y: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    hasStrokesRef.current = true;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const rootStyles = getComputedStyle(document.documentElement);
    const keepColor = rootStyles.getPropertyValue('--mask-keep-stroke').trim() || 'currentColor';
    const eraseColor = rootStyles.getPropertyValue('--mask-erase-stroke').trim() || 'currentColor';
    ctx.fillStyle = tool === 'keep' ? keepColor : eraseColor;
    ctx.beginPath();
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = getCoords(e);
    drawDot(x, y);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const { x, y } = getCoords(e);
    drawDot(x, y);
  };

  const handlePointerUp = () => {
    drawingRef.current = false;
  };

  const handleExport = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob(
      (blob) => {
        if (blob) {
          void onSaveMask(blob);
        }
      },
      'image/png'
    );
  };

  const bgStyle: React.CSSProperties =
    bgMode === 'dark'
      ? { backgroundColor: 'var(--preview-solid-dark)' }
      : bgMode === 'light'
        ? { backgroundColor: 'var(--preview-solid-light)' }
        : {};

  return (
    <div className="space-y-3">
      {/* Floating Brush Pill Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-full border border-line-subtle bg-elevated px-3 py-1.5 shadow-xs">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setTool('keep')}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
              tool === 'keep'
                ? 'bg-status-success-bg text-status-success-fg'
                : 'text-ink-secondary hover:bg-hover'
            }`}
          >
            <Brush className="h-3.5 w-3.5" />
            <span>保留画笔</span>
          </button>
          <button
            type="button"
            onClick={() => setTool('erase')}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
              tool === 'erase'
                ? 'bg-status-failed-bg text-status-failed-fg'
                : 'text-ink-secondary hover:bg-hover'
            }`}
          >
            <Eraser className="h-3.5 w-3.5" />
            <span>擦除画笔</span>
          </button>

          <label className="ml-2 flex items-center gap-1.5 text-[11px] text-ink-tertiary">
            <span>笔刷</span>
            <input
              type="range"
              min={8}
              max={64}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              className="w-20 accent-ai"
            />
            <span className="tabular-metric w-7">{brushSize}px</span>
          </label>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="flex rounded-full bg-subtle p-0.5 text-[11px]">
            {(
              [
                { id: 'checker', label: '棋盘格' },
                { id: 'dark', label: '纯黑' },
                { id: 'light', label: '纯白' },
              ] as const
            ).map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setBgMode(b.id)}
                className={`rounded-full px-2 py-0.5 ${
                  bgMode === b.id
                    ? 'bg-surface font-semibold text-ink-primary shadow-xs'
                    : 'text-ink-tertiary'
                }`}
              >
                {b.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={resetCanvas}
            title="重置笔触"
            className="rounded-full p-1.5 text-ink-tertiary hover:bg-hover hover:text-ink-primary"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>

          <span className="inline-flex items-center gap-1 rounded-full bg-status-success-bg px-2.5 py-0.5 text-[11px] font-semibold text-status-success-fg">
            <Sparkles className="h-3 w-3" />
            画笔微调 0 积分
          </span>
        </div>
      </div>

      {/* Interactive Canvas 2D Mask Stage */}
      <div
        className={`relative mx-auto aspect-square w-full max-w-[420px] overflow-hidden rounded-xl border border-line-default ${
          bgMode === 'checker' ? 'checkerboard-bg' : ''
        }`}
        style={bgStyle}
      >
        <img
          src={imageUrl}
          alt="待微调商品图"
          className="pointer-events-none h-full w-full object-contain select-none"
        />
        <canvas
          ref={canvasRef}
          width={512}
          height={512}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
        />
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          disabled={saving}
          onClick={handleExport}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" />
          <span>{saving ? '正在保存蒙版资产...' : saveLabel}</span>
        </button>
      </div>
    </div>
  );
};
