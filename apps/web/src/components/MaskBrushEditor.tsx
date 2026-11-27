import React, { useEffect, useRef, useState } from 'react';
import { Brush, Check, Eraser, RotateCcw, Sparkles } from 'lucide-react';

export interface MaskDimensions {
  width: number;
  height: number;
}

export const DEFAULT_MASK_DIMENSIONS: MaskDimensions = { width: 512, height: 512 };

/**
 * Pure helper: normalize source image dimensions (fallback safely when unavailable, e.g. JSDOM).
 */
export function resolveMaskDimensions(
  naturalWidth?: number,
  naturalHeight?: number
): MaskDimensions {
  const w = naturalWidth && naturalWidth > 0 ? Math.round(naturalWidth) : DEFAULT_MASK_DIMENSIONS.width;
  const h = naturalHeight && naturalHeight > 0 ? Math.round(naturalHeight) : DEFAULT_MASK_DIMENSIONS.height;
  return { width: w, height: h };
}

/**
 * Pure helper: compute CSS aspect-ratio string from natural image dimensions.
 */
export function formatAspectRatioCss(dims: MaskDimensions): string {
  return `${dims.width} / ${dims.height}`;
}

/**
 * Pure helper: convert pointer client coordinates against rendered canvas rect into exact source-image pixel coordinates.
 */
export function mapPointerToCanvasCoords(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number; scaleX: number; scaleY: number } {
  const safeRectW = Math.max(1, rect.width);
  const safeRectH = Math.max(1, rect.height);
  const scaleX = canvasWidth / safeRectW;
  const scaleY = canvasHeight / safeRectH;
  const x = (clientX - rect.left) * scaleX;
  const y = (clientY - rect.top) * scaleY;
  return { x, y, scaleX, scaleY };
}

interface MaskBrushEditorProps {
  imageUrl: string;
  initialWidth?: number;
  initialHeight?: number;
  onSaveMask: (blob: Blob, dims: MaskDimensions) => Promise<void> | void;
  saving?: boolean;
  saveLabel?: string;
}

export const MaskBrushEditor: React.FC<MaskBrushEditorProps> = ({
  imageUrl,
  initialWidth,
  initialHeight,
  onSaveMask,
  saving = false,
  saveLabel = '保存蒙版（0 积分）',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [dims, setDims] = useState<MaskDimensions>(() =>
    resolveMaskDimensions(initialWidth, initialHeight)
  );
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
    setDims(resolveMaskDimensions(initialWidth, initialHeight));
  }, [imageUrl, initialWidth, initialHeight]);

  // Clear mask whenever source image or canvas dimensions change
  useEffect(() => {
    resetCanvas();
  }, [imageUrl, dims.width, dims.height]);

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      const next = resolveMaskDimensions(img.naturalWidth, img.naturalHeight);
      setDims((prev) =>
        prev.width === next.width && prev.height === next.height ? prev : next
      );
    }
  };

  const drawAtPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const { x, y, scaleX, scaleY } = mapPointerToCanvasCoords(
      e.clientX,
      e.clientY,
      rect,
      canvas.width,
      canvas.height
    );
    hasStrokesRef.current = true;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const rootStyles = getComputedStyle(document.documentElement);
    const keepColor = rootStyles.getPropertyValue('--mask-keep-stroke').trim() || 'currentColor';
    const eraseColor = rootStyles.getPropertyValue('--mask-erase-stroke').trim() || 'currentColor';
    ctx.fillStyle = tool === 'keep' ? keepColor : eraseColor;
    const avgScale = (scaleX + scaleY) / 2;
    const radius = (brushSize * avgScale) / 2;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, radius), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawingRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore synthetic events without active pointerId
    }
    drawAtPointer(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawAtPointer(e);
  };

  const handlePointerUp = () => {
    drawingRef.current = false;
  };

  const handleExport = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const currentDims = { width: canvas.width, height: canvas.height };
    canvas.toBlob(
      (blob) => {
        if (blob) {
          void onSaveMask(blob, currentDims);
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

      {/* Adaptive-Ratio Canvas 2D Mask Stage: 1:1 pixel alignment with source image */}
      <div className="flex justify-center">
        <div
          data-testid="mask-brush-stage"
          className={`relative w-full max-w-[460px] max-h-[520px] overflow-hidden rounded-xl border border-line-default ${
            bgMode === 'checker' ? 'checkerboard-bg' : ''
          }`}
          style={{
            ...bgStyle,
            aspectRatio: formatAspectRatioCss(dims),
          }}
        >
          <img
            data-testid="mask-source-image"
            src={imageUrl}
            alt="待微调商品图"
            onLoad={handleImageLoad}
            className="pointer-events-none block h-full w-full select-none"
          />
          <canvas
            ref={canvasRef}
            data-testid="mask-brush-canvas"
            width={dims.width}
            height={dims.height}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
          />
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px] text-ink-tertiary tabular-metric">
        <span data-testid="mask-resolution-label">
          蒙版导出分辨率：{dims.width} × {dims.height} px（与原图 1:1 对齐）
        </span>
        <button
          type="button"
          disabled={saving}
          onClick={handleExport}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50 font-sans"
        >
          <Check className="h-3.5 w-3.5" />
          <span>{saving ? '正在保存蒙版资产...' : saveLabel}</span>
        </button>
      </div>
    </div>
  );
};
