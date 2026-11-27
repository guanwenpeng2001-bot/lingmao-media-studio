import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Copy, Crown, ExternalLink, RefreshCw, Sparkles, X } from 'lucide-react';
import { api, generateIdempotencyKey, isApiClientError } from '../api/client';
import type { Checkout, CreditPack, Plan } from '../api/types';
import { formatMinorCurrency } from '../lib/creditPools';
import { useApp } from '../state/AppContext';

export const CashierDrawer: React.FC = () => {
  const {
    session,
    cashierDrawer,
    closeCashierDrawer,
    openLoginModal,
    refreshBillingState,
    pushToast,
    handleApiError,
  } = useApp();
  const navigate = useNavigate();

  const [tab, setTab] = useState<'plans' | 'packs'>('plans');
  const [interval, setIntervalFilter] = useState<'month' | 'quarter' | 'year'>('year');
  const [plans, setPlans] = useState<Plan[]>([]);
  const [packs, setPacks] = useState<CreditPack[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [creatingCheckout, setCreatingCheckout] = useState(false);
  const [polling, setPolling] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!cashierDrawer.open) {
      setCheckout(null);
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    setTab(cashierDrawer.defaultTab);
    setLoadingCatalog(true);
    void Promise.all([api.listPlans(), api.listCreditPacks()])
      .then(([p, cp]) => {
        setPlans(p);
        setPacks(cp);
      })
      .catch((err) => handleApiError(err))
      .finally(() => setLoadingCatalog(false));
  }, [cashierDrawer.open, cashierDrawer.defaultTab, handleApiError]);

  const pollCheckoutStatus = async (checkoutId: string) => {
    setPolling(true);
    try {
      const updated = await api.getCheckout(checkoutId);
      setCheckout(updated);
      if (updated.status === 'paid') {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        await refreshBillingState();
        pushToast({
          tone: 'success',
          title: '支付已确认，权益与积分已实时到账',
        });
      } else if (updated.status === 'cancelled' || updated.status === 'expired') {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      }
    } catch (err) {
      if (isApiClientError(err) && err.status === 503) {
        handleApiError(err);
      }
    } finally {
      setPolling(false);
    }
  };

  const handleStartCheckout = async (itemType: 'subscription' | 'credit_pack', offerId: string) => {
    if (!session) {
      openLoginModal(() => {
        void handleStartCheckout(itemType, offerId);
      });
      return;
    }
    setCreatingCheckout(true);
    try {
      const created = await api.beginCheckout(
        { itemType, offerId },
        generateIdempotencyKey(`checkout-${offerId}`)
      );
      // Same-origin relative path (e.g. /billing/checkout/{checkoutId}) uses React Router navigation
      if (created.redirectUrl && created.redirectUrl.startsWith('/')) {
        closeCashierDrawer();
        navigate(created.redirectUrl);
        return;
      }
      setCheckout(created);
      if (created.status === 'paid') {
        await refreshBillingState();
      } else {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        pollTimerRef.current = setInterval(() => {
          void pollCheckoutStatus(created.id);
        }, 2500);
      }
    } catch (err) {
      handleApiError(err);
    } finally {
      setCreatingCheckout(false);
    }
  };

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  if (!cashierDrawer.open) return null;

  const filteredPlans = plans.filter((p) => p.interval === interval && p.priceMinor > 0);

  return (
    <div
      className="fixed inset-0 flex justify-end"
      style={{ backgroundColor: 'var(--bg-modal-overlay)', zIndex: 'var(--z-modal)' }}
    >
      <div
        role="dialog"
        aria-label="会员订阅与积分加购收银台"
        className="flex h-full w-full max-w-[480px] flex-col border-l border-line-default bg-elevated shadow-modal"
      >
        <div className="flex items-center justify-between border-b border-line-subtle px-5 py-4">
          <div className="flex items-center gap-2">
            <Crown className="h-5 w-5 text-vip" />
            <h2 className="text-base font-semibold text-ink-primary">升级会员 / 充值加购包</h2>
          </div>
          <button
            type="button"
            onClick={closeCashierDrawer}
            className="rounded-md p-1 text-ink-tertiary hover:bg-hover hover:text-ink-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Mode Switcher */}
        <div className="flex gap-2 border-b border-line-subtle px-5 py-3">
          <button
            type="button"
            onClick={() => setTab('plans')}
            className={`flex-1 rounded-md py-2 text-xs font-semibold ${
              tab === 'plans'
                ? 'bg-primary text-primary-foreground'
                : 'bg-subtle text-ink-secondary hover:bg-hover'
            }`}
          >
            订阅 Pro 会员
          </button>
          <button
            type="button"
            onClick={() => setTab('packs')}
            className={`flex-1 rounded-md py-2 text-xs font-semibold ${
              tab === 'packs'
                ? 'bg-primary text-primary-foreground'
                : 'bg-subtle text-ink-secondary hover:bg-hover'
            }`}
          >
            永久积分加购包
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {checkout ? (
            <div className="rounded-xl border border-line-default bg-surface p-5 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-ink-primary">订单支付核验</span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    checkout.status === 'paid'
                      ? 'bg-status-success-bg text-status-success-fg'
                      : checkout.status === 'pending'
                        ? 'bg-status-running-bg text-status-running-fg'
                        : 'bg-status-failed-bg text-status-failed-fg'
                  }`}
                >
                  {checkout.status === 'paid'
                    ? '已支付到账'
                    : checkout.status === 'pending'
                      ? '支付状态确认中...'
                      : checkout.status === 'expired'
                        ? '已超时过期'
                        : '已取消'}
                </span>
              </div>

              {checkout.mode === 'sandbox' && (
                <div className="rounded-md border border-status-stale-border bg-status-stale-bg px-3 py-2 text-xs text-status-stale-fg">
                  当前为沙箱计费模式（Sandbox），请等待服务端验签回调确认支付状态。
                </div>
              )}

              <div className="flex items-center justify-between rounded-md bg-subtle px-3 py-2 text-xs">
                <span className="text-ink-tertiary">订单编号</span>
                <div className="flex items-center gap-1.5 tabular-metric font-medium text-ink-primary">
                  <span>{checkout.id}</span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(checkout.id);
                      pushToast({ tone: 'info', title: '订单号已复制' });
                    }}
                    className="text-ink-tertiary hover:text-ink-primary"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {checkout.redirectUrl && checkout.status === 'pending' && (
                <a
                  href={checkout.redirectUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary py-2.5 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>前往收银台完成支付</span>
                </a>
              )}

              {checkout.status === 'paid' ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 rounded-md bg-status-success-bg p-3 text-xs text-status-success-fg">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>权益与积分已到账，保留的提示词与画布现场完好无损。</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const resume = cashierDrawer.onPaidResume;
                      closeCashierDrawer();
                      resume?.();
                    }}
                    className="w-full rounded-md bg-primary py-2.5 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
                  >
                    {cashierDrawer.onPaidResume ? '返回继续提交刚才的任务' : '完成并返回工作台'}
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={polling}
                    onClick={() => void pollCheckoutStatus(checkout.id)}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-line-default bg-surface py-2 text-xs font-medium text-ink-primary hover:bg-hover"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${polling ? 'animate-spin' : ''}`} />
                    <span>我已完成支付，刷新状态</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setCheckout(null)}
                    className="rounded-md bg-subtle px-3 py-2 text-xs text-ink-secondary hover:bg-hover"
                  >
                    重选方案
                  </button>
                </div>
              )}
            </div>
          ) : loadingCatalog ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-24 rounded-xl skeleton-shimmer" />
              ))}
            </div>
          ) : tab === 'plans' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-subtle p-1">
                {(
                  [
                    { id: 'month', label: '月付', badge: null },
                    { id: 'quarter', label: '季付', badge: '省20%' },
                    { id: 'year', label: '年付', badge: '4.3折' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setIntervalFilter(item.id)}
                    className={`flex items-center justify-center gap-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
                      interval === item.id
                        ? 'bg-surface text-ink-primary shadow-xs'
                        : 'text-ink-secondary hover:text-ink-primary'
                    }`}
                  >
                    <span>{item.label}</span>
                    {item.badge && (
                      <span className="rounded-xs bg-badge-discount-bg px-1 py-0.5 text-[10px] font-semibold text-badge-discount-fg">
                        {item.badge}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              {filteredPlans.length === 0 ? (
                <div className="rounded-xl border border-line-subtle bg-surface p-4 text-center text-xs text-ink-tertiary">
                  当前计费周期暂无可用套餐，请切换其他周期查看。
                </div>
              ) : (
                filteredPlans.map((plan) => (
                  <div
                    key={plan.id}
                    className="rounded-xl border-2 border-vip bg-surface p-4 space-y-3"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold text-ink-primary">{plan.name}</span>
                          <span className="rounded-xs bg-vip-bg px-1.5 py-0.5 text-[10px] font-semibold text-vip-fg">
                            推荐
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-ink-tertiary">
                          周期赠送 <strong className="tabular-metric text-ink-primary">{plan.periodCredits}</strong> 积分 ·{' '}
                          <strong className="tabular-metric text-ink-primary">{plan.maxConcurrentJobs}</strong> 并发加速槽
                        </div>
                      </div>
                      <div className="text-right tabular-metric">
                        <div className="text-xl font-bold text-ink-primary">
                          {formatMinorCurrency(plan.priceMinor, plan.currency)}
                        </div>
                        <div className="text-[11px] text-ink-muted">
                          {plan.interval === 'year' ? '/年' : plan.interval === 'quarter' ? '/季' : '/月'}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[11px] text-ink-secondary">
                      <span className="rounded-xs bg-subtle px-2 py-0.5">无水印高清导出</span>
                      <span className="rounded-xs bg-subtle px-2 py-0.5">个人商用授权</span>
                      <span className="rounded-xs bg-subtle px-2 py-0.5">
                        单画布 {plan.maxCanvasNodes ?? 200} 节点
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={creatingCheckout}
                      onClick={() => void handleStartCheckout('subscription', plan.id)}
                      className="w-full rounded-md bg-primary py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
                    >
                      {creatingCheckout ? '正在创建订单...' : '立即开通 / 升级'}
                    </button>
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-md bg-ai-soft px-3 py-2 text-xs text-ai">
                <Sparkles className="h-4 w-4 shrink-0" />
                <span>加购包积分计入「长期加购包池」，最后扣减，优先保护您的长期资产。</span>
              </div>
              {packs.map((pack) => (
                <div
                  key={pack.id}
                  className="flex items-center justify-between rounded-xl border border-line-subtle bg-surface p-4"
                >
                  <div>
                    <div className="text-sm font-semibold text-ink-primary">{pack.name}</div>
                    <div className="mt-0.5 text-xs text-ink-tertiary tabular-metric">
                      {pack.credits} 积分 · {pack.expiresInDays ? `${pack.expiresInDays} 天有效` : '永久有效'}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="tabular-metric text-base font-bold text-ink-primary">
                      {formatMinorCurrency(pack.priceMinor, pack.currency)}
                    </span>
                    <button
                      type="button"
                      disabled={creatingCheckout}
                      onClick={() => void handleStartCheckout('credit_pack', pack.id)}
                      className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
                    >
                      购买
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
