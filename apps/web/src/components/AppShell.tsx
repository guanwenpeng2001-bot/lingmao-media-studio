import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Coins,
  Compass,
  Crown,
  FolderKanban,
  HelpCircle,
  Images,
  Layers,
  LogIn,
  LogOut,
  Moon,
  Plus,
  ShoppingBag,
  Sparkles,
  Sun,
  Users,
  X,
  AlertTriangle,
  ArrowRight,
  Menu,
} from 'lucide-react';
import { useApp } from '../state/AppContext';
import { formatUtcDate, getStorageAlertLevel, summarizeCreditPools } from '../lib/creditPools';

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const {
    session,
    features,
    isDemoMode,
    billingState,
    recentCanvas,
    activeJobCount,
    theme,
    toggleTheme,
    sidebarCollapsed,
    setSidebarCollapsed,
    openLoginModal,
    logout,
    setTaskDrawerOpen,
    setShortcutsModalOpen,
    setCreateProjectModalOpen,
    openCashierDrawer,
  } = useApp();

  const location = useLocation();
  const navigate = useNavigate();
  const [promoDismissed, setPromoDismissed] = useState(false);
  const [poolPopoverOpen, setPoolPopoverOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isCanvasEditor = /^\/canvases\/[^/]+$/.test(location.pathname);

  // Auto-collapse sidebar when entering full-screen infinite canvas editor
  useEffect(() => {
    if (isCanvasEditor && !sidebarCollapsed) {
      setSidebarCollapsed(true);
    }
  }, [isCanvasEditor, sidebarCollapsed, setSidebarCollapsed]);

  const effectiveCollapsed = isCanvasEditor ? true : sidebarCollapsed;

  const entitlements = billingState?.entitlements;
  const pools = summarizeCreditPools(entitlements?.walletLots || []);
  const totalAvailable = entitlements?.availableCredits ?? 0;
  const reservedCredits = entitlements?.heldCredits ?? 0;
  const totalPoolSum = Math.max(
    1,
    pools.reduce((acc, p) => acc + p.available, 0)
  );
  const isPro =
    billingState?.subscription?.state === 'active' &&
    Boolean(billingState.subscription.planId && !billingState.subscription.planId.includes('free'));
  const storageAlert = getStorageAlertLevel(entitlements);

  const navGroups = [
    {
      label: '核心创作与灵感',
      items: [
        { to: '/explore', label: '首页 / 探索模板', icon: Compass, badge: null },
        { to: '/studio', label: '快捷创作区', icon: Sparkles, badge: null },
        { to: '/canvases', label: '无限画布', icon: Layers, badge: { text: 'Hot', cls: 'bg-badge-hot-bg text-badge-hot-fg' } },
      ],
    },
    {
      label: '垂直行业工作室',
      items: [
        {
          to: '/ecommerce',
          label: '电商营销工作室',
          icon: ShoppingBag,
          badge: { text: 'New', cls: 'bg-badge-new-bg text-badge-new-fg' },
        },
      ],
    },
    {
      label: '资产与运营管理',
      items: [
        { to: '/projects', label: '项目管理', icon: FolderKanban, badge: null },
        { to: '/assets', label: '资产中心', icon: Images, badge: null },
        { to: '/tasks', label: '任务管理', icon: Activity, badge: null },
        { to: '/billing', label: '用量与会员', icon: Coins, badge: null },
        ...(features.org_collaboration
          ? [{ to: '/org', label: '组织管理', icon: Users, badge: null }]
          : []),
      ],
    },
  ];

  const isRouteActive = (to: string) => {
    if (to === '/canvases') {
      return location.pathname === '/canvases' || location.pathname.startsWith('/canvases/');
    }
    if (to === '/billing') {
      return location.pathname === '/billing' || location.pathname.startsWith('/billing/');
    }
    return location.pathname === to;
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas text-ink-primary">
      {/* Mobile overlay */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-30 md:hidden"
          style={{ backgroundColor: 'var(--bg-modal-overlay)' }}
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Left Collapsible Sidebar */}
      <aside
        data-testid="app-sidebar"
        className={`fixed md:static inset-y-0 left-0 z-30 flex flex-col border-r border-line-subtle bg-sidebar transition-all duration-150 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
        style={{
          width: effectiveCollapsed ? 'var(--sidebar-collapsed-width)' : 'var(--sidebar-width)',
        }}
      >
        {/* Brand Header */}
        <div
          className="flex items-center justify-between border-b border-line-subtle px-3 shrink-0"
          style={{ height: 'var(--topbar-height)' }}
        >
          <Link
            to="/explore"
            className="flex items-center gap-2.5 overflow-hidden text-ink-primary no-underline"
          >
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-bold text-ink-inverse"
              style={{ background: 'var(--accent-ai-gradient)' }}
            >
              灵猫
            </span>
            {!effectiveCollapsed && (
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold leading-tight">灵猫工作台</div>
                <div className="truncate text-[11px] text-ink-muted">Lingmao Studio</div>
              </div>
            )}
          </Link>
          {!effectiveCollapsed && (
            <button
              type="button"
              onClick={() => setSidebarCollapsed(true)}
              title="收起侧边栏"
              className="hidden md:flex h-7 w-7 items-center justify-center rounded-md text-ink-tertiary hover:bg-hover hover:text-ink-primary"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Navigation Groups */}
        <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
          {navGroups.map((group) => (
            <div key={group.label}>
              {!effectiveCollapsed && (
                <div className="mb-1.5 px-2.5 text-[11px] font-medium text-ink-muted">
                  {group.label}
                </div>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = isRouteActive(item.to);
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      onClick={() => setMobileMenuOpen(false)}
                      title={effectiveCollapsed ? item.label : undefined}
                      className={`flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors ${
                        active
                          ? 'bg-nav-active font-semibold text-ink-primary'
                          : 'text-ink-secondary hover:bg-hover hover:text-ink-primary'
                      } ${effectiveCollapsed ? 'justify-center px-0' : ''}`}
                    >
                      <Icon
                        className={`h-[18px] w-[18px] shrink-0 ${active ? 'text-ai' : 'text-ink-tertiary'}`}
                      />
                      {!effectiveCollapsed && (
                        <>
                          <span className="truncate flex-1">{item.label}</span>
                          {item.badge && (
                            <span
                              className={`rounded-xs px-1.5 py-0.5 text-[10px] font-semibold leading-none ${item.badge.cls}`}
                            >
                              {item.badge.text}
                            </span>
                          )}
                        </>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Bottom Account & 3-Credit-Pool Card */}
        <div className="relative border-t border-line-subtle p-2.5 shrink-0">
          {!effectiveCollapsed ? (
            <div className="rounded-lg border border-line-subtle bg-surface p-3 shadow-xs">
              {session ? (
                <>
                  {/* Account Space & Tier */}
                  <div className="flex items-center justify-between gap-1 mb-2">
                    <button
                      type="button"
                      onClick={() => setPoolPopoverOpen((v) => !v)}
                      data-testid="credit-pools-trigger"
                      className="flex items-center gap-1.5 text-xs font-medium text-ink-secondary hover:text-ink-primary"
                    >
                      <span className="rounded-xs bg-vip-bg px-1.5 py-0.5 text-[10px] font-semibold text-vip-fg">
                        {isPro ? 'Pro' : 'Free'}
                      </span>
                      <span>个人账户</span>
                      <span className="rounded-xs bg-subtle px-1.5 py-0.5 text-[10px] text-ink-tertiary">
                        3池
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => openCashierDrawer('packs')}
                      className="rounded-full bg-subtle px-2 py-0.5 text-[11px] font-medium text-ink-primary hover:bg-hover"
                    >
                      + 充值/加购
                    </button>
                  </div>

                  {/* Available & Reserved Credits */}
                  <div className="flex items-baseline justify-between mb-1.5">
                    <div className="tabular-metric text-lg font-bold text-ink-primary">
                      {totalAvailable}{' '}
                      <span className="text-xs font-normal text-ink-tertiary">积分</span>
                    </div>
                    {reservedCredits > 0 && (
                      <span
                        data-testid="reserved-credits-badge"
                        className="tabular-metric text-[11px] text-status-running-fg"
                      >
                        冻结 {reservedCredits}
                      </span>
                    )}
                  </div>

                  {/* Strict 3-Pool Priority Micro Bar: 限时赠分 -> 周期订阅 -> 长期加购 */}
                  <div
                    data-testid="credit-pool-bar"
                    className="flex h-1.5 w-full overflow-hidden rounded-full bg-subtle mb-2"
                    title="扣减顺序：限时赠分池 → 周期订阅池 → 长期加购包池"
                  >
                    {pools.map((pool) => {
                      const pct = pool.available > 0 ? Math.max(4, (pool.available / totalPoolSum) * 100) : 0;
                      return (
                        <div
                          key={pool.source}
                          data-pool-source={pool.source}
                          className={pool.bgClass}
                          style={{ width: `${pct}%` }}
                        />
                      );
                    })}
                  </div>

                  {/* Compact inline 3-pool legend strictly ordered */}
                  <div
                    data-testid="credit-pool-list"
                    className="grid grid-cols-3 gap-1 text-[10px] text-ink-tertiary mb-2.5"
                  >
                    {pools.map((pool) => (
                      <div
                        key={pool.source}
                        data-testid={`credit-pool-${pool.source}`}
                        className="truncate"
                      >
                        <span className={`inline-block h-1.5 w-1.5 rounded-full mr-1 ${pool.bgClass}`} />
                        <span>{pool.shortLabel}</span>
                        <div className="tabular-metric font-semibold text-ink-primary">
                          {pool.available}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Upgrade / Renew Pro CTA */}
                  <button
                    type="button"
                    onClick={() => openCashierDrawer('plans')}
                    className="mb-2.5 flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-semibold text-ink-inverse transition-opacity hover:opacity-90"
                    style={{ background: 'var(--accent-vip-gradient)' }}
                  >
                    <Crown className="h-3.5 w-3.5" />
                    <span>{isPro ? '续费 / 加购积分' : '开通 / 升级 Pro'}</span>
                  </button>

                  {/* User Row */}
                  <div className="flex items-center justify-between border-t border-line-subtle pt-2 text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ai-soft text-[11px] font-semibold text-ai">
                        {session.displayName.slice(0, 1)}
                      </div>
                      <span className="truncate text-ink-secondary">{session.displayName}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void logout()}
                      title="退出登录"
                      className="rounded p-1 text-ink-tertiary hover:bg-hover hover:text-ink-primary"
                    >
                      <LogOut className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </>
              ) : (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-ink-primary">登录领取新客体验积分</div>
                  <div className="text-[11px] text-ink-tertiary">
                    免登可浏览探索模板与套餐，登录后开启多模态生成与画布保存。
                  </div>
                  <button
                    type="button"
                    onClick={() => openLoginModal()}
                    className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary-hover"
                  >
                    <LogIn className="h-3.5 w-3.5" />
                    <span>手机号验证码登录</span>
                  </button>
                </div>
              )}

              {/* Pool Detail Popover */}
              {poolPopoverOpen && session && (
                <div className="absolute bottom-full left-2.5 right-2.5 mb-2 rounded-lg border border-line-default bg-elevated p-3 shadow-popover z-50">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-ink-primary">多额度池扣减优先级</span>
                    <button
                      type="button"
                      onClick={() => setPoolPopoverOpen(false)}
                      className="text-ink-muted hover:text-ink-primary"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="space-y-2 text-xs">
                    {pools.map((p, idx) => (
                      <div
                        key={p.source}
                        className="flex items-center justify-between rounded-md bg-subtle px-2 py-1.5"
                      >
                        <div>
                          <div className="font-medium text-ink-primary">
                            {idx + 1}. {p.label}
                          </div>
                          <div className="text-[11px] text-ink-tertiary">
                            到期：{formatUtcDate(p.nearestExpiresAt)}
                          </div>
                        </div>
                        <div className="text-right tabular-metric">
                          <div className="font-semibold text-ink-primary">{p.available} 分</div>
                          {p.held > 0 && (
                            <div className="text-[10px] text-status-running-fg">冻结 {p.held}</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 text-[11px] text-ink-muted">
                    消费严格按 限时赠分 → 周期订阅 → 长期加购 顺序扣减，任务失败按原池退还。
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              {session ? (
                <button
                  type="button"
                  onClick={() => openCashierDrawer('packs')}
                  title={`可用 ${totalAvailable} 积分（点击充值）`}
                  className="flex h-9 w-9 flex-col items-center justify-center rounded-md bg-subtle text-[10px] font-bold tabular-metric text-ink-primary hover:bg-hover"
                >
                  <Coins className="h-3.5 w-3.5 text-ai" />
                  <span>{totalAvailable}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => openLoginModal()}
                  title="登录"
                  className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground"
                >
                  <LogIn className="h-4 w-4" />
                </button>
              )}
            </div>
          )}

          {/* Theme Switcher + Shortcuts + Expand */}
          <div
            className={`mt-2 flex items-center ${
              effectiveCollapsed ? 'flex-col gap-1.5' : 'justify-between px-0.5'
            }`}
          >
            <button
              type="button"
              data-testid="theme-toggle"
              onClick={toggleTheme}
              title={theme === 'light' ? '切换深色沉浸模式' : '切换浅色专业模式'}
              className="flex h-7 items-center gap-1 rounded-md border border-line-subtle bg-surface px-2 text-xs text-ink-secondary hover:bg-hover hover:text-ink-primary"
            >
              {theme === 'light' ? (
                <>
                  <Sun className="h-3.5 w-3.5 text-vip" />
                  {!effectiveCollapsed && <span>浅色</span>}
                </>
              ) : (
                <>
                  <Moon className="h-3.5 w-3.5 text-ai" />
                  {!effectiveCollapsed && <span>深色</span>}
                </>
              )}
            </button>
            <div className={`flex items-center gap-1 ${effectiveCollapsed ? 'flex-col' : ''}`}>
              <button
                type="button"
                onClick={() => setShortcutsModalOpen(true)}
                title="快捷键帮助 (?)"
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-tertiary hover:bg-hover hover:text-ink-primary"
              >
                <HelpCircle className="h-4 w-4" />
              </button>
              {effectiveCollapsed && (
                <button
                  type="button"
                  onClick={() => setSidebarCollapsed(false)}
                  title="展开侧边栏"
                  className="hidden md:flex h-7 w-7 items-center justify-center rounded-md text-ink-tertiary hover:bg-hover hover:text-ink-primary"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Conditional Demo / Sandbox Mode Banner */}
        {isDemoMode && (
          <div
            data-testid="demo-mode-banner"
            className="flex items-center justify-center gap-2 border-b border-status-stale-border bg-status-stale-bg px-4 py-1.5 text-xs font-medium text-status-stale-fg shrink-0"
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>
              当前为联调演示 / 沙箱计费模式（Demo / Sandbox），用于验证完整流程与账本状态，非真实扣款或生产渲染。
            </span>
          </div>
        )}

        {/* Dismissible Promo Banner (for Free / Guest users) */}
        {!promoDismissed && !isPro && !isCanvasEditor && (
          <div
            className="flex items-center justify-between px-4 text-xs shrink-0"
            style={{
              height: 'var(--promo-bar-height)',
              background: 'var(--bg-banner-promo)',
              color: 'var(--banner-promo-fg)',
            }}
          >
            <div className="flex items-center gap-2 truncate">
              <span className="rounded-xs bg-badge-discount-bg px-1.5 py-0.5 text-[11px] font-semibold text-badge-discount-fg">
                会员4.3折
              </span>
              <span className="truncate">
                升级 Pro 年卡立享 4 并发加速槽、200 节点无限画布、无水印高清导出与个人商用授权
              </span>
              <button
                type="button"
                onClick={() => openCashierDrawer('plans')}
                className="ml-1 shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold underline"
                style={{ backgroundColor: 'var(--banner-promo-chip-bg)' }}
              >
                立即查看 →
              </button>
            </div>
            <button
              type="button"
              onClick={() => setPromoDismissed(true)}
              aria-label="关闭活动横幅"
              className="ml-2 rounded p-0.5 opacity-80 hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Storage Capacity >=85% / 100% Warning Banner */}
        {storageAlert.level !== 'normal' && (
          <div
            data-testid="storage-alert-banner"
            className={`flex items-center justify-between border-b px-4 py-1.5 text-xs shrink-0 ${
              storageAlert.level === 'full'
                ? 'border-status-failed-border bg-status-failed-bg text-status-failed-fg'
                : 'border-status-stale-border bg-status-stale-bg text-status-stale-fg'
            }`}
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>
                {storageAlert.level === 'full'
                  ? `云端存储空间已满（${storageAlert.percent}%），新上传已暂停；现有资产仍可正常查看、下载与清理。`
                  : `云端存储容量已使用 ${storageAlert.percent}%，建议及时清理回收站或升级 Pro 扩容。`}
              </span>
            </div>
            <Link to="/assets?tab=trash" className="font-semibold underline shrink-0">
              前往清理回收站
            </Link>
          </div>
        )}

        {/* Top Header Bar (hidden inside full-screen canvas editor which renders its own floating HUD) */}
        {!isCanvasEditor && (
          <header
            className="flex items-center justify-between border-b border-line-subtle bg-surface px-4 shrink-0"
            style={{ height: 'var(--topbar-height)' }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                className="md:hidden flex h-8 w-8 items-center justify-center rounded-md text-ink-secondary hover:bg-hover"
                aria-label="打开导航菜单"
              >
                <Menu className="h-5 w-5" />
              </button>
              <span className="text-sm font-semibold text-ink-primary truncate">
                {getPageTitle(location.pathname)}
              </span>
            </div>

            <div className="flex items-center gap-2">
              {recentCanvas && (
                <button
                  type="button"
                  onClick={() => navigate(`/canvases/${recentCanvas.id}`)}
                  className="hidden sm:flex h-8 max-w-[220px] items-center gap-1.5 rounded-full bg-subtle px-3 text-xs font-medium text-ink-primary hover:bg-hover"
                  title={`继续上次：${recentCanvas.name}`}
                >
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ai" />
                  <span className="truncate">继续上次：{recentCanvas.name}</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  if (!session) {
                    openLoginModal(() => setCreateProjectModalOpen(true));
                  } else {
                    setCreateProjectModalOpen(true);
                  }
                }}
                className="flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary-hover"
              >
                <Plus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">新建项目/画布</span>
              </button>

              <button
                type="button"
                onClick={() => openCashierDrawer('plans')}
                className="hidden lg:flex h-8 items-center gap-1 rounded-md border border-line-subtle bg-vip-bg px-2.5 text-xs font-semibold text-vip-fg hover:opacity-90"
              >
                <Crown className="h-3.5 w-3.5" />
                <span>{isPro ? 'Pro 会员' : '开通会员'}</span>
              </button>

              <button
                type="button"
                data-testid="open-task-drawer-btn"
                onClick={() => setTaskDrawerOpen(true)}
                className="flex h-8 items-center gap-1.5 rounded-md border border-line-subtle bg-surface px-2.5 text-xs font-medium text-ink-primary hover:bg-hover"
              >
                <Activity className="h-3.5 w-3.5 text-ai" />
                <span>任务</span>
                <span
                  data-testid="active-job-count"
                  className={`tabular-metric rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none ${
                    activeJobCount > 0
                      ? 'bg-status-running-bg text-status-running-fg'
                      : 'bg-subtle text-ink-tertiary'
                  }`}
                >
                  {activeJobCount}
                </span>
              </button>
            </div>
          </header>
        )}

        {/* Route Viewport */}
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
};

function getPageTitle(pathname: string): string {
  if (pathname.startsWith('/explore')) return '探索广场与行业模板库';
  if (pathname.startsWith('/studio')) return '快捷创作区';
  if (pathname.startsWith('/canvases')) return '无限画布列表';
  if (pathname.startsWith('/ecommerce')) return '电商营销工作室';
  if (pathname.startsWith('/projects')) return '项目管理';
  if (pathname.startsWith('/assets')) return '资产与主体中心';
  if (pathname.startsWith('/tasks')) return '全局异步任务管理';
  if (pathname.startsWith('/billing')) return '会员订阅与用量管理';
  if (pathname.startsWith('/org')) return '组织与空间管理';
  return '灵猫多模态内容生成工作台';
}
