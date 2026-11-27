import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, isApiClientError } from '../api/client';
import { isTerminalJobStatus, JobEventStream, shouldApplyJobUpdate } from '../api/sse';
import type {
  BillingState,
  CanvasSummary,
  FeatureFlags,
  InsufficientCreditsDetails,
  Job,
  Model,
  Project,
  Session,
} from '../api/types';
import { applyTheme, readStoredTheme, type ThemeMode } from '../lib/theme';

export interface ToastItem {
  id: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  title: string;
  description?: string;
}

export interface InsufficientCreditsModalState {
  open: boolean;
  details: InsufficientCreditsDetails;
  contextLabel?: string;
  onResume?: () => void;
}

export interface CashierDrawerState {
  open: boolean;
  defaultTab: 'plans' | 'packs';
  onPaidResume?: () => void;
}

interface AppContextValue {
  session: Session | null;
  sessionLoading: boolean;
  features: FeatureFlags;
  isDemoMode: boolean;
  models: Model[];
  billingState: BillingState | null;
  projects: Project[];
  activeProjectId: string;
  setActiveProjectId: (id: string) => void;
  recentCanvas: CanvasSummary | null;
  jobs: Job[];
  activeJobCount: number;
  sseConnected: boolean;
  theme: ThemeMode;
  setTheme: (next: ThemeMode) => void;
  toggleTheme: () => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  loginModalOpen: boolean;
  openLoginModal: (onSuccess?: () => void) => void;
  closeLoginModal: () => void;
  onLoginSucceeded: (session: Session) => Promise<void>;
  logout: () => Promise<void>;
  taskDrawerOpen: boolean;
  setTaskDrawerOpen: (v: boolean) => void;
  shortcutsModalOpen: boolean;
  setShortcutsModalOpen: (v: boolean) => void;
  createProjectModalOpen: boolean;
  setCreateProjectModalOpen: (v: boolean) => void;
  cashierDrawer: CashierDrawerState;
  openCashierDrawer: (tab?: 'plans' | 'packs', onPaidResume?: () => void) => void;
  closeCashierDrawer: () => void;
  insufficientCreditsModal: InsufficientCreditsModalState;
  openInsufficientCreditsModal: (
    details: InsufficientCreditsDetails,
    contextLabel?: string,
    onResume?: () => void
  ) => void;
  closeInsufficientCreditsModal: () => void;
  toasts: ToastItem[];
  pushToast: (toast: Omit<ToastItem, 'id'>) => void;
  dismissToast: (id: string) => void;
  requireAuth: (action: () => void) => void;
  handleApiError: (err: unknown, options?: { contextLabel?: string; onResume?: () => void }) => void;
  refreshBillingState: () => Promise<BillingState | null>;
  refreshProjects: () => Promise<Project[]>;
  refreshJobs: () => Promise<Job[]>;
  refreshRecentCanvas: () => Promise<void>;
  upsertJob: (job: Job) => void;
}

const SIDEBAR_KEY = 'lingmao:sidebarCollapsed';

