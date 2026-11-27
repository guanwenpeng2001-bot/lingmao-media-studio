import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  formatAspectRatioCss,
  mapPointerToCanvasCoords,
  MaskBrushEditor,
  resolveMaskDimensions,
} from '../components/MaskBrushEditor';

describe('P1-4 MaskBrushEditor Adaptive Non-Square Resolution & Coordinate Mapping', () => {
  it('maps pointer coordinates accurately onto non-square 1200x1600 (3:4) source canvas with zero drift', () => {
    const dims = resolveMaskDimensions(1200, 1600);
    expect(dims).toEqual({ width: 1200, height: 1600 });
    expect(formatAspectRatioCss(dims)).toBe('1200 / 1600');

    // Suppose rendered stage is 300x400 CSS px at (50, 100)
    const rect = { left: 50, top: 100, width: 300, height: 400 };
    // Clicking bottom-right center-ish at CSS (200, 450) => 50% width, 87.5% height
    const mapped = mapPointerToCanvasCoords(200, 450, rect, 1200, 1600);
    expect(mapped.scaleX).toBe(4);
    expect(mapped.scaleY).toBe(4);
    expect(mapped.x).toBe(600);
    expect(mapped.y).toBe(1400);
  });

  it('dynamically sizes canvas & container to 1200x1600 on image load and exports mask at original resolution', () => {
    const onSaveMask = vi.fn();
    const arcSpy = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc: arcSpy,
      fill: vi.fn(),
      lineCap: 'round',
      lineJoin: 'round',
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D);

    render(
      <MaskBrushEditor
        imageUrl="/api/v1/assets/asset-tall/content?disposition=preview"
        onSaveMask={onSaveMask}
      />
    );

    const img = screen.getByTestId('mask-source-image') as HTMLImageElement;
    const canvas = screen.getByTestId('mask-brush-canvas') as HTMLCanvasElement;
    const stage = screen.getByTestId('mask-brush-stage') as HTMLDivElement;

    // Simulate non-square 1200x1600 image finishing load
    Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 1200 });
    Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 1600 });
    fireEvent.load(img);

    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(1600);
    expect(stage.style.aspectRatio).toBe('1200 / 1600');
    expect(screen.getByTestId('mask-resolution-label')).toHaveTextContent('1200 × 1600 px');

    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 300,
      height: 400,
      right: 300,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(canvas, 'toBlob').mockImplementation((cb) => {
      cb(new Blob(['fake-png'], { type: 'image/png' }));
    });

    fireEvent.pointerDown(canvas, { clientX: 150, clientY: 350 });
    expect(arcSpy).toHaveBeenCalledWith(600, 1400, 48, 0, Math.PI * 2);

    fireEvent.click(screen.getByRole('button', { name: /保存蒙版/ }));
    expect(onSaveMask).toHaveBeenCalledWith(expect.any(Blob), { width: 1200, height: 1600 });
  });
});
