import React, { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  AlertTriangle,
  Film,
  Image as ImageIcon,
  Layers,
  Lock,
  Mic,
  Play,
  ShieldCheck,
  Sparkles,
  StickyNote,
  Type,
  Wand2,
  Zap,
} from 'lucide-react';
import { api } from '../../api/client';
import type { GenerationMode, GraphNode, Job } from '../../api/types';
import { estimateNodeCredits } from '../../lib/graphUtils';

export interface CanvasNodeData extends Record<string, unknown> {
  graphNode: GraphNode;
  job?: Job;
  stale?: boolean;
  readOnly?: boolean;
  lodMinimal?: boolean;
  audioStudioEnabled?: boolean;
  onRunNode?: (nodeId: string) => void;
  onUpdateNode?: (nodeId: string, patch: Partial<GraphNode>) => void;
}

const MODE_LABELS: Partial<Record<GenerationMode, string>> = {
  text_to_image: '文生图',
  image_to_image: '图生图',
  product_scene: '商品换景',
  subject_cutout: '智能抠图',
  image_edit: '局部重绘',
  outpaint: '智能扩图',
  upscale: '高清超分',
  text_to_video: '文生视频',
  image_to_video: '图生视频',
  video_compose: '视频合成',
};

function getHeaderAccent(node: GraphNode): { barVar: string; label: string; Icon: React.FC<{ className?: string }> } {
  if (node.expectedKind === 'audio') {
    return { barVar: 'var(--node-audio-p1)', label: '音频 / 配音节点', Icon: Mic };
  }
  switch (node.type) {
    case 'text':
      return { barVar: 'var(--node-prompt)', label: '提示词 / 便签', Icon: Type };
    case 'asset':
      return { barVar: 'var(--node-media)', label: '参考图 / 媒体', Icon: ImageIcon };
    case 'subject':
      return { barVar: 'var(--node-subject)', label: '商品主体档案', Icon: ShieldCheck };
    case 'frame':
      return { barVar: 'var(--border-strong)', label: '分组框 Frame', Icon: Layers };
    case 'placeholder':
      return { barVar: 'var(--node-batch)', label: '模板占位', Icon: StickyNote };
    case 'generation':
    default: {
      const isVideo =
        node.mode === 'text_to_video' ||
        node.mode === 'image_to_video' ||
        node.mode === 'video_compose';
      const isEdit =
        node.mode === 'image_edit' ||
        node.mode === 'subject_cutout' ||
        node.mode === 'outpaint' ||
        node.mode === 'upscale';
      return {
        barVar: isVideo ? 'var(--node-video)' : 'var(--node-image)',
        label: (node.mode && MODE_LABELS[node.mode]) || '多模态生成',
        Icon: isVideo ? Film : isEdit ? Wand2 : Sparkles,
      };
    }
  }
}

