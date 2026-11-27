import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Download,
  FileBadge2,
  Images,
  Lock,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../../api/client';
import type { Asset, AssetImpact, ExportLicense, MediaKind, Subject } from '../../api/types';
import { formatBytes, formatUtcDate, formatUtcDateTime } from '../../lib/creditPools';
import { useApp } from '../../state/AppContext';

type AssetTab = 'all' | 'subjects' | 'style' | 'trash';

export const AssetsPage: React.FC = () => {
  const {
    session,
    features,
    projects,
    activeProjectId,
    billingState,
    openLoginModal,
    pushToast,
    handleApiError,
  } = useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as AssetTab) || 'all';

  const [tab, setTab] = useState<AssetTab>(initialTab);
  const [projectFilter, setProjectFilter] = useState(activeProjectId || '');
  const [kindFilter, setKindFilter] = useState<MediaKind | ''>('');
  const [tagFilter, setTagFilter] = useState('');

  const [assets, setAssets] = useState<Asset[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Asset provenance & license detail drawer
  const [detailAsset, setDetailAsset] = useState<Asset | null>(null);
  const [detailLicense, setDetailLicense] = useState<ExportLicense | null>(null);
  const [loadingLicense, setLoadingLicense] = useState(false);

  // Reference impact confirmation modal before archiving
  const [impactDialog, setImpactDialog] = useState<{
    asset: Asset;
    impact: AssetImpact;
  } | null>(null);
  const [archiving, setArchiving] = useState(false);

  const loadAssets = useCallback(
    async (cursor?: string) => {
      if (!session) {
        setLoading(false);
        return;
      }
      if (!cursor) setLoading(true);
      try {
        if (tab === 'subjects') {
          const targetProject = projectFilter || projects[0]?.id;
          if (targetProject) {
            const subs = await api.listSubjects(targetProject);
            setSubjects(subs);
          } else {
            setSubjects([]);
          }
          setAssets([]);
          setNextCursor(null);
          return;
        }
        const res = await api.listAssets({
          projectId: projectFilter || undefined,
          kind: kindFilter || undefined,
          status: tab === 'trash' ? 'archived' : 'ready',
          tag: tagFilter.trim() || undefined,
          cursor,
          limit: 24,
        });
        const filtered =
          tab === 'style'
            ? res.items.filter((a) => a.assetRole === 'reference' || a.assetRole === 'scene')
            : res.items;
        setAssets((prev) => (cursor ? [...prev, ...filtered] : filtered));
        setNextCursor(res.nextCursor);
      } catch (err) {
        handleApiError(err);
      } finally {
        setLoading(false);
      }
    },
    [session, tab, projectFilter, kindFilter, tagFilter, projects, handleApiError]
  );

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  const handleOpenDetail = async (asset: Asset) => {
    setDetailAsset(asset);
    setDetailLicense(null);
    try {
      const fresh = await api.getAsset(asset.id);
      setDetailAsset(fresh);
    } catch {
      // keep summary
    }
  };

  const handleFetchLicense = async (assetId: string) => {
    setLoadingLicense(true);
    try {
      const lic = await api.getAssetLicense(assetId);
      setDetailLicense(lic);
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoadingLicense(false);
    }
  };

  // Always check GET /assets/{assetId}/impact before archiving (R-ASSET-01 / AC-11)
  const handleRequestArchive = async (asset: Asset) => {
    try {
      const impact = await api.getAssetImpact(asset.id);
      setImpactDialog({ asset, impact });
    } catch (err) {
      handleApiError(err);
    }
  };

  const handleConfirmArchive = async () => {
    if (!impactDialog) return;
    setArchiving(true);
    try {
      await api.patchAsset(impactDialog.asset.id, {
        status: 'archived',
        acknowledgeReferences: true,
      });
      setAssets((prev) => prev.filter((a) => a.id !== impactDialog.asset.id));
      if (detailAsset?.id === impactDialog.asset.id) setDetailAsset(null);
      setImpactDialog(null);
      pushToast({
        tone: 'success',
        title: '素材已移入 30 天回收站',
        description: '历史画布已生成的图片/视频成品不受影响，30 天内可随时无损恢复。',
      });
    } catch (err) {
      handleApiError(err);
    } finally {
      setArchiving(false);
    }
  };

  const handleRestoreAsset = async (asset: Asset) => {
    try {
      await api.patchAsset(asset.id, { status: 'ready' });
      setAssets((prev) => prev.filter((a) => a.id !== asset.id));
      pushToast({ tone: 'success', title: `已从回收站恢复「${asset.name}」` });
    } catch (err) {
      handleApiError(err);
    }
  };

  const ent = billingState?.entitlements;
  const usedPct =
    ent && ent.storageLimitBytes > 0
      ? Math.min(100, Math.round((ent.usedStorageBytes / ent.storageLimitBytes) * 100))
      : 0;

  if (!session) {
    return (
      <div className="mx-auto max-w-xl px-6 py-20 text-center space-y-4">
        <Images className="mx-auto h-12 w-12 text-ink-muted" />
        <h1 className="text-xl font-semibold text-ink-primary">登录后管理私有资产与商品主体库</h1>
        <button
          type="button"
          onClick={() => openLoginModal()}
          className="rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
        >
          手机号验证码登录
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5 max-w-[1440px] mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">资产与主体中心</h1>
          <p className="text-xs text-ink-tertiary">
            商业原图、商品主体档案与成品均严格私有隔离；移入回收站前自动检查引用影响并保留 30 天。
          </p>
        </div>

        {/* Cloud Storage Bar */}
        {ent && (
          <div className="min-w-[220px] rounded-lg border border-line-subtle bg-surface px-3.5 py-2 text-xs">
            <div className="flex justify-between text-ink-secondary tabular-metric mb-1">
              <span>云端存储空间</span>
              <span>
                {formatBytes(ent.usedStorageBytes)} / {formatBytes(ent.storageLimitBytes)} ({usedPct}%)
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-subtle">
              <div
                className={
                  usedPct >= 100
                    ? 'h-full bg-status-failed-fg'
                    : usedPct >= 85
                      ? 'h-full bg-status-stale-fg'
                      : 'h-full bg-ai'
                }
                style={{ width: `${usedPct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Category Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-subtle pb-3">
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              { id: 'all', label: '全部资产' },
              { id: 'subjects', label: '商品主体' },
              { id: 'style', label: '风格与场景参考' },
              { id: 'trash', label: '回收站（30 天）' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setTab(t.id);
                setSearchParams({ tab: t.id });
              }}
              className={`rounded-md px-3.5 py-1.5 text-xs font-medium ${
                tab === t.id
                  ? 'bg-primary text-primary-foreground font-semibold'
                  : 'border border-line-subtle bg-surface text-ink-secondary hover:bg-hover'
              }`}
            >
              {t.label}
            </button>
          ))}

          {/* P1 virtual_tryon portrait library folded when flag=false */}
          {features.virtual_tryon && (
            <span className="inline-flex items-center rounded-md border border-line-subtle bg-surface px-3 py-1.5 text-xs text-ink-secondary">
              人物 / 模特主体
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="h-8 rounded-md border border-line-default bg-surface px-2.5 text-xs text-ink-primary"
          >
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          {tab !== 'subjects' && (
            <>
              <select
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value as MediaKind | '')}
                className="h-8 rounded-md border border-line-default bg-surface px-2.5 text-xs text-ink-primary"
              >
                <option value="">全部媒体</option>
                <option value="image">图片</option>
                <option value="video">视频</option>
              </select>
              <input
                type="text"
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                placeholder="按标签筛选..."
                className="h-8 w-36 rounded-md border border-line-default bg-surface px-2.5 text-xs text-ink-primary"
              />
            </>
          )}
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="aspect-square rounded-lg skeleton-shimmer" />
          ))}
        </div>
      ) : tab === 'subjects' ? (
        subjects.length === 0 ? (
          <div className="rounded-xl border border-line-subtle bg-surface p-12 text-center space-y-2">
            <ShieldCheck className="mx-auto h-10 w-10 text-ink-muted opacity-50" />
            <div className="text-sm font-semibold text-ink-primary">暂无商品主体档案</div>
            <p className="text-xs text-ink-tertiary">
              在「电商营销工作室」上传商品原图并完成智能抠图后，即可建立像素保真商品主体档案。
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {subjects.map((sub) => (
              <div
                key={sub.id}
                className="rounded-xl border border-line-subtle bg-surface p-3 space-y-2"
              >
                <div className="relative aspect-square overflow-hidden rounded-lg checkerboard-bg border border-line-subtle">
                  <img
                    src={api.getAssetContentUrl(sub.primaryAssetId, 'preview')}
                    alt={sub.name}
                    className="h-full w-full object-contain"
                  />
                  <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-xs bg-status-success-bg px-1.5 py-0.5 text-[10px] font-semibold text-status-success-fg">
                    <Lock className="h-2.5 w-2.5" />
                    像素保真主体
                  </span>
                </div>
                <div className="text-sm font-semibold text-ink-primary truncate">{sub.name}</div>
                <div className="flex justify-between text-[11px] text-ink-muted tabular-metric">
                  <span>SKU: {sub.sku || '—'}</span>
                  <span>
                    v{sub.version} · {sub.referenceAssetIds.length} 视角
                  </span>
                </div>
              </div>
            ))}
          </div>
        )
      ) : assets.length === 0 ? (
        <div className="rounded-xl border border-line-subtle bg-surface p-12 text-center text-xs text-ink-muted">
          {tab === 'trash' ? '回收站为空' : '暂无符合条件的资产'}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {assets.map((asset) => (
            <div
              key={asset.id}
              onClick={() => void handleOpenDetail(asset)}
              className="group cursor-pointer overflow-hidden rounded-lg border border-line-subtle bg-surface shadow-xs hover:border-ai flex flex-col"
            >
              <div className="relative aspect-square overflow-hidden bg-subtle">
                {asset.kind === 'video' ? (
                  <video
                    src={api.getAssetContentUrl(asset.id, 'preview')}
                    muted
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <img
                    src={asset.thumbnailUrl || api.getAssetContentUrl(asset.id, 'preview')}
                    alt={asset.name}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                )}
                <span
                  className="absolute left-1.5 top-1.5 rounded-xs px-1.5 py-0.5 text-[10px] font-medium"
                  style={{ backgroundColor: 'var(--bg-modal-overlay)', color: 'var(--showcase-fg)' }}
                >
                  {asset.assetRole}
                </span>
              </div>
              <div className="p-2.5 space-y-1">
                <div className="truncate text-xs font-medium text-ink-primary">{asset.name}</div>
                <div className="flex items-center justify-between text-[10px] text-ink-muted tabular-metric">
                  <span>{formatBytes(asset.byteSize)}</span>
                  {tab === 'trash' ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRestoreAsset(asset);
                      }}
                      className="inline-flex items-center gap-0.5 font-semibold text-status-success-fg hover:underline"
                    >
                      <RotateCcw className="h-3 w-3" />
                      恢复
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRequestArchive(asset);
                      }}
                      title="移入回收站"
                      className="text-ink-muted hover:text-status-failed-fg"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {nextCursor && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void loadAssets(nextCursor)}
            className="rounded-md border border-line-default bg-surface px-4 py-2 text-xs text-ink-primary hover:bg-hover"
          >
            加载更多资产
          </button>
        </div>
      )}

      {/* Asset Provenance & License Drawer */}
      {detailAsset && (
        <div
          className="fixed inset-0 flex justify-end"
          style={{ backgroundColor: 'var(--bg-modal-overlay)', zIndex: 'var(--z-drawer)' }}
          onClick={() => setDetailAsset(null)}
        >
          <div
            className="flex h-full w-full max-w-[420px] flex-col border-l border-line-default bg-elevated shadow-modal overflow-y-auto p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line-subtle pb-3">
              <h3 className="text-sm font-semibold text-ink-primary truncate">{detailAsset.name}</h3>
              <button
                type="button"
                onClick={() => setDetailAsset(null)}
                className="text-ink-tertiary hover:text-ink-primary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="overflow-hidden rounded-lg border border-line-subtle checkerboard-bg">
              {detailAsset.kind === 'video' ? (
                <video
                  src={api.getAssetContentUrl(detailAsset.id, 'preview')}
                  controls
                  className="max-h-64 w-full object-contain"
                />
              ) : (
                <img
                  src={api.getAssetContentUrl(detailAsset.id, 'preview')}
                  alt={detailAsset.name}
                  className="max-h-64 w-full object-contain"
                />
              )}
            </div>

            <div className="space-y-2 rounded-lg border border-line-subtle bg-surface p-3 text-xs">
              <div className="font-semibold text-ink-primary">生成谱系溯源</div>
              <div className="flex justify-between text-ink-secondary">
                <span>来源类型</span>
                <span>{detailAsset.origin === 'generated' ? 'AI 生成成品' : '用户上传原件'}</span>
              </div>
              <div className="flex justify-between text-ink-secondary tabular-metric">
                <span>尺寸 / 体积</span>
                <span>
                  {detailAsset.width && detailAsset.height
                    ? `${detailAsset.width}×${detailAsset.height} · `
                    : ''}
                  {formatBytes(detailAsset.byteSize)}
                </span>
              </div>
              <div className="flex justify-between text-ink-secondary tabular-metric">
                <span>源任务 ID</span>
                <span>{detailAsset.sourceJobId || '—'}</span>
              </div>
              <div className="flex justify-between text-ink-secondary tabular-metric">
                <span>创建时间</span>
                <span>{formatUtcDateTime(detailAsset.createdAt)}</span>
              </div>
              {detailAsset.inputAssetIds.length > 0 && (
                <div className="pt-1 border-t border-line-subtle">
                  <div className="text-ink-tertiary mb-1">上游输入资产 ID：</div>
                  <div className="flex flex-wrap gap-1 tabular-metric">
                    {detailAsset.inputAssetIds.map((id) => (
                      <span key={id} className="rounded bg-subtle px-1.5 py-0.5 text-[10px]">
                        {id}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Export License Lookup */}
            <div className="space-y-2 rounded-lg border border-line-subtle bg-surface p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ink-primary flex items-center gap-1.5">
                  <FileBadge2 className="h-3.5 w-3.5 text-ai" />
                  商用授权凭证
                </span>
                <button
                  type="button"
                  disabled={loadingLicense}
                  onClick={() => void handleFetchLicense(detailAsset.id)}
                  className="text-ink-link hover:underline"
                >
                  {loadingLicense ? '查询中...' : '获取授权记录'}
                </button>
              </div>
              {detailLicense ? (
                <div className="space-y-1 text-[11px] text-ink-secondary">
                  <div className="font-medium text-status-success-fg">{detailLicense.label}</div>
                  <div>条款版本：{detailLicense.termsVersion}</div>
                  <div>签发时间：{formatUtcDateTime(detailLicense.issuedAt)}</div>
                </div>
              ) : (
                <div className="text-[11px] text-ink-muted">
                  Free 导出带轻水印非商用；Pro 导出无水印原画质并签发个人商用授权记录。
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-2">
              <a
                href={api.getAssetContentUrl(detailAsset.id, 'download')}
                download
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-primary py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
              >
                <Download className="h-3.5 w-3.5" />
                <span>下载素材</span>
              </a>
              {detailAsset.status === 'ready' ? (
                <button
                  type="button"
                  onClick={() => void handleRequestArchive(detailAsset)}
                  className="rounded-md border border-status-failed-border bg-status-failed-bg px-3 py-2 text-xs font-semibold text-status-failed-fg"
                >
                  移入回收站
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleRestoreAsset(detailAsset)}
                  className="rounded-md border border-status-success-border bg-status-success-bg px-3 py-2 text-xs font-semibold text-status-success-fg"
                >
                  恢复素材
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Reference Impact Confirmation Dialog */}
      {impactDialog && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          style={{ backgroundColor: 'var(--bg-modal-overlay)', zIndex: 'var(--z-modal)' }}
        >
          <div
            role="dialog"
            aria-label="资产引用影响确认"
            className="w-full max-w-[440px] rounded-modal border border-line-default bg-elevated p-6 shadow-modal space-y-4"
          >
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="h-5 w-5 text-status-stale-fg shrink-0 mt-0.5" />
              <div>
                <h3 className="text-base font-semibold text-ink-primary">确认移入 30 天回收站？</h3>
                <p className="mt-1 text-xs text-ink-secondary">
                  素材「{impactDialog.asset.name}」当前引用影响检查结果：
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 rounded-lg border border-line-subtle bg-surface p-3 text-center text-xs tabular-metric">
              <div>
                <div className="text-ink-tertiary">引用画布数</div>
                <div className="mt-0.5 text-base font-bold text-ink-primary">
                  {impactDialog.impact.referencingCanvasCount} 个
                </div>
              </div>
              <div>
                <div className="text-ink-tertiary">关联活跃任务</div>
                <div className="mt-0.5 text-base font-bold text-ink-primary">
                  {impactDialog.impact.activeJobs} 个
                </div>
              </div>
            </div>

            <div className="rounded-md bg-status-success-bg p-3 text-xs text-status-success-fg leading-relaxed">
              归档入 30 天回收站后，<strong>历史画布已生成的图片/视频成品不受影响，仍可正常浏览与下载</strong>；
              仅在重新运行引用该素材的上游节点时需从回收站恢复或替换新素材。
              {impactDialog.impact.purgeAfter && (
                <div className="mt-1 tabular-metric">
                  预计彻底清理时间：{formatUtcDate(impactDialog.impact.purgeAfter)}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setImpactDialog(null)}
                className="rounded-md bg-subtle px-4 py-2 text-xs text-ink-secondary"
              >
                取消
              </button>
              <button
                type="button"
                disabled={archiving}
                onClick={() => void handleConfirmArchive()}
                className="rounded-md bg-status-failed-fg px-4 py-2 text-xs font-semibold text-ink-inverse disabled:opacity-50"
              >
                {archiving ? '归档中...' : '我已知晓影响，移入回收站'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
