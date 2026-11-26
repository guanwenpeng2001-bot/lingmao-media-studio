import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Copy,
  Layers,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import { api, isApiClientError } from '../../api/client';
import type { CanvasSummary, Template } from '../../api/types';
import { formatUtcDate } from '../../lib/creditPools';
import { useApp } from '../../state/AppContext';

export const CanvasListPage: React.FC = () => {
  const {
    session,
    features,
    projects,
    activeProjectId,
    billingState,
    openLoginModal,
    openCashierDrawer,
    refreshProjects,
    pushToast,
    handleApiError,
  } = useApp();
  const navigate = useNavigate();

  const [items, setItems] = useState<CanvasSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [projectFilter, setProjectFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [scopeFilter, setScopeFilter] = useState<'all' | 'team' | 'personal'>('all');
  const [q, setQ] = useState('');
  const [starterTemplates, setStarterTemplates] = useState<Template[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const loadCanvases = useCallback(
    async (cursor?: string) => {
      if (!session) {
        setLoading(false);
        return;
      }
      if (!cursor) {
        abortRef.current?.abort();
        abortRef.current = new AbortController();
        setLoading(true);
        setErrorMsg(null);
      } else {
        setLoadingMore(true);
      }

      try {
        const res = await api.listCanvases(
          {
            projectId: projectFilter || undefined,
            status: statusFilter || undefined,
            scope: features.org_collaboration ? scopeFilter : undefined,
            q: q.trim() || undefined,
            cursor,
            limit: 24,
          },
          cursor ? undefined : abortRef.current?.signal
        );
        if (cursor) {
          setItems((prev) => [...prev, ...res.items]);
        } else {
          setItems(res.items);
        }
        setTotal(res.total);
        setNextCursor(res.nextCursor);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setErrorMsg(
          isApiClientError(err) ? `${err.message} (Req: ${err.requestId})` : '加载画布列表失败'
        );
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [session, projectFilter, statusFilter, scopeFilter, q, features.org_collaboration]
  );

  useEffect(() => {
    void loadCanvases();
  }, [loadCanvases]);

  useEffect(() => {
    void api
      .listTemplates({ industry: 'ecommerce' })
      .then((list) => setStarterTemplates(list.slice(0, 3)))
      .catch(() => {});
  }, []);

  const ensureProject = async (): Promise<string | null> => {
    if (projectFilter) return projectFilter;
    if (activeProjectId) return activeProjectId;
    if (projects[0]?.id) return projects[0].id;
    try {
      const created = await api.createProject({ name: '默认电商工作项目', industry: 'ecommerce' });
      await refreshProjects();
      return created.id;
    } catch (err) {
      handleApiError(err);
      return null;
    }
  };

  const maxCanvasCount = billingState?.entitlements.maxCanvasCount ?? 100;
  const isOverCanvasLimit = total >= maxCanvasCount && maxCanvasCount > 0;

  const handleCreateBlankCanvas = async (templateId?: string, customName?: string) => {
    if (!session) {
      openLoginModal(() => void handleCreateBlankCanvas(templateId, customName));
      return;
    }
    if (isOverCanvasLimit) {
      pushToast({
        tone: 'warning',
        title: `已达到当前套餐画布上限（${total}/${maxCanvasCount}）`,
        description: '您的历史画布完整保留且可正常浏览导出，请升级 Pro 或归档清理旧画布后再新建。',
      });
      openCashierDrawer('plans');
      return;
    }
    const targetProjectId = await ensureProject();
    if (!targetProjectId) return;
    try {
      const created = await api.createCanvas(targetProjectId, {
        name: customName || `未命名画布 ${new Date().toLocaleDateString()}`,
        templateId,
      });
      navigate(`/canvases/${created.summary.id}`);
    } catch (err) {
      handleApiError(err);
    }
  };

  const handleCloneCanvas = async (canvas: CanvasSummary) => {
    if (!session) {
      openLoginModal(() => void handleCloneCanvas(canvas));
      return;
    }
    if (isOverCanvasLimit) {
      pushToast({
        tone: 'warning',
        title: `超出当前套餐画布上限（${total}/${maxCanvasCount}）`,
        description: '请升级 Pro 或清理冗余画布后再复制副本。',
      });
      openCashierDrawer('plans');
      return;
    }
    const targetProjectId = await ensureProject();
    if (!targetProjectId) return;
    try {
      const cloned = await api.cloneCanvas(canvas.id, {
        targetProjectId,
        name: `${canvas.name} - 副本`,
      });
      pushToast({ tone: 'success', title: '已复制为我的画布' });
      navigate(`/canvases/${cloned.summary.id}`);
    } catch (err) {
      handleApiError(err);
    }
  };

  const projectNameById = new Map(projects.map((p) => [p.id, p.name]));
  const hasFilters = Boolean(projectFilter || statusFilter || q.trim());

  if (!session) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-20 text-center space-y-4">
        <Layers className="mx-auto h-12 w-12 text-ink-muted" />
        <h1 className="text-xl font-semibold text-ink-primary">登录后管理您的无限画布</h1>
        <p className="text-sm text-ink-tertiary">
          支持 200+ 多模态节点编排、单节点积分预估、多视频共享时间轴联动预览与云端自动保存。
        </p>
        <button
          type="button"
          onClick={() => openLoginModal()}
          className="rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary-hover"
        >
          手机号验证码登录
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5">
      {/* Header & Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">画布列表</h1>
          <div className="mt-0.5 text-xs text-ink-tertiary tabular-metric">
            共 {total} 个画布
            {isOverCanvasLimit && (
              <span className="ml-2 text-status-stale-fg">
                （当前超出 Free 上限 {maxCanvasCount}，历史画布保留可看可导出，新建需升级或清理）
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleCreateBlankCanvas()}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
        >
          <Plus className="h-4 w-4" />
          <span>新建空白画布</span>
        </button>
      </div>

      {/* Multi-dimensional Filter Bar */}
      <div className="flex flex-wrap items-center gap-2.5">
        <select
          aria-label="按项目筛选"
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          className="h-9 min-w-[140px] rounded-md border border-line-default bg-surface px-2.5 text-xs text-ink-primary outline-none focus:border-line-focus"
        >
          <option value="">全部项目</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <select
          aria-label="按状态筛选"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 min-w-[120px] rounded-md border border-line-default bg-surface px-2.5 text-xs text-ink-primary outline-none focus:border-line-focus"
        >
          <option value="">全部状态</option>
          <option value="active">进行中</option>
          <option value="completed">已完成</option>
          <option value="archived">已归档</option>
        </select>

        <div className="relative flex-1 min-w-[200px] max-w-[280px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索画布名称..."
            className="h-9 w-full rounded-md border border-line-default bg-surface pl-8 pr-3 text-xs text-ink-primary outline-none focus:border-line-focus"
          />
        </div>

        {/* P1 org_collaboration-gated scope segmented control (hidden when flag=false) */}
        {features.org_collaboration && (
          <div
            data-testid="canvas-scope-filter"
            className="flex items-center rounded-md bg-subtle p-0.5 text-xs"
          >
            {(
              [
                { id: 'all', label: '全部' },
                { id: 'team', label: '团队项目' },
                { id: 'personal', label: '个人项目' },
              ] as const
            ).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setScopeFilter(s.id)}
                className={`rounded-sm px-2.5 py-1 font-medium ${
                  scopeFilter === s.id
                    ? 'bg-surface text-ink-primary shadow-xs'
                    : 'text-ink-secondary hover:text-ink-primary'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => void loadCanvases()}
          title="刷新画布列表"
          className="flex h-9 w-9 items-center justify-center rounded-md border border-line-default bg-surface text-ink-secondary hover:bg-hover hover:text-ink-primary"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* State 4: Error / Expired Cursor */}
      {errorMsg && (
        <div className="flex items-center justify-between rounded-lg border border-status-failed-border bg-status-failed-bg p-4 text-xs text-status-failed-fg">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            <span>{errorMsg}</span>
          </div>
          <button
            type="button"
            onClick={() => void loadCanvases()}
            className="rounded-md bg-surface px-3 py-1 font-semibold text-ink-primary"
          >
            重新加载列表
          </button>
        </div>
      )}

      {/* State 3: Loading Skeleton Grid */}
      {loading ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-7">
          {Array.from({ length: 10 }).map((_, idx) => (
            <div key={idx} className="space-y-2">
              <div className="aspect-[16/10] w-full rounded-card skeleton-shimmer" />
              <div className="h-4 w-3/4 rounded skeleton-shimmer" />
              <div className="h-3 w-1/2 rounded skeleton-shimmer" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        /* State 2: Empty State */
        <div className="rounded-xl border border-line-subtle bg-surface px-6 py-12 text-center space-y-4">
          <Layers className="mx-auto h-10 w-10 text-ink-muted" />
          {hasFilters ? (
            <>
              <div className="text-sm font-semibold text-ink-primary">未找到符合筛选条件的画布</div>
              <button
                type="button"
                onClick={() => {
                  setProjectFilter('');
                  setStatusFilter('');
                  setQ('');
                }}
                className="rounded-md border border-line-default bg-subtle px-4 py-2 text-xs font-medium text-ink-primary hover:bg-hover"
              >
                清空筛选条件
              </button>
            </>
          ) : (
            <>
              <div className="text-sm font-semibold text-ink-primary">还没有无限画布，立即开启第一条多模态流水线</div>
              <p className="mx-auto max-w-md text-xs text-ink-tertiary">
                可新建空白画布自由编排，或直接套用官方电商高频模板一键起步。
              </p>
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => void handleCreateBlankCanvas()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>新建空白画布</span>
                </button>
              </div>
              {starterTemplates.length > 0 && (
                <div className="mx-auto mt-4 grid max-w-3xl grid-cols-1 gap-3 pt-4 border-t border-line-subtle sm:grid-cols-3 text-left">
                  {starterTemplates.map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => void handleCreateBlankCanvas(tpl.id, tpl.name)}
                      className="rounded-lg border border-line-subtle bg-muted p-3 hover:border-ai transition-colors"
                    >
                      <div className="flex items-center gap-1 text-xs font-semibold text-ink-primary">
                        <Sparkles className="h-3.5 w-3.5 text-ai" />
                        <span className="truncate">{tpl.name}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] text-ink-tertiary">{tpl.prompt}</p>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        /* State 1 & 5: High-Density Responsive Card Grid (incl. Readonly badges & clone) */
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-7">
            {items.map((canvas) => {
              const isReadOnly = !canvas.canEdit;
              const projName = projectNameById.get(canvas.projectId) || '默认项目';
              return (
                <div
                  key={canvas.id}
                  className="group flex flex-col cursor-pointer"
                  onClick={() => navigate(`/canvases/${canvas.id}`)}
                >
                  <div className="relative aspect-[16/10] overflow-hidden rounded-card border border-line-subtle bg-subtle shadow-xs transition-all group-hover:border-line-strong">
                    {canvas.coverAssetId ? (
                      <img
                        src={api.getAssetContentUrl(canvas.coverAssetId, 'preview')}
                        alt={canvas.name}
                        className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-ink-muted">
                        <Layers className="h-7 w-7 opacity-40" />
                      </div>
                    )}

                    {/* Readonly Badge */}
                    {isReadOnly && (
                      <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full border border-status-readonly-border bg-status-readonly-bg px-2 py-0.5 text-[10px] font-semibold text-status-readonly-fg">
                        <Lock className="h-2.5 w-2.5" />
                        只读
                      </span>
                    )}

                    {/* Hover Quick Actions */}
                    <div
                      className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() => void handleCloneCanvas(canvas)}
                        title="复制为我的画布"
                        className="flex items-center gap-1 rounded-md border border-line-default bg-elevated/95 px-2 py-1 text-[10px] font-semibold text-ink-primary shadow-xs hover:bg-hover"
                      >
                        <Copy className="h-3 w-3" />
                        <span>{isReadOnly ? '复制为我的画布' : '复制'}</span>
                      </button>
                    </div>
                  </div>

                  <div className="pt-2 space-y-0.5">
                    <div className="truncate text-sm font-semibold text-ink-primary">
                      {canvas.name}
                    </div>
                    <div className="truncate text-xs text-ink-tertiary">
                      {projName} · {isReadOnly ? '只读' : '可编辑'}
                    </div>
                    <div className="tabular-metric text-xs text-ink-muted">
                      {canvas.nodeCount} 个节点 · {formatUtcDate(canvas.updatedAt)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {nextCursor && (
            <div className="flex justify-center pt-4">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadCanvases(nextCursor)}
                className="rounded-md border border-line-default bg-surface px-5 py-2 text-xs font-medium text-ink-primary hover:bg-hover disabled:opacity-50"
              >
                {loadingMore ? '加载中...' : '加载更多画布'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