export const StudioCanvasNode: React.FC<NodeProps> = memo(({ data, selected }) => {
  const nodeData = data as unknown as CanvasNodeData;
  const {
    graphNode,
    job,
    stale = false,
    readOnly = false,
    lodMinimal = false,
    audioStudioEnabled = false,
    onRunNode,
    onUpdateNode,
  } = nodeData;

  const [hovered, setHovered] = useState(false);
  const isAudioPlaceholder = graphNode.expectedKind === 'audio' && !audioStudioEnabled;
  const accent = getHeaderAccent(graphNode);
  const Icon = accent.Icon;
  const estimatedCredits = estimateNodeCredits(graphNode);

  const isVideoNode =
    graphNode.expectedKind === 'video' ||
    graphNode.mode === 'text_to_video' ||
    graphNode.mode === 'image_to_video' ||
    graphNode.mode === 'video_compose';

  const displayAssetId = job?.outputAssetIds?.[0] || graphNode.assetId;

  const statusGlow =
    job?.status === 'running'
      ? 'var(--glow-node-running)'
      : job?.status === 'failed'
        ? 'var(--glow-node-failed)'
        : stale
          ? 'var(--glow-node-stale)'
          : selected
            ? 'var(--glow-node-selected)'
            : 'var(--shadow-node)';

  // Zoom < 0.40 LOD Minimal Degraded View (per DESIGN_SYSTEM.md 4.3.5)
  if (lodMinimal) {
    const statusDotColor =
      job?.status === 'running'
        ? 'var(--status-running-fg)'
        : job?.status === 'failed'
          ? 'var(--status-failed-fg)'
          : stale
            ? 'var(--status-stale-fg)'
            : job?.status === 'succeeded'
              ? 'var(--status-success-fg)'
              : 'var(--text-muted)';

    return (
      <div
        data-testid={`canvas-node-${graphNode.id}`}
        data-lod="minimal"
        className="w-[280px] overflow-hidden rounded-node border border-line-subtle bg-surface"
        style={{ boxShadow: statusGlow }}
      >
        <div className="h-1.5 w-full" style={{ backgroundColor: accent.barVar }} />
        <div className="flex items-center justify-between p-3">
          <div className="truncate text-base font-semibold text-ink-primary">
            {graphNode.label || accent.label}
          </div>
          <span
            className="h-3 w-3 shrink-0 rounded-full"
            style={{ backgroundColor: statusDotColor }}
          />
        </div>
        <div className="h-24 w-full bg-subtle flex items-center justify-center overflow-hidden">
          {displayAssetId ? (
            <img
              src={api.getAssetContentUrl(displayAssetId, 'preview')}
              alt={graphNode.label || 'preview'}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <Icon className="h-7 w-7 text-ink-muted" />
          )}
        </div>
      </div>
    );
  }

  // Frame grouping node
  if (graphNode.type === 'frame') {
    return (
      <div
        data-testid={`canvas-node-${graphNode.id}`}
        className="h-full w-full min-h-[220px] min-w-[340px] rounded-xl border-2 border-dashed border-line-default bg-muted/40 p-3"
        style={{ boxShadow: selected ? 'var(--glow-node-selected)' : undefined }}
      >
        <div className="flex items-center gap-1.5 text-xs font-semibold text-ink-secondary">
          <Layers className="h-3.5 w-3.5" />
          <span>{graphNode.label || '分组框 Frame'}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid={`canvas-node-${graphNode.id}`}
      data-lod="full"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`relative rounded-node bg-surface text-ink-primary transition-shadow ${
        isVideoNode ? 'w-[310px]' : 'w-[280px]'
      } ${job?.status === 'running' ? 'rf-node-running' : ''} ${
        isAudioPlaceholder ? 'border-2 border-dashed border-line-default opacity-65' : 'border border-line-subtle'
      }`}
      style={{ boxShadow: statusGlow }}
    >
      {/* Input Handles */}
      {(graphNode.type === 'generation' || graphNode.type === 'placeholder') && (
        <>
          <Handle
            id="prompt"
            type="target"
            position={Position.Left}
            style={{
              top: '32%',
              width: 10,
              height: 10,
              backgroundColor: 'var(--node-prompt)',
              border: '2px solid var(--bg-surface)',
            }}
            title="文本提示词输入端口 (prompt)"
          />
          <Handle
            id={isVideoNode ? 'first_frame' : 'reference'}
            type="target"
            position={Position.Left}
            style={{
              top: '62%',
              width: 10,
              height: 10,
              backgroundColor: isVideoNode ? 'var(--node-video)' : 'var(--node-image)',
              border: '2px solid var(--bg-surface)',
            }}
            title={isVideoNode ? '首帧/参考图输入端口 (first_frame)' : '参考图/商品主体输入端口 (reference)'}
          />
        </>
      )}

      {/* Output Handle */}
      <Handle
        id="output"
        type="source"
        position={Position.Right}
        style={{
          top: '50%',
          width: 10,
          height: 10,
          backgroundColor: accent.barVar,
          border: '2px solid var(--bg-surface)',
        }}
        title="输出端口"
      />

      {/* Node Header */}
      <div className="flex h-9 items-center justify-between gap-2 border-b border-line-subtle px-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-ink-inverse"
            style={{ backgroundColor: accent.barVar }}
          >
            <Icon className="h-3 w-3" />
          </span>
          <span className="truncate text-xs font-semibold text-ink-primary">
            {graphNode.label || accent.label}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {graphNode.type === 'subject' && (
            <span className="inline-flex items-center gap-0.5 rounded-xs bg-status-success-bg px-1.5 py-0.5 text-[10px] font-semibold text-status-success-fg">
              <Lock className="h-2.5 w-2.5" />
              保真锁定
            </span>
          )}
          {isAudioPlaceholder && (
            <span className="rounded-xs bg-subtle px-1.5 py-0.5 text-[10px] font-semibold text-ink-tertiary">
              即将上线
            </span>
          )}
          {job?.status === 'running' && (
            <span className="rounded-xs bg-status-running-bg px-1.5 py-0.5 text-[10px] font-semibold text-status-running-fg">
              生成中
            </span>
          )}
          {job?.status === 'queued' && (
            <span className="rounded-xs bg-status-queued-bg px-1.5 py-0.5 text-[10px] font-semibold text-status-queued-fg">
              排队中
            </span>
          )}
        </div>
      </div>

      {/* Upstream Changed Stale Banner (R-CANVAS-02: never auto-charges) */}
      {stale && (
        <div
          data-testid={`node-stale-banner-${graphNode.id}`}
          className="flex items-center gap-1.5 border-b border-status-stale-border bg-status-stale-bg px-3 py-1.5 text-[11px] font-medium text-status-stale-fg"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>上游已变更（待更新）· 未自动扣费</span>
        </div>
      )}

      {/* Node Body */}
      <div className="p-3 space-y-2">
        {graphNode.type === 'text' ? (
          <textarea
            value={graphNode.text || ''}
            disabled={readOnly}
            onChange={(e) => onUpdateNode?.(graphNode.id, { text: e.target.value })}
            placeholder="输入提示词或电商卖点描述..."
            rows={3}
            className="nodrag w-full resize-none rounded-md border border-line-subtle bg-muted p-2 text-xs text-ink-primary outline-none focus:border-line-focus disabled:opacity-70"
          />
        ) : isAudioPlaceholder ? (
          <div className="rounded-md bg-subtle p-2.5 text-[11px] text-ink-tertiary leading-relaxed">
            支持带货口播配音、BGM 配乐与口型同步（P1 独立音频能力开放后启用，当前已预留标准端口位）。
          </div>
        ) : (
          <>
            {/* Media Preview (Videos render static cover when not hovered/focused to keep >=50fps at 200+ nodes) */}
            {(displayAssetId || graphNode.type === 'generation' || graphNode.type === 'asset' || graphNode.type === 'subject') && (
              <div className="relative h-32 w-full overflow-hidden rounded-md border border-line-subtle bg-subtle flex items-center justify-center">
                {displayAssetId ? (
                  isVideoNode && (hovered || selected) ? (
                    <video
                      src={api.getAssetContentUrl(displayAssetId, 'preview')}
                      autoPlay
                      loop
                      muted
                      playsInline
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <>
                      <img
                        src={api.getAssetContentUrl(displayAssetId, 'preview')}
                        alt={graphNode.label || 'media'}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                      {isVideoNode && (
                        <div className="absolute inset-0 flex items-center justify-center bg-canvas/30">
                          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-elevated/90 text-ink-primary shadow-card">
                            <Play className="h-4 w-4 ml-0.5" />
                          </span>
                        </div>
                      )}
                    </>
                  )
                ) : (
                  <div className="flex flex-col items-center gap-1 text-[11px] text-ink-muted">
                    <Icon className="h-5 w-5" />
                    <span>{graphNode.type === 'placeholder' ? '请替换为您的商品素材' : '等待生成或绑定素材'}</span>
                  </div>
                )}
              </div>
            )}

            {/* Parameter Chips for Generation Nodes */}
            {graphNode.type === 'generation' && (
              <div className="flex flex-wrap gap-1 text-[10px]">
                <span className="rounded-xs bg-subtle px-1.5 py-0.5 font-medium text-ink-secondary">
                  {graphNode.config?.modelId || 'studio-image'}
                </span>
                <span className="tabular-metric rounded-xs bg-subtle px-1.5 py-0.5 text-ink-secondary">
                  {graphNode.config?.parameters?.aspectRatio || '1:1'}
                </span>
                {isVideoNode && (
                  <span className="tabular-metric rounded-xs bg-subtle px-1.5 py-0.5 text-ink-secondary">
                    {graphNode.config?.parameters?.durationSeconds || 5}s
                  </span>
                )}
                {graphNode.config?.parameters?.nativeAudio && (
                  <span className="rounded-xs bg-ai-soft px-1.5 py-0.5 text-ai font-medium">
                    原生音轨
                  </span>
                )}
              </div>
            )}

            {/* Failure Bar with Refund Notice */}
            {job?.status === 'failed' && (
              <div className="rounded-md border border-status-failed-border bg-status-failed-bg px-2 py-1.5 text-[11px] text-status-failed-fg">
                失败 ({job.errorCode || 'ERR'}) · 已退回 {job.expectedCredits} 积分
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer for Executable Generation Nodes */}
      {graphNode.type === 'generation' && (
        <div className="flex h-9 items-center justify-between border-t border-line-subtle px-3">
          {!readOnly ? (
            <button
              type="button"
              onClick={() => onRunNode?.(graphNode.id)}
              disabled={job?.status === 'running' || job?.status === 'queued'}
              className="nodrag inline-flex items-center gap-1 rounded-sm bg-subtle px-2 py-1 text-[11px] font-medium text-ink-primary hover:bg-hover disabled:opacity-50"
            >
              <Play className="h-3 w-3 text-ai" />
              <span>{stale ? '重跑此节点' : '运行此节点'}</span>
            </button>
          ) : (
            <span className="text-[11px] text-ink-muted">只读快照</span>
          )}

          {estimatedCredits !== null && (
            <span
              data-testid={`node-credits-${graphNode.id}`}
              className="tabular-metric inline-flex items-center gap-0.5 rounded-full bg-ai-soft px-2 py-0.5 text-[11px] font-semibold text-ai"
            >
              <Zap className="h-3 w-3" />
              {estimatedCredits} 分
            </span>
          )}
        </div>
      )}
    </div>
  );
});

StudioCanvasNode.displayName = 'StudioCanvasNode';
