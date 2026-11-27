import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Download,
  Expand,
  Film,
  Image as ImageIcon,
  Layers,
  Maximize2,
  Paintbrush,
  Sparkles,
  Upload,
  Zap,
} from 'lucide-react';
import { api, generateIdempotencyKey, isApiClientError } from '../../api/client';
import type { Asset, GenerationMode, Job, Quote } from '../../api/types';
import { FidelityComparator } from '../../components/FidelityComparator';
import { MaskBrushEditor } from '../../components/MaskBrushEditor';
import { useApp } from '../../state/AppContext';

const QUICK_SKILLS = [
  {
    tag: '/电商主图',
    mode: 'product_scene' as GenerationMode,
    prompt: '高级商业棚拍主图，柔光箱打光，干净立体阴影，主体锐利清晰',
    ratio: '1:1',
  },
  {
    tag: '/商品视频',
    mode: 'image_to_video' as GenerationMode,
    prompt: '缓慢推近环绕商品镜头，光影自然流转，细节稳定不闪烁',
    ratio: '9:16',
  },
  {
    tag: '/局部改图',
    mode: 'image_edit' as GenerationMode,
    prompt: '仅替换涂抹区域背景为暖阳木桌，保持非涂抹区域像素完全不变',
    ratio: '1:1',
  },
  {
    tag: '/角色三视图',
    mode: 'text_to_image' as GenerationMode,
    prompt: '国风潮玩 IP 角色三视图设定图，正面侧面背面完整展示，统一光影与配色，纯色背景',
    ratio: '16:9',
  },
];

interface StudioLocationState {
  prefillPrompt?: string;
  prefillMode?: GenerationMode;
  prefillRatio?: string;
  templateId?: string;
}

