import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Archive,
  Check,
  Edit3,
  FolderKanban,
  Layers,
  Plus,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { api } from '../../api/client';
import type { Project } from '../../api/types';
import { formatUtcDate } from '../../lib/creditPools';
import { useApp } from '../../state/AppContext';

const INDUSTRY_LABEL: Record<string, string> = {
  ecommerce: '电商营销',
  design: '广告平面',
  film: '短剧分镜',
  general: '通用创作',
};

export const ProjectsPage: React.FC = () => {
  const {
    session,
    openLoginModal,
    setCreateProjectModalOpen,
    refreshProjects,
    setActiveProjectId,
    pushToast,
    handleApiError,
  } = useApp();
  const navigate = useNavigate();

  const [items, setItems] = useState<Project[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [industry, setIndustry] = useState('');
  const [status, setStatus] = useState('active');
  const [q, setQ] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const load = useCallback(
    async (cursor?: string) => {
      if (!session) {
        setLoading(false);
        return;
      }
      if (!cursor) setLoading(true);
      try {
        const res = await api.listProjects({
          industry: industry || undefined,
          status: status || undefined,
          q: q.trim() || undefined,
          cursor,
          limit: 24,
        });
        setItems((prev) => (cursor ? [...prev, ...res.items] : res.items));
        setNextCursor(res.nextCursor);
      } catch (err) {
        handleApiError(err);
      } finally {
        setLoading(false);
      }
    },
    [session, industry, status, q, handleApiError]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const handleRename = async (proj: Project) => {
    if (!editingName.trim() || editingName.trim() === proj.name) {
      setEditingId(null);
      return;
    }
    try {
      const updated = await api.updateProject(proj.id, {
        name: editingName.trim(),
        baseRevision: proj.revision,
      });
      setItems((prev) => prev.map((p) => (p.id === proj.id ? updated : p)));
      void refreshProjects();
      setEditingId(null);
      pushToast({ tone: 'success', title: '项目名称已更新' });
    } catch (err) {
      handleApiError(err);
    }
  };

  const handleToggleArchive = async (proj: Project) => {
    const nextStatus = proj.status === 'active' ? 'archived' : 'active';
    try {
      const updated = await api.updateProject(proj.id, {
        status: nextStatus,
        baseRevision: proj.revision,
      });
      setItems((prev) =>
        status && updated.status !== status
          ? prev.filter((p) => p.id !== proj.id)
          : prev.map((p) => (p.id === proj.id ? updated : p))
      );
      void refreshProjects();
      pushToast({
        tone: 'success',
        title: nextStatus === 'archived' ? '项目已归档' : '项目已恢复活跃',
      });
    } catch (err) {
      handleApiError(err);
    }
  };

  if (!session) {
    return (
      <div className="mx-auto max-w-xl px-6 py-20 text-center space-y-4">
        <FolderKanban className="mx-auto h-12 w-12 text-ink-muted" />
        <h1 className="text-xl font-semibold text-ink-primary">登录后管理您的创作项目</h1>
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
    <div className="p-6 space-y-5 max-w-[1280px] mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">项目管理</h1>
          <p className="text-xs text-ink-tertiary">
            按电商、广告平面、短剧分镜或通用行业聚合您的画布、商品主体与成品资产。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateProjectModalOpen(true)}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
        >
          <Plus className="h-4 w-4" />
          <span>新建项目</span>
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2.5">
        <select
          value={industry}
          onChange={(e) => setIndustry(e.target.value)}
          className="h-9 rounded-md border border-line-default bg-surface px-3 text-xs text-ink-primary"
        >
          <option value="">全部行业</option>
          <option value="ecommerce">电商营销</option>
          <option value="design">广告平面</option>
          <option value="film">短剧分镜</option>
          <option value="general">通用创作</option>
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 rounded-md border border-line-default bg-surface px-3 text-xs text-ink-primary"
        >
          <option value="active">进行中</option>
          <option value="archived">已归档</option>
          <option value="">全部状态</option>
        </select>
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索项目名称..."
            className="h-9 w-full rounded-md border border-line-default bg-surface pl-8 pr-3 text-xs text-ink-primary"
          />
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 rounded-xl skeleton-shimmer" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-line-subtle bg-surface p-12 text-center space-y-3">
          <FolderKanban className="mx-auto h-10 w-10 text-ink-muted opacity-50" />
          <div className="text-sm font-semibold text-ink-primary">暂无匹配的项目</div>
          <button
            type="button"
            onClick={() => setCreateProjectModalOpen(true)}
            className="rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground"
          >
            新建第一个项目
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((proj) => (
            <div
              key={proj.id}
              className="flex flex-col justify-between rounded-xl border border-line-subtle bg-surface p-4 shadow-xs space-y-3"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded-xs bg-ai-soft px-2 py-0.5 text-[10px] font-semibold text-ai">
                    {INDUSTRY_LABEL[proj.industry] || proj.industry}
                  </span>
                  <span className="tabular-metric text-[11px] text-ink-muted">
                    v{proj.revision} · {formatUtcDate(proj.updatedAt)}
                  </span>
                </div>

                {editingId === proj.id ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      className="h-8 flex-1 rounded border border-line-focus bg-surface px-2 text-xs text-ink-primary"
                    />
                    <button
                      type="button"
                      onClick={() => void handleRename(proj)}
                      className="rounded bg-primary p-1.5 text-primary-foreground"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="rounded bg-subtle p-1.5 text-ink-secondary"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="text-sm font-semibold text-ink-primary truncate">{proj.name}</div>
                )}
              </div>

              <div className="flex items-center justify-between border-t border-line-subtle pt-2.5 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setActiveProjectId(proj.id);
                    navigate('/canvases');
                  }}
                  className="inline-flex items-center gap-1 font-medium text-ink-link hover:underline"
                >
                  <Layers className="h-3.5 w-3.5" />
                  <span>查看画布</span>
                </button>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(proj.id);
                      setEditingName(proj.name);
                    }}
                    title="重命名"
                    className="rounded p-1.5 text-ink-tertiary hover:bg-hover hover:text-ink-primary"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleToggleArchive(proj)}
                    title={proj.status === 'active' ? '归档项目' : '恢复项目'}
                    className="rounded p-1.5 text-ink-tertiary hover:bg-hover hover:text-ink-primary"
                  >
                    {proj.status === 'active' ? (
                      <Archive className="h-3.5 w-3.5" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" />
                    )}
                  </button>
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
            onClick={() => void load(nextCursor)}
            className="rounded-md border border-line-default bg-surface px-4 py-2 text-xs font-medium text-ink-primary hover:bg-hover"
          >
            加载更多项目
          </button>
        </div>
      )}
    </div>
  );
};
