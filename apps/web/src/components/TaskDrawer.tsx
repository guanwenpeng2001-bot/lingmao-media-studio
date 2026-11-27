import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  Download,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  X,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { api, isApiClientError } from '../api/client';
import type { Job } from '../api/types';
import { formatUtcDateTime } from '../lib/creditPools';
import { useApp } from '../state/AppContext';

export const STATUS_BADGE: Record<Job['status'], { label: string; cls: string }> = {
  queued: {
    label: '排队中',
    cls: 'bg-status-queued-bg text-status-queued-fg border-status-queued-border',
  },
  running: {
    label: '生成中',
    cls: 'bg-status-running-bg text-status-running-fg border-status-running-border',
  },
  succeeded: {
    label: '已完成',
    cls: 'bg-status-success-bg text-status-success-fg border-status-success-border',
  },
  failed: {
    label: '失败·已退分',
    cls: 'bg-status-failed-bg text-status-failed-fg border-status-failed-border',
  },
  cancelled: {
    label: '已取消·已退分',
    cls: 'bg-status-cancelled-bg text-status-cancelled-fg border-status-cancelled-border',
  },
};

export const TaskDrawer: React.FC = () => {
  const {
    taskDrawerOpen,
    setTaskDrawerOpen,
    jobs,
    activeJobCount,
    refreshJobs,
    refreshBillingState,
    upsertJob,
    pushToast,
    handleApiError,
  } = useApp();
  const navigate = useNavigate();

  const [filter, setFilter] = useState<'all' | 'active' | 'succeeded' | 'failed'>('all');
  const [confirmRunningJob, setConfirmRunningJob] = useState<Job | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);

  if (!taskDrawerOpen) return null;

  const filtered = jobs.filter((j) => {
    if (filter === 'active') return j.status === 'queued' || j.status === 'running';
    if (filter === 'succeeded') return j.status === 'succeeded';
    if (filter === 'failed') return j.status === 'failed' || j.status === 'cancelled';
    return true;
  });

  const handleCancel = async (job: Job, confirmRunning: boolean) => {
    setBusyJobId(job.id);
    try {
      const updated = await api.cancelJob(job.id, { confirmRunning });
      upsertJob(updated);
      void refreshBillingState();
      setConfirmRunningJob(null);
      pushToast({
        tone: 'success',
        title: job.status === 'queued' ? '排队任务已无损取消' : '已提交终止请求',
        description:
          updated.status === 'cancelled'
            ? `已按原扣减池退回 ${updated.expectedCredits} 积分`
            : '最终状态将以 Worker 核对结果为准',
      });
    } catch (err) {
      if (isApiClientError(err) && err.code === 'CONFIRM_RUNNING_CANCEL') {
        setConfirmRunningJob(job);
      } else {
        handleApiError(err);
        void refreshJobs();
      }
    } finally {
      setBusyJobId(null);
    }
  };

  const handleRetry = async (job: Job) => {
    setBusyJobId(job.id);
    try {
      const quote = await api.quoteGeneration(job.projectId, job.input);
      const retried = await api.retryJob(job.id, { quoteId: quote.id });
      upsertJob(retried);
      void refreshBillingState();
      pushToast({
        tone: 'success',
        title: '已重新提交任务',
        description: `本次预估 ${quote.credits} 积分，任务 ${retried.id} 已入队`,
      });
    } catch (err) {
      handleApiError(err, { contextLabel: '重试失败任务', onResume: () => void handleRetry(job) });
    } finally {
      setBusyJobId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 flex justify-end"
      style={{ backgroundColor: 'var(--bg-modal-overlay)', zIndex: 'var(--z-drawer)' }}
      onClick={() => setTaskDrawerOpen(false)}
    >
      <div
        role="dialog"
        aria-label="全局异步任务抽屉"
        className="flex h-full w-full flex-col border-l border-line-default bg-elevated shadow-modal"
        style={{ maxWidth: 'var(--task-drawer-width)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line-subtle px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-ai" />
            <h2 className="text-sm font-semibold text-ink-primary">任务中心</h2>
            <span className="tabular-metric rounded-full bg-status-running-bg px-2 py-0.5 text-[11px] font-semibold text-status-running-fg">
              进行中 {activeJobCount}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setTaskDrawerOpen(false);
                navigate('/tasks');
              }}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-link hover:bg-hover"
            >
              <span>全屏页</span>
              <ExternalLink className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => void refreshJobs()}
              title="刷新任务"
              className="rounded-md p-1.5 text-ink-tertiary hover:bg-hover hover:text-ink-primary"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setTaskDrawerOpen(false)}
              className="rounded-md p-1.5 text-ink-tertiary hover:bg-hover hover:text-ink-primary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Status Filter Tabs */}
        <div className="grid grid-cols-4 gap-1 border-b border-line-subtle px-4 py-2">
          {(
            [
              { id: 'all', label: '全部' },
              { id: 'active', label: '进行中' },
              { id: 'succeeded', label: '已完成' },
              { id: 'failed', label: '异常/取消' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setFilter(t.id)}
              className={`rounded-md py-1 text-xs font-medium ${
                filter === t.id
                  ? 'bg-nav-active font-semibold text-ink-primary'
                  : 'text-ink-tertiary hover:text-ink-primary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Running Cancel 2-Step Confirmation */}
        {confirmRunningJob && (
          <div className="mx-4 mt-3 rounded-lg border border-status-stale-border bg-status-stale-bg p-3 space-y-2 text-xs text-status-stale-fg">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">确认终止生成中的任务？</div>
                <p className="mt-0.5 opacity-90">
                  任务已在推理生成中，请求取消可能无法退还积分，最终结算以 Worker 核对为准。
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmRunningJob(null)}
                className="rounded-md bg-surface px-2.5 py-1 text-ink-primary"
              >
                暂不取消
              </button>
              <button
                type="button"
                disabled={busyJobId === confirmRunningJob.id}
                onClick={() => void handleCancel(confirmRunningJob, true)}
                className="rounded-md bg-status-failed-fg px-2.5 py-1 font-semibold text-ink-inverse"
              >
                确认请求终止
              </button>
            </div>
          </div>
        )}

        {/* Jobs List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {filtered.length === 0 ? (
            <div className="py-16 text-center text-xs text-ink-muted">当前筛选条件下暂无任务</div>
          ) : (
            filtered.map((job) => {
              const badge = STATUS_BADGE[job.status];
              const thumbAssetId = job.outputAssetIds[0] || job.input.inputAssetIds[0];
              return (
                <div
                  key={job.id}
                  className="rounded-lg border border-line-subtle bg-surface p-3 space-y-2"
                >
                  <div className="flex gap-3">
                    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md border border-line-subtle bg-subtle flex items-center justify-center">
                      {thumbAssetId ? (
                        <img
                          src={api.getAssetContentUrl(thumbAssetId, 'preview')}
                          alt={job.input.mode}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <Activity className="h-5 w-5 text-ink-muted" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-semibold text-ink-primary">
                          {job.input.mode} · {job.input.parameters.aspectRatio}
                        </span>
                        <span
                          className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}
                        >
                          {badge.label}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-ink-tertiary">
                        {job.input.prompt || '无文本提示词'}
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[11px] text-ink-muted tabular-metric">
                        <span>
                          {job.charging === 'captured'
                            ? `实扣 ${job.chargedCredits} 分`
                            : job.charging === 'released'
                              ? `已退回 ${job.expectedCredits} 分`
                              : `预占 ${job.reservedCredits || job.expectedCredits} 分`}
                        </span>
                        <span>{formatUtcDateTime(job.updatedAt)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Action row */}
                  <div className="flex items-center justify-end gap-2 border-t border-line-subtle pt-2 text-[11px]">
                    {job.canvasId && (
                      <button
                        type="button"
                        onClick={() => {
                          setTaskDrawerOpen(false);
                          navigate(
                            `/canvases/${job.canvasId}${job.nodeId ? `?focusNode=${job.nodeId}` : ''}`
                          );
                        }}
                        className="text-ink-link hover:underline mr-auto"
                      >
                        定位画布节点 ↗
                      </button>
                    )}

                    {job.status === 'queued' && (
                      <button
                        type="button"
                        disabled={busyJobId === job.id}
                        onClick={() => void handleCancel(job, false)}
                        className="flex items-center gap-1 rounded-sm border border-line-default px-2 py-1 text-ink-secondary hover:bg-hover"
                      >
                        <XCircle className="h-3 w-3" />
                        <span>无损取消并退分</span>
                      </button>
                    )}

                    {job.status === 'running' && (
                      <button
                        type="button"
                        disabled={busyJobId === job.id || job.cancelRequested}
                        onClick={() => setConfirmRunningJob(job)}
                        className="flex items-center gap-1 rounded-sm border border-status-stale-border px-2 py-1 text-status-stale-fg hover:bg-status-stale-bg disabled:opacity-50"
                      >
                        <XCircle className="h-3 w-3" />
                        <span>{job.cancelRequested ? '终止请求中' : '请求终止'}</span>
                      </button>
                    )}

                    {job.status === 'failed' && job.retryable && (
                      <button
                        type="button"
                        disabled={busyJobId === job.id}
                        onClick={() => void handleRetry(job)}
                        className="flex items-center gap-1 rounded-sm bg-primary px-2.5 py-1 font-medium text-primary-foreground hover:bg-primary-hover"
                      >
                        <RotateCcw className="h-3 w-3" />
                        <span>重新报价重试</span>
                      </button>
                    )}

                    {job.status === 'succeeded' && job.outputAssetIds[0] && (
                      <a
                        href={api.getAssetContentUrl(job.outputAssetIds[0], 'download')}
                        download
                        className="flex items-center gap-1 rounded-sm border border-line-default px-2 py-1 text-ink-primary hover:bg-hover"
                      >
                        <Download className="h-3 w-3" />
                        <span>下载成品</span>
                      </a>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