export const StudioPage: React.FC = () => {
  const {
    session,
    models,
    projects,
    activeProjectId,
    jobs,
    openLoginModal,
    refreshProjects,
    refreshBillingState,
    upsertJob,
    pushToast,
    handleApiError,
  } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const locState = (location.state || {}) as StudioLocationState;

  const [mode, setMode] = useState<GenerationMode>(locState.prefillMode || 'text_to_image');
  const [prompt, setPrompt] = useState(locState.prefillPrompt || '');
  const [aspectRatio, setAspectRatio] = useState(locState.prefillRatio || '1:1');
  const [resolution, setResolution] = useState('1k');
  const [count, setCount] = useState(1);
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [nativeAudio, setNativeAudio] = useState(false);
  const [modelId, setModelId] = useState('');
  const [refAssets, setRefAssets] = useState<Asset[]>([]);
  const [lastFrameAsset, setLastFrameAsset] = useState<Asset | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [blockedWarning, setBlockedWarning] = useState<string | null>(null);

  // In-place post-processing inspector (repaint / outpaint / upscale / compare)
  const [inspectJob, setInspectJob] = useState<Job | null>(null);
  const [repaintPrompt, setRepaintPrompt] = useState('');
  const [showInpaintBrush, setShowInpaintBrush] = useState(false);

  const projectId = activeProjectId || projects[0]?.id || '';

  const compatibleModels = useMemo(() => {
    const list = models.filter((m) => m.modes.includes(mode));
    return list.length > 0 ? list : models;
  }, [models, mode]);

  const selectedModel = useMemo(
    () => compatibleModels.find((m) => m.id === modelId) || compatibleModels[0] || null,
    [compatibleModels, modelId]
  );

  useEffect(() => {
    if (selectedModel && selectedModel.id !== modelId) {
      setModelId(selectedModel.id);
    }
  }, [selectedModel, modelId]);

  const ensureProject = async (): Promise<string | null> => {
    if (!session) {
      openLoginModal();
      return null;
    }
    if (projectId) return projectId;
    try {
      const created = await api.createProject({ name: '快捷创作项目', industry: 'general' });
      await refreshProjects();
      return created.id;
    } catch (err) {
      handleApiError(err);
      return null;
    }
  };

  const handleUploadReference = async (
    e: React.ChangeEvent<HTMLInputElement>,
    isLastFrame = false
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const pid = await ensureProject();
    if (!pid) return;
    try {
      const asset = await api.uploadAsset(pid, file, {
        assetRole: 'reference',
        idempotencyKey: generateIdempotencyKey('studio-ref'),
      });
      if (isLastFrame) {
        setLastFrameAsset(asset);
      } else {
        setRefAssets((prev) => [...prev.slice(0, 3), asset]);
      }
      setQuote(null);
    } catch (err) {
      handleApiError(err);
    } finally {
      e.target.value = '';
    }
  };

  const buildInput = () => {
    const isVideo = mode === 'text_to_video' || mode === 'image_to_video';
    return {
      mode,
      modelId: selectedModel?.id || (isVideo ? 'studio-video' : 'studio-image'),
      prompt: prompt.trim(),
      inputAssetIds: refAssets.map((a) => a.id),
      templateId: locState.templateId,
      parameters: {
        aspectRatio,
        resolution,
        durationSeconds: isVideo ? durationSeconds : undefined,
        nativeAudio: isVideo ? nativeAudio : undefined,
        lastFrameAssetId: isVideo && lastFrameAsset ? lastFrameAsset.id : undefined,
      },
    };
  };

  const handleQuoteAndSubmit = async (submitImmediately: boolean) => {
    if (!session) {
      openLoginModal(() => void handleQuoteAndSubmit(submitImmediately));
      return;
    }
    if (!prompt.trim()) {
      pushToast({ tone: 'warning', title: '请输入创作提示词' });
      return;
    }
    const pid = await ensureProject();
    if (!pid) return;

    setBlockedWarning(null);
    setSubmitting(true);
    try {
      const input = buildInput();
      if (count > 1 && mode !== 'text_to_video' && mode !== 'image_to_video') {
        const bq = await api.quoteBatch(pid, {
          input,
          variants: [{ aspectRatio, quantity: count }],
        });
        if (!submitImmediately) {
          setQuote({
            id: bq.id,
            projectId: pid,
            credits: bq.totalCredits,
            pricingVersion: 'batch',
            expiresAt: bq.expiresAt,
            mode,
            modelId: input.modelId,
          });
          return;
        }
        const batch = await api.submitBatch(pid, { quoteId: bq.id });
        void refreshBillingState();
        pushToast({
          tone: 'success',
          title: `已提交 ${batch.jobIds.length} 张候选图生成`,
          description: `预占 ${bq.totalCredits} 积分`,
        });
      } else {
        const q = await api.quoteGeneration(pid, input);
        setQuote(q);
        if (!submitImmediately) return;
        const job = await api.submitJob(pid, { quoteId: q.id });
        upsertJob(job);
        void refreshBillingState();
        pushToast({
          tone: 'success',
          title: '创作任务已入队',
          description: `已预占 ${q.credits} 积分，您可以继续输入下一条创意`,
        });
      }
    } catch (err) {
      if (isApiClientError(err) && err.status === 422 && err.code === 'CONTENT_BLOCKED') {
        setBlockedWarning(
          `前置内容安全拦截（未扣除任何积分）：${err.message}。您的提示词与参考图已保留，修改后可直接重试。`
        );
      } else {
        // Note: on 409 INSUFFICIENT_CREDITS, prompt and refAssets are NEVER cleared!
        handleApiError(err, {
          contextLabel: '快捷创作区生成',
          onResume: () => void handleQuoteAndSubmit(true),
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Post-process: Inpaint Repaint / Outpaint / Upscale
  const handlePostEdit = async (
    editMode: 'image_edit' | 'outpaint' | 'upscale',
    sourceAssetId: string,
    maskBlob?: Blob
  ) => {
    const pid = await ensureProject();
    if (!pid) return;
    try {
      let maskAssetId: string | undefined;
      if (maskBlob) {
        const uploadedMask = await api.uploadAsset(pid, maskBlob, {
          fileName: `inpaint-mask-${Date.now()}.png`,
          assetRole: 'mask',
        });
        maskAssetId = uploadedMask.id;
      }
      const q = await api.quoteGeneration(pid, {
        mode: editMode,
        modelId: models.find((m) => m.modes.includes(editMode))?.id || 'studio-image',
        prompt: repaintPrompt.trim() || prompt.trim() || '智能精修增强细节',
        inputAssetIds: [sourceAssetId],
        parameters: {
          aspectRatio,
          maskAssetId,
          editAction: editMode === 'image_edit' ? 'repaint' : undefined,
          upscaleFactor: editMode === 'upscale' ? 2 : undefined,
          expand:
            editMode === 'outpaint' ? { left: 128, right: 128, top: 64, bottom: 64 } : undefined,
        },
      });
      const job = await api.submitJob(pid, { quoteId: q.id });
      upsertJob(job);
      setShowInpaintBrush(false);
      void refreshBillingState();
      pushToast({ tone: 'success', title: `${editMode} 精修任务已入队（预占 ${q.credits} 积分）` });
    } catch (err) {
      handleApiError(err);
    }
  };

  // 1-Click Send to Infinite Canvas preserving complete recipe metadata
  const handleSendJobToCanvas = async (job: Job) => {
    const pid = await ensureProject();
    if (!pid) return;
    const assetId = job.outputAssetIds[0];
    try {
      const created = await api.createCanvas(pid, {
        name: `快捷创作流转 · ${job.input.mode}`,
      });
      await api.saveCanvas(created.summary.id, {
        baseRevision: created.summary.revision,
        name: created.summary.name,
        graph: {
          schemaVersion: 1,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            {
              id: 'n-studio-prompt',
              type: 'text',
              label: '原创作提示词',
              text: job.input.prompt,
              position: { x: 80, y: 120 },
            },
            {
              id: 'n-studio-result',
              type: 'generation',
              mode: job.input.mode,
              label: `成品快照 (${job.input.modelId})`,
              jobId: job.id,
              assetId,
              position: { x: 420, y: 120 },
              config: {
                modelId: job.input.modelId,
                prompt: job.input.prompt,
                parameters: job.input.parameters,
              },
            },
          ],
          edges: [
            {
              id: 'e-studio-1',
              source: 'n-studio-prompt',
              target: 'n-studio-result',
              role: 'prompt',
            },
          ],
        },
      });
      pushToast({ tone: 'success', title: '已携带完整生成配方送入无限画布' });
      navigate(`/canvases/${created.summary.id}`);
    } catch (err) {
      handleApiError(err);
    }
  };

  const isVideoMode = mode === 'text_to_video' || mode === 'image_to_video';
  const studioJobs = jobs.filter((j) => !j.canvasId).slice(0, 12);

  return (
    <div className="mx-auto max-w-[1160px] p-6 space-y-6">
      {/* Hero Prompt Dock */}
      <div className="space-y-3">
        <h1 className="text-center text-2xl font-semibold text-ink-primary">
          你好，今天想要创作什么？
        </h1>

        <div className="rounded-xl border border-line-default bg-surface p-4 shadow-card space-y-3">
          {/* Modality Switcher */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1 rounded-lg bg-subtle p-1 text-xs">
              {(
                [
                  { id: 'text_to_image', label: '文生图' },
                  { id: 'image_to_image', label: '图生图' },
                  { id: 'product_scene', label: '电商换景' },
                  { id: 'text_to_video', label: '文生视频' },
                  { id: 'image_to_video', label: '图生视频' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setMode(m.id);
                    setQuote(null);
                  }}
                  className={`rounded-md px-3 py-1 font-medium ${
                    mode === m.id
                      ? 'bg-surface font-semibold text-ink-primary shadow-xs'
                      : 'text-ink-secondary hover:text-ink-primary'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {/* Quick Skill Pills */}
            <div className="flex flex-wrap gap-1.5">
              {QUICK_SKILLS.map((sk) => (
                <button
                  key={sk.tag}
                  type="button"
                  onClick={() => {
                    setMode(sk.mode);
                    setPrompt(sk.prompt);
                    setAspectRatio(sk.ratio);
                    setQuote(null);
                  }}
                  className="rounded-full border border-line-subtle bg-muted px-2.5 py-1 text-[11px] font-medium text-ink-secondary hover:border-ai hover:text-ai"
                >
                  {sk.tag}
                </button>
              ))}
            </div>
          </div>

          {/* Prompt Textarea */}
          <textarea
            data-testid="studio-prompt-input"
            rows={3}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              setBlockedWarning(null);
              setQuote(null);
            }}
            placeholder="描述您想要的画面主体、材质光影、构图景别或运镜方式，或点击上方快捷技能标签..."
            className={`w-full resize-none rounded-lg border bg-muted p-3 text-sm text-ink-primary outline-none focus:border-line-focus ${
              blockedWarning ? 'border-status-failed-fg' : 'border-line-subtle'
            }`}
          />

          {blockedWarning && (
            <div className="flex items-start gap-2 rounded-md border border-status-compliance-border bg-status-compliance-bg px-3 py-2 text-xs text-status-compliance-fg">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{blockedWarning}</span>
            </div>
          )}

          {/* Reference Images & Optional Last Frame */}
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-line-default bg-subtle px-2.5 py-1.5 text-xs text-ink-secondary hover:border-ai hover:text-ink-primary">
              <Upload className="h-3.5 w-3.5" />
              <span>{isVideoMode ? '上传首帧参考图' : '添加参考图 (最多4张)'}</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => void handleUploadReference(e, false)}
                className="hidden"
              />
            </label>

            {isVideoMode && selectedModel?.supportsLastFrame && (
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-line-default bg-subtle px-2.5 py-1.5 text-xs text-ink-secondary hover:border-ai hover:text-ink-primary">
                <Film className="h-3.5 w-3.5" />
                <span>{lastFrameAsset ? `尾帧: ${lastFrameAsset.name}` : '可选：上传尾帧'}</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => void handleUploadReference(e, true)}
                  className="hidden"
                />
              </label>
            )}

            {refAssets.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-1.5 rounded-md border border-line-subtle bg-muted px-2 py-1 text-xs"
              >
                <img
                  src={api.getAssetContentUrl(a.id, 'preview')}
                  alt={a.name}
                  className="h-5 w-5 rounded object-cover"
                />
                <span className="max-w-[96px] truncate">{a.name}</span>
                <button
                  type="button"
                  onClick={() => setRefAssets((prev) => prev.filter((x) => x.id !== a.id))}
                  className="text-ink-muted hover:text-ink-primary"
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {/* Bottom Controls Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-subtle pt-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <select
                aria-label="选择模型"
                value={selectedModel?.id || ''}
                onChange={(e) => {
                  setModelId(e.target.value);
                  setQuote(null);
                }}
                className="h-8 rounded-md border border-line-default bg-surface px-2.5 text-xs text-ink-primary"
              >
                {compatibleModels.length === 0 ? (
                  <option value="studio-image">默认模型</option>
                ) : (
                  compatibleModels.map((m) => (
                    <option key={m.id} value={m.id} disabled={m.availability === 'unconfigured'}>
                      {m.label}
                      {m.availability === 'unconfigured' ? ' [维护中]' : ''}
                      {m.execution === 'demo' ? ' (Demo)' : ''}
                    </option>
                  ))
                )}
              </select>

              <select
                aria-label="选择画面比例"
                value={aspectRatio}
                onChange={(e) => {
                  setAspectRatio(e.target.value);
                  setQuote(null);
                }}
                className="h-8 rounded-md border border-line-default bg-surface px-2 text-xs tabular-metric text-ink-primary"
              >
                {(selectedModel?.aspectRatios?.length
                  ? selectedModel.aspectRatios
                  : ['1:1', '3:4', '4:3', '9:16', '16:9']
                ).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>

              {!isVideoMode ? (
                <>
                  <select
                    aria-label="分辨率"
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                    className="h-8 rounded-md border border-line-default bg-surface px-2 text-xs text-ink-primary"
                  >
                    <option value="1k">1K 高清</option>
                    <option value="2k">2K 超清</option>
                  </select>
                  <select
                    aria-label="输出张数"
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                    className="h-8 rounded-md border border-line-default bg-surface px-2 text-xs tabular-metric text-ink-primary"
                  >
                    <option value={1}>1 张</option>
                    <option value={2}>2 张</option>
                    <option value={4}>4 张</option>
                  </select>
                </>
              ) : (
                <>
                  <select
                    aria-label="视频时长"
                    value={durationSeconds}
                    onChange={(e) => setDurationSeconds(Number(e.target.value))}
                    className="h-8 rounded-md border border-line-default bg-surface px-2 text-xs tabular-metric text-ink-primary"
                  >
                    <option value={5}>5 秒</option>
                    <option value={10}>10 秒</option>
                  </select>
                  <label className="flex items-center gap-1 text-xs text-ink-secondary cursor-pointer">
                    <input
                      type="checkbox"
                      checked={nativeAudio}
                      onChange={(e) => setNativeAudio(e.target.checked)}
                      className="accent-ai"
                    />
                    原生音轨
                  </label>
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleQuoteAndSubmit(false)}
                className="inline-flex h-9 items-center gap-1 rounded-md border border-line-default bg-surface px-3 text-xs font-medium text-ink-primary hover:bg-hover"
              >
                <Zap className="h-3.5 w-3.5 text-ai" />
                <span className="tabular-metric">
                  {quote ? `预估 ${quote.credits} 积分` : '预估积分'}
                </span>
              </button>
              <button
                type="button"
                data-testid="studio-submit-btn"
                disabled={submitting}
                onClick={() => void handleQuoteAndSubmit(true)}
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>{submitting ? '提交中...' : '立即生成'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Generation Feed */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-ink-primary">当前会话生成流 ({studioJobs.length})</h2>
        {studioJobs.length === 0 ? (
          <div className="rounded-xl border border-line-subtle bg-surface p-10 text-center space-y-2">
            <ImageIcon className="mx-auto h-9 w-9 text-ink-muted opacity-50" />
            <div className="text-sm font-medium text-ink-primary">暂无快捷生成记录</div>
            <p className="text-xs text-ink-tertiary">
              点击上方快捷技能标签填入推荐提示词，或输入自定义指令立即出片。
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {studioJobs.map((job) => {
              const outId = job.outputAssetIds[0];
              const isVid =
                job.input.mode === 'text_to_video' || job.input.mode === 'image_to_video';
              return (
                <div
                  key={job.id}
                  className="overflow-hidden rounded-xl border border-line-subtle bg-surface shadow-xs flex flex-col"
                >
                  <div className="relative aspect-square bg-subtle flex items-center justify-center overflow-hidden">
                    {outId ? (
                      isVid ? (
                        <video
                          src={api.getAssetContentUrl(outId, 'preview')}
                          controls
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <img
                          src={api.getAssetContentUrl(outId, 'preview')}
                          alt={job.input.prompt}
                          className="h-full w-full object-cover"
                        />
                      )
                    ) : (
                      <div className="text-xs text-ink-muted">
                        {job.status === 'failed'
                          ? `失败 (${job.errorCode || 'ERR'}) · 已退分`
                          : `状态：${job.status}...`}
                      </div>
                    )}
                  </div>
                  <div className="p-3 space-y-2 flex-1 flex flex-col justify-between">
                    <div className="text-xs text-ink-secondary line-clamp-2">{job.input.prompt}</div>
                    {outId && (
                      <div className="flex flex-wrap gap-1.5 pt-1 text-[11px]">
                        {!isVid && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setInspectJob(job);
                                setShowInpaintBrush(true);
                              }}
                              className="inline-flex items-center gap-1 rounded bg-subtle px-2 py-1 text-ink-primary hover:bg-hover"
                            >
                              <Paintbrush className="h-3 w-3" />
                              局部涂抹
                            </button>
                            <button
                              type="button"
                              onClick={() => void handlePostEdit('outpaint', outId)}
                              className="inline-flex items-center gap-1 rounded bg-subtle px-2 py-1 text-ink-primary hover:bg-hover"
                            >
                              <Expand className="h-3 w-3" />
                              扩图
                            </button>
                            <button
                              type="button"
                              onClick={() => void handlePostEdit('upscale', outId)}
                              className="inline-flex items-center gap-1 rounded bg-subtle px-2 py-1 text-ink-primary hover:bg-hover"
                            >
                              <Maximize2 className="h-3 w-3" />
                              超分
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleSendJobToCanvas(job)}
                          className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 font-semibold text-primary-foreground hover:bg-primary-hover"
                        >
                          <Layers className="h-3 w-3" />
                          送入无限画布
                        </button>
                        <a
                          href={api.getAssetContentUrl(outId, 'download')}
                          download
                          className="ml-auto inline-flex items-center gap-1 rounded border border-line-subtle px-2 py-1 text-ink-secondary hover:bg-hover"
                        >
                          <Download className="h-3 w-3" />
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Inpaint / Compare Modal */}
      {inspectJob && inspectJob.outputAssetIds[0] && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          style={{ backgroundColor: 'var(--bg-modal-overlay)', zIndex: 'var(--z-modal)' }}
          onClick={() => setInspectJob(null)}
        >
          <div
            className="w-full max-w-[600px] max-h-[90vh] overflow-y-auto rounded-modal border border-line-default bg-elevated p-5 shadow-modal space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowInpaintBrush(true)}
                  className={`rounded-md px-3 py-1 text-xs font-semibold ${
                    showInpaintBrush ? 'bg-primary text-primary-foreground' : 'bg-subtle text-ink-secondary'
                  }`}
                >
                  局部涂抹重绘
                </button>
                {inspectJob.input.inputAssetIds[0] && (
                  <button
                    type="button"
                    onClick={() => setShowInpaintBrush(false)}
                    className={`rounded-md px-3 py-1 text-xs font-semibold ${
                      !showInpaintBrush ? 'bg-primary text-primary-foreground' : 'bg-subtle text-ink-secondary'
                    }`}
                  >
                    原图对比
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => setInspectJob(null)}
                className="text-xs text-ink-tertiary hover:text-ink-primary"
              >
                关闭
              </button>
            </div>

            {showInpaintBrush ? (
              <div className="space-y-3">
                <input
                  type="text"
                  value={repaintPrompt}
                  onChange={(e) => setRepaintPrompt(e.target.value)}
                  placeholder="输入局部涂抹区域修改指令（非涂抹区保持不变）..."
                  className="h-9 w-full rounded-md border border-line-default bg-surface px-3 text-xs text-ink-primary"
                />
                <MaskBrushEditor
                  imageUrl={api.getAssetContentUrl(inspectJob.outputAssetIds[0], 'preview')}
                  saveLabel="提交局部涂抹重绘"
                  onSaveMask={(blob) =>
                    handlePostEdit('image_edit', inspectJob.outputAssetIds[0], blob)
                  }
                />
              </div>
            ) : (
              inspectJob.input.inputAssetIds[0] && (
                <FidelityComparator
                  originalUrl={api.getAssetContentUrl(inspectJob.input.inputAssetIds[0], 'preview')}
                  generatedUrl={api.getAssetContentUrl(inspectJob.outputAssetIds[0], 'preview')}
                />
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
};
