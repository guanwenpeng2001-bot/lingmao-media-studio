import React from 'react';
import type { Preset } from '../api/types';

interface SafeZoneOverlayProps {
  preset?: Preset;
  aspectRatio: string;
  outputKind?: 'white_background' | 'hero' | 'detail' | 'poster' | 'scene';
  visible?: boolean;
}

export const SafeZoneOverlay: React.FC<SafeZoneOverlayProps> = ({
  preset,
  aspectRatio,
  outputKind,
  visible = true,
}) => {
  if (!visible) return null;

  // Normalize safe area insets (supports percentage 0..1 or pixel values)
  const normalizeInset = (val: number | undefined, dim: number | undefined, fallbackPct: number) => {
    if (val === undefined) return fallbackPct;
    if (val > 0 && val <= 1) return val * 100;
    if (dim && dim > 0) return Math.min(40, (val / dim) * 100);
    return fallbackPct;
  };

  const isVerticalFeed = aspectRatio === '9:16';
  const isWhiteBg = outputKind === 'white_background';

  const topPct = normalizeInset(
    preset?.safeArea?.top,
    preset?.height,
    isVerticalFeed ? 10 : isWhiteBg ? 10 : 8
  );
  const bottomPct = normalizeInset(
    preset?.safeArea?.bottom,
    preset?.height,
    isVerticalFeed ? 22 : isWhiteBg ? 10 : 8
  );
  const leftPct = normalizeInset(preset?.safeArea?.left, preset?.width, isWhiteBg ? 10 : 8);
  const rightPct = normalizeInset(preset?.safeArea?.right, preset?.width, isWhiteBg ? 10 : 8);

  return (
    <svg
      data-testid="safe-zone-overlay"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      {/* 9:16 Douyin / Feed Top & Bottom Avoidance Hazard Zones */}
      {isVerticalFeed && (
        <>
          <rect
            x={0}
            y={0}
            width={100}
            height={topPct}
            fill="var(--safezone-danger-fill)"
            stroke="var(--safezone-danger-stroke)"
            strokeWidth={0.4}
            strokeDasharray="2 1.5"
          />
          <rect
            x={0}
            y={100 - bottomPct}
            width={100}
            height={bottomPct}
            fill="var(--safezone-danger-fill)"
            stroke="var(--safezone-danger-stroke)"
            strokeWidth={0.4}
            strokeDasharray="2 1.5"
          />
          <text
            x={50}
            y={Math.max(4, topPct / 2 + 1)}
            textAnchor="middle"
            fontSize="3.4"
            fill="var(--safezone-danger-stroke)"
            fontWeight="600"
          >
            顶部状态栏避让区 ({Math.round(topPct)}%)
          </text>
          <text
            x={50}
            y={100 - bottomPct / 2 + 1}
            textAnchor="middle"
            fontSize="3.4"
            fill="var(--safezone-danger-stroke)"
            fontWeight="600"
          >
            平台遮挡避让区 ({Math.round(bottomPct)}%)
          </text>
        </>
      )}

      {/* Main Safe Composition Frame */}
      <rect
        x={leftPct}
        y={topPct}
        width={Math.max(10, 100 - leftPct - rightPct)}
        height={Math.max(10, 100 - topPct - bottomPct)}
        fill="none"
        stroke="var(--accent-ai)"
        strokeWidth={0.6}
        strokeDasharray="2.5 1.8"
      />
      <text
        x={leftPct + 2}
        y={topPct + 4.5}
        fontSize="3.2"
        fill="var(--accent-ai)"
        fontWeight="600"
      >
        {isWhiteBg ? '合规白底 10% 留白基准框' : '核心主体与卖点文字安全构图区'}
      </text>
    </svg>
  );
};
