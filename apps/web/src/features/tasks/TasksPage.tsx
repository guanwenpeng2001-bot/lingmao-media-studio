import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  Download,
  RefreshCw,
  RotateCcw,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { api, isApiClientError } from '../../api/client';
import type { Job } from '../../api/types';
import { STATUS_BADGE } from '../../components/TaskDrawer';
import { formatUtcDateTime } from '../../lib/creditPools';
import { useApp } from '../../state/AppContext';

export const TasksPage: React.FC = () => {
  const {
    session,
    projects,
    jobs,
    sseConnected,
    openLoginModal,
    refreshJobs,
    refreshBillingState,
    upsertJob,
    pushToast,
    handleApiError,
  } = useApp();
  const navigate = useNavigate();

  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'succeeded' | 'failed'>('all');
  const [projectFilter, setProjectFilter] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  if (!session) {
    return (
      <div className="mx-auto max-w-xl px-6 py-20 text-center space-y-4">
        <Activity className="mx-auto h-12 w-12 text-ink-muted" />
        <h1 className="text-xl font-semibold text-ink-primary">登录后查看全局异步任务中心</h1>
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

  const filtered = jobs.filter((j) => {
    if (projectFilter && j.projectId !== projectFilter) return false;
    if (statusFilter === 'active') return j.status === 'queued' || j.status === 'running';
    if (statusFilter === 'succeeded') return j.status === 'succeeded';
    if (statusFilter === 'failed') return j.status === 'failed' || j.status === 'cancelled';
    return true;
  });

  const handleCancel = async (job: Job) => {
    const confirmRunning =
      job.status === 'running'
        ? window.confirm('该任务正在生成中，请求取消可能无法退还积分，是否确认继续？')
        : false;
    if (job.status === 'running' && !confirmRunning) return;
    try {
      const updated = await api.cancelJob(job.id, { confirmRunning });
      upsertJob(updated);
      void refreshBillingState();
      pushToast({ tone: 'success', title: '取消指令已处理' });
    } catch (err) {
      if (isApiClientError(err) && err.code === 'CONFIRM_RUNNING_CANCEL') {
        if (window.confirm('任务已进入推理阶段，确认强制请求终止？')) {
          const forced = await api.cancelJob(job.id, { confirmRunning: true });
          upsertJob(forced);
        }
      } else {
        handleApiError(err);
      }
    }
  };

  const handleRetry = async (job: Job) => {
    try {
      const q = await api.quoteGeneration(job.projectId, job.input);
      const retried = await api.retryJob(job.id, { quoteId: q.id });
      upsertJob(retried);
      void refreshBillingState();
      pushToast({ tone: 'success', title: `任务已重试入队（${q.credits} 积分）` });
    } catch (err) {
      handleApiError(err);
    }
  };

  const handleBatchDownload = () => {
    const selectedJobs = filtered.filter(
      (j) => selectedIds.includes(j.id) && j.status === 'succeeded' && j.outputAssetIds[0]
    );
    for (const j of selectedJobs) {
      const link = document.createElement('a');
      link.href = api.getAssetContentUrl(j.outputAssetIds[0], 'download');
      link.download = `${j.id}.bin`;
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
    pushToast({ tone: 'info', title: `已触发 ${selectedJobs.length} 个成品下载` });
  };

  const projectNameById = new Map(projects.map((p) => [p.id, p.name]));

  return (
    <div className="p-6 space-y-5 max-w-[1440px] mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-primary">全局异步任务管理</h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-ink-tertiary">
            {sseConnected ? (
              <span className="inline-flex items-center gap-1 text-status-success-fg">
                <Wifi className="h-3.5 w-3.5" /> SSE 实时推送已连接（按 eventId 去重 + revision 防倒退）
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-status-stale-fg">
                <WifiOff className="h-3.5 w-3.5" /> SSE 重连中（已自动启用指数退避轮询兜底）
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {selectedIds.length > 0 && (
            <button
              type="button"
              onClick={handleBatchDownload}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
            >
              <Download className="h-3.5 w-3.5" />
              <span>批量下载 ({selectedIds.length})</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => void refreshJobs()}
            className="inline-flex items-center gap-1.5 rounded-md border border-line-default bg-surface px-3 py-1.5 text-xs font-medium text-ink-primary hover:bg-hover"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>刷新</span>
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex rounded-md bg-subtle p-0.5 text-xs">
          {(
            [
              { id: 'all', label: '全部' },
              { id: 'active', label: '进行中' },
              { id: 'succeeded', label: '已完成' },
              { id: 'failed', label: '失败与已取消' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setStatusFilter(t.id)}
              className={`rounded-sm px-3 py-1 font-medium ${
                statusFilter === t.id
                  ? 'bg-surface text-ink-primary shadow-xs font-semibold'
                  : 'text-ink-secondary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

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
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-line-subtle bg-surface">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-line-subtle bg-muted text-ink-tertiary">
            <tr>
              <th className="w-9 px-3 py-2.5" />
              <th className="px-3 py-2.5">任务 / 模式</th>
              <th className="px-3 py-2.5">所属项目 / 画布</th>
              <th className="px-3 py-2.5">状态</th>
              <th className="px-3 py-2.5">积分结算</th>
              <th className="px-3 py-2.5">更新时间</th>
              <th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-subtle">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-ink-muted">
                  暂无匹配任务
                </td>
              </tr>
            ) : (
              filtered.map((job) => {
                const badge = STATUS_BADGE[job.status];
                const checked = selectedIds.includes(job.id);
                return (
                  <tr key={job.id} className="hover:bg-muted/60">
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setSelectedIds((prev) =>
                            e.target.checked
                              ? [...prev, job.id]
                              : prev.filter((id) => id !== job.id)
                          )
                        }
                        className="accent-ai"
                      />
                    </td>
                    <td className="px-3 py-3 max-w-[280px]">
                      <div className="font-semibold text-ink-primary">
                        {job.input.mode} · {job.input.modelId}
                      </div>
                      <div className="truncate text-[11px] text-ink-tertiary">{job.input.prompt}</div>
                    </td>
                    <td className="px-3 py-3 text-ink-secondary">
                      <div>{projectNameById.get(job.projectId) || job.projectId}</div>
                      {job.canvasId && (
                        <button
                          type="button"
                          onClick={() =>
                            navigate(
                              `/canvases/${job.canvasId}${job.nodeId ? `?focusNode=${job.nodeId}` : ''}`
                            )
                          }
                          className="text-[11px] text-ink-link hover:underline"
                        >
                          定位画布节点 ↗
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`inline-block rounded-sm border px-2 py-0.5 text-[11px] font-semibold ${badge.cls}`}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-3 py-3 tabular-metric text-ink-primary">
                      {job.charging === 'captured'
                        ? `实扣 ${job.chargedCredits}`
                        : job.charging === 'released'
                          ? `已退回 ${job.expectedCredits}`
                          : `预占 ${job.reservedCredits || job.expectedCredits}`}
                    </td>
                    <td className="px-3 py-3 tabular-metric text-ink-muted">
                      {formatUtcDateTime(job.updatedAt)}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        {(job.status === 'queued' || job.status === 'running') && (
                          <button
                            type="button"
                            onClick={() => void handleCancel(job)}
                            className="inline-flex items-center gap-1 rounded border border-line-default px-2 py-1 text-[11px] text-ink-secondary hover:bg-hover"
                          >
                            <XCircle className="h-3 w-3" />
                            取消
                          </button>
                        )}
                        {job.status === 'failed' && job.retryable && (
                          <button
                            type="button"
                            onClick={() => void handleRetry(job)}
                            className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-[11px] text-primary-foreground"
                          >
                            <RotateCcw className="h-3 w-3" />
                            重试
                          </button>
                        )}
                        {job.status === 'succeeded' && job.outputAssetIds[0] && (
                          <a
                            href={api.getAssetContentUrl(job.outputAssetIds[0], 'download')}
                            download
                            className="inline-flex items-center gap-1 rounded border border-line-default px-2 py-1 text-[11px] text-ink-primary hover:bg-hover"
                          >
                            <Download className="h-3 w-3" />
                            下载
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
