import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Compass, Layers, Search, ShoppingBag, Sparkles, X } from 'lucide-react';
import { api } from '../../api/client';
import type { Template } from '../../api/types';
import { useApp } from '../../state/AppContext';

// Ecommerce tab strictly pinned first per PRD 3.4 & UX_FLOW 3.4
const INDUSTRY_TABS = [
  { id: 'ecommerce', label: '电商（置顶）' },
  { id: 'design', label: '广告营销 / 平面' },
  { id: 'film', label: '短剧漫剧 / 分镜' },
  { id: 'general', label: '通用精选' },
  { id: 'all', label: '全部行业' },
];

export const ExplorePage: React.FC = () => {
  const { session, projects, activeProjectId, openLoginModal, refreshProjects, pushToast, handleApiError } =
    useApp();
  const navigate = useNavigate();

  const [industry, setIndustry] = useState('ecommerce');
  const [visibilityFilter, setVisibilityFilter] = useState<'all' | 'official' | 'personal'>('all');
  const [q, setQ] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewTpl, setPreviewTpl] = useState<Template | null>(null);
  const [cloning, setCloning] = useState(false);

  useEffect(() => {
    setLoading(true);
    void api
      .listTemplates({
        industry: industry === 'all' ? undefined : industry,
        q: q.trim() || undefined,
      })
      .then(setTemplates)
      .catch(() => setTemplates([]))
      .finally(() => setLoading(false));
  }, [industry, q]);

  const filtered = templates.filter((t) => {
    if (visibilityFilter === 'official') return t.visibility === 'official';
    if (visibilityFilter === 'personal') return t.visibility === 'personal';
    return true;
  });

  const handleUseTemplate = async (tpl: Template, openMode: 'studio' | 'canvas') => {
    if (!session) {
      openLoginModal(() => void handleUseTemplate(tpl, openMode));
      return;
    }
    if (openMode === 'studio') {
      setPreviewTpl(null);
      navigate('/studio', {
        state: {
          prefillPrompt: tpl.prompt,
          prefillMode: tpl.suggestedModes[0] || 'text_to_image',
          prefillRatio: tpl.aspectRatio,
          templateId: tpl.id,
        },
      });
      return;
    }

    setCloning(true);
    try {
      let pid = activeProjectId || projects[0]?.id;
      if (!pid) {
        const createdProj = await api.createProject({
          name: `${tpl.industry === 'ecommerce' ? '电商' : '创作'}同款项目`,
          industry: tpl.industry || 'ecommerce',
        });
        await refreshProjects();
        pid = createdProj.id;
      }
      const created = await api.createCanvas(pid, {
        name: `${tpl.name} - 同款画布`,
        templateId: tpl.id,
      });
      pushToast({ tone: 'success', title: '已克隆模板为新画布副本' });
      setPreviewTpl(null);
      navigate(`/canvases/${created.summary.id}`);
    } catch (err) {
      handleApiError(err);
    } finally {
      setCloning(false);
    }
  };

  return (
    <div className="p-6 space-y-5 max-w-[1440px] mx-auto">
      {/* Top Banner */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line-subtle bg-surface p-5">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Compass className="h-5 w-5 text-ai" />
            <h1 className="text-xl font-semibold text-ink-primary">探索广场与行业工作流模板</h1>
          </div>
          <p className="text-xs text-ink-tertiary">
            免登可自由浏览全部官方样板与工作流结构；点击「一键做同款」即可直达快捷创作或克隆为您的专属画布。
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/ecommerce')}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
        >
          <ShoppingBag className="h-4 w-4" />
          <span>进入电商营销工作室</span>
        </button>
      </div>

      {/* Industry Tabs + Search + Official/Personal Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {INDUSTRY_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setIndustry(t.id)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
                industry === t.id
                  ? 'bg-primary text-primary-foreground font-semibold'
                  : 'border border-line-subtle bg-surface text-ink-secondary hover:bg-hover hover:text-ink-primary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md bg-subtle p-0.5 text-xs">
            {(
              [
                { id: 'all', label: '全部' },
                { id: 'official', label: '官方精选' },
                { id: 'personal', label: '我的私有模板' },
              ] as const
            ).map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setVisibilityFilter(v.id)}
                className={`rounded-sm px-2.5 py-1 font-medium ${
                  visibilityFilter === v.id
                    ? 'bg-surface text-ink-primary shadow-xs'
                    : 'text-ink-secondary'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>

          <div className="relative w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索模板关键词..."
              className="h-8 w-full rounded-md border border-line-default bg-surface pl-8 pr-3 text-xs text-ink-primary outline-none focus:border-line-focus"
            />
          </div>
        </div>
      </div>

      {/* Template Grid */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-52 rounded-xl skeleton-shimmer" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-line-subtle bg-surface p-12 text-center space-y-2">
          <Sparkles className="mx-auto h-9 w-9 text-ink-muted opacity-50" />
          <div className="text-sm font-semibold text-ink-primary">
            {visibilityFilter === 'personal' ? '暂无个人私有模板' : '未找到匹配的模板'}
          </div>
          <p className="text-xs text-ink-tertiary">
            {visibilityFilter === 'personal'
              ? '在无限画布中跑通流水线后，点击右上角「另存为模板」即可自动脱敏沉淀至此。'
              : '请尝试切换行业标签或清空搜索关键词。'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {filtered.map((tpl) => (
            <div
              key={tpl.id}
              onClick={() => setPreviewTpl(tpl)}
              className="group cursor-pointer rounded-xl border border-line-subtle bg-surface p-4 shadow-xs transition-all hover:border-ai flex flex-col justify-between space-y-3"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`rounded-xs px-1.5 py-0.5 text-[10px] font-semibold ${
                      tpl.visibility === 'official'
                        ? 'bg-badge-new-bg text-badge-new-fg'
                        : 'bg-badge-beta-bg text-badge-beta-fg'
                    }`}
                  >
                    {tpl.visibility === 'official' ? '官方模板' : '我的私有模板'}
                  </span>
                  <span className="tabular-metric text-[11px] text-ink-muted">{tpl.aspectRatio}</span>
                </div>
                <h3 className="text-sm font-semibold text-ink-primary group-hover:text-ai">
                  {tpl.name}
                </h3>
                <p className="line-clamp-3 text-xs text-ink-tertiary leading-relaxed">{tpl.prompt}</p>
                {tpl.tags && tpl.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {tpl.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-xs bg-subtle px-1.5 py-0.5 text-[10px] text-ink-secondary"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex gap-2 pt-2 border-t border-line-subtle" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  onClick={() => void handleUseTemplate(tpl, 'canvas')}
                  className="flex-1 rounded-md bg-primary py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
                >
                  一键做同款
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Template Preview Modal */}
      {previewTpl && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          style={{ backgroundColor: 'var(--bg-modal-overlay)', zIndex: 'var(--z-modal)' }}
          onClick={() => setPreviewTpl(null)}
        >
          <div
            className="w-full max-w-[520px] rounded-modal border border-line-default bg-elevated p-6 shadow-modal space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold text-ink-primary">{previewTpl.name}</h3>
                <div className="mt-1 text-xs text-ink-tertiary">
                  行业：{previewTpl.industry} · 比例：{previewTpl.aspectRatio} · 模式：
                  {previewTpl.suggestedModes.join(', ')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreviewTpl(null)}
                className="rounded p-1 text-ink-tertiary hover:bg-hover"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="rounded-lg border border-line-subtle bg-surface p-3 text-xs text-ink-secondary leading-relaxed">
              {previewTpl.prompt}
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                disabled={cloning}
                onClick={() => void handleUseTemplate(previewTpl, 'studio')}
                className="flex-1 rounded-md border border-line-default bg-surface py-2 text-xs font-semibold text-ink-primary hover:bg-hover"
              >
                带入快捷创作区
              </button>
              <button
                type="button"
                disabled={cloning}
                onClick={() => void handleUseTemplate(previewTpl, 'canvas')}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-primary py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
              >
                <Layers className="h-3.5 w-3.5" />
                <span>{cloning ? '正在克隆画布...' : '一键做同款（克隆画布）'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
