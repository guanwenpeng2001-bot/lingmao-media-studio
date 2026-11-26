import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderPlus, X } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../state/AppContext';

const INDUSTRIES = [
  { id: 'ecommerce', label: '电商营销（推荐）' },
  { id: 'design', label: '广告营销与平面设计' },
  { id: 'film', label: '短剧 / 影视分镜' },
  { id: 'general', label: '通用创作' },
];

export const CreateProjectModal: React.FC = () => {
  const {
    createProjectModalOpen,
    setCreateProjectModalOpen,
    refreshProjects,
    setActiveProjectId,
    pushToast,
    handleApiError,
  } = useApp();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('ecommerce');
  const [createInitialCanvas, setCreateInitialCanvas] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  if (!createProjectModalOpen) return null;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      const project = await api.createProject({ name: name.trim(), industry });
      await refreshProjects();
      setActiveProjectId(project.id);
      if (createInitialCanvas) {
        const canvas = await api.createCanvas(project.id, { name: `${project.name} · 主画布` });
        pushToast({ tone: 'success', title: '项目与画布已创建' });
        setCreateProjectModalOpen(false);
        setName('');
        navigate(`/canvases/${canvas.summary.id}`);
      } else {
        pushToast({ tone: 'success', title: '项目已创建' });
        setCreateProjectModalOpen(false);
        setName('');
        navigate('/projects');
      }
    } catch (err) {
      handleApiError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-modal-overlay)', zIndex: 'var(--z-modal)' }}
      onClick={() => setCreateProjectModalOpen(false)}
    >
      <form
        onSubmit={handleCreate}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[440px] rounded-modal border border-line-default bg-elevated p-6 shadow-modal space-y-4"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderPlus className="h-4 w-4 text-ai" />
            <h3 className="text-base font-semibold text-ink-primary">新建项目 / 画布</h3>
          </div>
          <button
            type="button"
            onClick={() => setCreateProjectModalOpen(false)}
            className="rounded p-1 text-ink-tertiary hover:bg-hover"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-secondary">项目名称</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：双11蓝牙音箱视觉物料"
              className="h-9 w-full rounded-md border border-line-default bg-surface px-3 text-sm text-ink-primary outline-none focus:border-line-focus"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-ink-secondary">所属行业</label>
            <select
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              className="h-9 w-full rounded-md border border-line-default bg-surface px-3 text-sm text-ink-primary outline-none focus:border-line-focus"
            >
              {INDUSTRIES.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-xs text-ink-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={createInitialCanvas}
              onChange={(e) => setCreateInitialCanvas(e.target.checked)}
              className="h-3.5 w-3.5 rounded accent-ai"
            />
            <span>同时初始化一张无限画布并立即进入</span>
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={() => setCreateProjectModalOpen(false)}
            className="rounded-md bg-subtle px-4 py-2 text-xs font-medium text-ink-secondary hover:bg-hover"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
          >
            {submitting ? '创建中...' : '确认创建'}
          </button>
        </div>
      </form>
    </div>
  );
};