const AppContext = createContext<AppContextValue | null>(null);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [models, setModels] = useState<Model[]>([]);
  const [billingState, setBillingState] = useState<BillingState | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>('');
  const [recentCanvas, setRecentCanvas] = useState<CanvasSummary | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sseConnected, setSseConnected] = useState(false);

  const [theme, setThemeState] = useState<ThemeMode>(() => readStoredTheme());
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const pendingIntentRef = useRef<(() => void) | null>(null);
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);
  const [createProjectModalOpen, setCreateProjectModalOpen] = useState(false);
  const [cashierDrawer, setCashierDrawer] = useState<CashierDrawerState>({
    open: false,
    defaultTab: 'plans',
  });
  const [insufficientCreditsModal, setInsufficientCreditsModal] =
    useState<InsufficientCreditsModalState>({
      open: false,
      details: { required: 0, available: 0, shortfall: 0 },
    });
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const pushToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev.slice(-4), { ...toast, id }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5200);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next);
    applyTheme(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: ThemeMode = prev === 'light' ? 'dark' : 'light';
      applyTheme(next);
      return next;
    });
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setSidebarCollapsed = useCallback((v: boolean) => {
    setSidebarCollapsedState(v);
    try {
      window.localStorage.setItem(SIDEBAR_KEY, String(v));
    } catch {
      // ignore
    }
  }, []);

  const upsertJob = useCallback((incoming: Job) => {
    setJobs((prev) => {
      const idx = prev.findIndex((j) => j.id === incoming.id);
      if (idx === -1) {
        return [incoming, ...prev];
      }
      if (!shouldApplyJobUpdate(prev[idx], incoming.revision)) {
        return prev;
      }
      const next = [...prev];
      next[idx] = incoming;
      return next;
    });
  }, []);

  const refreshBillingState = useCallback(async () => {
    try {
      const st = await api.getBillingState();
      setBillingState(st);
      return st;
    } catch {
      return null;
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const page = await api.listProjects({ status: 'active', limit: 50 });
      setProjects(page.items);
      setActiveProjectId((curr) => {
        if (curr && page.items.some((p) => p.id === curr)) return curr;
        return page.items[0]?.id || '';
      });
      return page.items;
    } catch {
      return [];
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const page = await api.listJobs({ limit: 50 });
      setJobs((prev) => {
        const byId = new Map<string, Job>();
        for (const item of prev) byId.set(item.id, item);
        for (const item of page.items) {
          const curr = byId.get(item.id);
          if (shouldApplyJobUpdate(curr, item.revision)) {
            byId.set(item.id, item);
          }
        }
        return Array.from(byId.values()).sort((a, b) =>
          a.updatedAt < b.updatedAt ? 1 : -1
        );
      });
      return page.items;
    } catch {
      return [];
    }
  }, []);

  const refreshRecentCanvas = useCallback(async () => {
    try {
      const res = await api.getRecentCanvas();
      setRecentCanvas(res.canvas);
    } catch {
      setRecentCanvas(null);
    }
  }, []);

  const refreshModels = useCallback(async () => {
    try {
      const list = await api.listModels();
      setModels(list);
    } catch {
      setModels([]);
    }
  }, []);

  const hydrateAuthenticatedWorkspace = useCallback(async () => {
    await Promise.all([
      refreshModels(),
      refreshBillingState(),
      refreshProjects(),
      refreshJobs(),
      refreshRecentCanvas(),
    ]);
  }, [refreshModels, refreshBillingState, refreshProjects, refreshJobs, refreshRecentCanvas]);

  // Initial bootstrap: GET /api/v1/auth/session & GET /api/v1/models
  useEffect(() => {
    let active = true;
    const bootstrap = async () => {
      setSessionLoading(true);
      try {
        const s = await api.getSession();
        if (!active) return;
        setSession(s);
        await hydrateAuthenticatedWorkspace();
      } catch (err) {
        if (!active) return;
        setSession(null);
        if (!isApiClientError(err) || err.status !== 401) {
          // still try loading public models if available
        }
        await refreshModels();
      } finally {
        if (active) setSessionLoading(false);
      }
    };
    void bootstrap();
    return () => {
      active = false;
    };
  }, [hydrateAuthenticatedWorkspace, refreshModels]);

  // Space-scoped SSE subscription for job updates
  useEffect(() => {
    if (!session) return;
    const stream = new JobEventStream({
      onConnectionChange: setSseConnected,
      onJobEvent: (ev) => {
        void api
          .getJob(ev.jobId)
          .then((job) => {
            upsertJob(job);
            if (isTerminalJobStatus(job.status)) {
              void refreshBillingState();
              if (job.status === 'failed') {
                pushToast({
                  tone: 'warning',
                  title: '任务执行失败，积分已原路退回',
                  description: job.errorCode
                    ? `错误码 ${job.errorCode}，已退回 ${job.expectedCredits} 积分`
                    : `已退回 ${job.expectedCredits} 积分`,
                });
              }
            }
          })
          .catch(() => {
            // fallback sync will catch up
          });
      },
      onSyncFallback: async () => {
        const items = await refreshJobs();
        void refreshBillingState();
        return items.some((j) => !isTerminalJobStatus(j.status));
      },
    });
    stream.start();
    return () => {
      stream.stop();
    };
  }, [session, upsertJob, refreshBillingState, refreshJobs, pushToast]);

  const openLoginModal = useCallback((onSuccess?: () => void) => {
    pendingIntentRef.current = onSuccess || null;
    setLoginModalOpen(true);
  }, []);

  const closeLoginModal = useCallback(() => {
    setLoginModalOpen(false);
    pendingIntentRef.current = null;
  }, []);

  const onLoginSucceeded = useCallback(
    async (newSession: Session) => {
      setSession(newSession);
      setLoginModalOpen(false);
      await hydrateAuthenticatedWorkspace();
      const pending = pendingIntentRef.current;
      pendingIntentRef.current = null;
      if (pending) {
        pending();
      }
    },
    [hydrateAuthenticatedWorkspace]
  );

  const logout = useCallback(async () => {
    try {
      await api.endSession();
    } catch {
      // clear local state regardless
    }
    setSession(null);
    setBillingState(null);
    setProjects([]);
    setJobs([]);
    setRecentCanvas(null);
    pushToast({ tone: 'info', title: '已退出当前账号' });
  }, [pushToast]);

  const openCashierDrawer = useCallback(
    (defaultTab: 'plans' | 'packs' = 'plans', onPaidResume?: () => void) => {
      setCashierDrawer({ open: true, defaultTab, onPaidResume });
    },
    []
  );

  const closeCashierDrawer = useCallback(() => {
    setCashierDrawer((prev) => ({ ...prev, open: false, onPaidResume: undefined }));
  }, []);

  const openInsufficientCreditsModal = useCallback(
    (details: InsufficientCreditsDetails, contextLabel?: string, onResume?: () => void) => {
      setInsufficientCreditsModal({
        open: true,
        details,
        contextLabel,
        onResume,
      });
    },
    []
  );

  const closeInsufficientCreditsModal = useCallback(() => {
    setInsufficientCreditsModal((prev) => ({ ...prev, open: false, onResume: undefined }));
  }, []);

  const requireAuth = useCallback(
    (action: () => void) => {
      if (session) {
        action();
      } else {
        openLoginModal(action);
      }
    },
    [session, openLoginModal]
  );

  const handleApiError = useCallback(
    (err: unknown, options?: { contextLabel?: string; onResume?: () => void }) => {
      if (!isApiClientError(err)) {
        pushToast({
          tone: 'error',
          title: '操作失败',
          description: err instanceof Error ? err.message : '请稍后重试',
        });
        return;
      }

      if (err.status === 401 || err.code === 'UNAUTHENTICATED') {
        pushToast({
          tone: 'warning',
          title: '登录状态已失效',
          description: '本地编辑内容已保护，请重新登录后继续。',
        });
        openLoginModal(options?.onResume);
        return;
      }

      if (err.status === 404 && err.code === 'FEATURE_DISABLED') {
        pushToast({
          tone: 'info',
          title: '该进阶功能将在下一阶段开放',
          description: '当前处于 P0 首发版本，本次操作未扣除任何积分。',
        });
        return;
      }

      if (err.status === 409 && err.code === 'QUOTE_USED') {
        const d = err.details || {};
        const existingJobId =
          typeof d.existingJobId === 'string' && d.existingJobId.length > 0
            ? d.existingJobId
            : typeof d.jobId === 'string' && d.jobId.length > 0
              ? d.jobId
              : null;
        pushToast({
          tone: 'info',
          title: '该报价已提交为任务，已定位到原任务进度',
          description: existingJobId ? `原任务编号：${existingJobId}` : '请前往任务抽屉查看最新进度。',
        });
        if (existingJobId) {
          void api
            .getJob(existingJobId)
            .then((existingJob) => {
              upsertJob(existingJob);
              setTaskDrawerOpen(true);
            })
            .catch(() => {
              setTaskDrawerOpen(true);
            });
        } else {
          setTaskDrawerOpen(true);
        }
        return;
      }

      if (err.status === 409 && err.code === 'INSUFFICIENT_CREDITS') {
        const d = err.details || {};
        const available =
          typeof d.available === 'number'
            ? d.available
            : billingState?.entitlements.availableCredits ?? 0;
        const required = typeof d.required === 'number' ? d.required : available + 10;
        const shortfall =
          typeof d.shortfall === 'number' ? d.shortfall : Math.max(0, required - available);
        openInsufficientCreditsModal(
          { required, available, shortfall },
          options?.contextLabel,
          options?.onResume
        );
        return;
      }

      if (err.status === 403 && err.code === 'ENTITLEMENT_REQUIRED') {
        pushToast({
          tone: 'warning',
          title: '当前会员套餐暂不支持该能力',
          description: `${err.message}，可切换可用平替模型或升级 Pro 解锁。`,
        });
        openCashierDrawer('plans', options?.onResume);
        return;
      }

      if (err.status === 403 && err.code === 'READ_ONLY') {
        pushToast({
          tone: 'warning',
          title: '当前为只读视图',
          description: '请点击「复制为我的画布」克隆副本后再编辑或运行。',
        });
        return;
      }

      if (err.status === 422 && err.code === 'CONTENT_BLOCKED') {
        pushToast({
          tone: 'error',
          title: '内容安全前置拦截（未扣除积分）',
          description: err.message || '请修改敏感描述或更换合规商品原图后重试。',
        });
        return;
      }

      if (err.status === 429) {
        const retryMsg = err.retryAfterSeconds
          ? `请在 ${err.retryAfterSeconds} 秒后重试`
          : '请稍后重试或升级 Pro 解锁 4 并发加速槽';
        pushToast({
          tone: 'warning',
          title: '并发或请求频率达到上限',
          description: `${err.message}（${retryMsg}）`,
        });
        return;
      }

      if (err.status === 503) {
        pushToast({
          tone: 'warning',
          title: '上游服务维护中',
          description: err.message || '受影响通道暂不可用，可切换其他可用模型继续创作。',
        });
        return;
      }

      pushToast({
        tone: 'error',
        title: `操作失败 (${err.code})`,
        description: `${err.message}${err.requestId ? ` · Req: ${err.requestId}` : ''}`,
      });
    },
    [
      billingState,
      openCashierDrawer,
      openInsufficientCreditsModal,
      openLoginModal,
      pushToast,
      upsertJob,
    ]
  );

  // Global keyboard shortcut '?' for shortcuts dialog
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (!isInput && e.key === '?') {
        e.preventDefault();
        setShortcutsModalOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const features = useMemo<FeatureFlags>(() => {
    return {
      virtual_tryon: Boolean(session?.features?.virtual_tryon),
      org_collaboration: Boolean(session?.features?.org_collaboration),
      audio_studio: Boolean(session?.features?.audio_studio),
    };
  }, [session]);

  const isDemoMode = useMemo(() => {
    if (session?.mode === 'sandbox') return true;
    if (models.some((m) => m.execution === 'demo')) return true;
    if (billingState?.checkoutMode === 'sandbox') return true;
    return false;
  }, [session, models, billingState]);

  const activeJobCount = useMemo(
    () => jobs.filter((j) => j.status === 'queued' || j.status === 'running').length,
    [jobs]
  );

  const value: AppContextValue = {
    session,
    sessionLoading,
    features,
    isDemoMode,
    models,
    billingState,
    projects,
    activeProjectId,
    setActiveProjectId,
    recentCanvas,
    jobs,
    activeJobCount,
    sseConnected,
    theme,
    setTheme,
    toggleTheme,
    sidebarCollapsed,
    setSidebarCollapsed,
    loginModalOpen,
    openLoginModal,
    closeLoginModal,
    onLoginSucceeded,
    logout,
    taskDrawerOpen,
    setTaskDrawerOpen,
    shortcutsModalOpen,
    setShortcutsModalOpen,
    createProjectModalOpen,
    setCreateProjectModalOpen,
    cashierDrawer,
    openCashierDrawer,
    closeCashierDrawer,
    insufficientCreditsModal,
    openInsufficientCreditsModal,
    closeInsufficientCreditsModal,
    toasts,
    pushToast,
    dismissToast,
    requireAuth,
    handleApiError,
    refreshBillingState,
    refreshProjects,
    refreshJobs,
    refreshRecentCanvas,
    upsertJob,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
