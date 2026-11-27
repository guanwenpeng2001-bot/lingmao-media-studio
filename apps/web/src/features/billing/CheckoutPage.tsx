import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Copy,
  Crown,
  ExternalLink,
  FlaskConical,
  LogIn,
  ReceiptText,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { api, isApiClientError } from '../../api/client';
import type { BillingState, Checkout, CreditPack, LedgerEntry, Plan } from '../../api/types';
import { formatMinorCurrency, formatUtcDate, formatUtcDateTime } from '../../lib/creditPools';
import { useApp } from '../../state/AppContext';

type CheckoutErrorKind =
  | 'unauthenticated'
  | 'feature_disabled'
  | 'not_found'
  | 'cancelled'
  | 'expired'
  | 'generic';

interface CheckoutErrorState {
  kind: CheckoutErrorKind;
  code: string;
  message: string;
}

export const CheckoutPage: React.FC = () => {
  const { checkoutId = '' } = useParams();
  const navigate = useNavigate();
  const {
    billingState,
    openLoginModal,
    openCashierDrawer,
    refreshBillingState,
    pushToast,
  } = useApp();

  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [errorState, setErrorState] = useState<CheckoutErrorState | null>(null);
  const [responseLostHint, setResponseLostHint] = useState<string | null>(null);

  const [plans, setPlans] = useState<Plan[]>([]);
  const [packs, setPacks] = useState<CreditPack[]>([]);
  const [latestBilling, setLatestBilling] = useState<BillingState | null>(null);
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);

  const loadBillingEvidence = useCallback(async () => {
    const [freshState, ledgerPage] = await Promise.all([
      refreshBillingState(),
      api.getLedger({ limit: 20 }).catch(() => ({ items: [] as LedgerEntry[], nextCursor: null })),
    ]);
    if (freshState) setLatestBilling(freshState);
    setLedgerEntries(ledgerPage.items);
  }, [refreshBillingState]);

  const mapErrorToState = useCallback((err: unknown): CheckoutErrorState => {
    if (isApiClientError(err)) {
      if (err.status === 401 || err.code === 'UNAUTHENTICATED') {
        return {
          kind: 'unauthenticated',
          code: err.code,
          message: '当前未登录或会话已失效，请登录后继续查看并确认订单。',
        };
      }
      if (err.status === 404 && err.code === 'FEATURE_DISABLED') {
        return {
          kind: 'feature_disabled',
          code: err.code,
          message: '当前部署环境未启用沙盒支付确认功能，不展示模拟支付入口。',
        };
      }
      if (err.status === 404 || err.code === 'NOT_FOUND') {
        return {
          kind: 'not_found',
          code: err.code,
          message: '订单不存在或无权访问（跨空间或非本人订单不可见）。',
        };
      }
      if (err.status === 409 && err.code === 'CHECKOUT_CANCELLED') {
        return {
          kind: 'cancelled',
          code: err.code,
          message: '该订单已取消，无法继续确认支付，请重新选购套餐或积分包。',
        };
      }
      if (err.status === 410 || err.code === 'CHECKOUT_EXPIRED') {
        return {
          kind: 'expired',
          code: err.code,
          message: '该订单已过期且未支付，请返回套餐页重新创建订单。',
        };
      }
      return {
        kind: 'generic',
        code: err.code,
        message: err.message || '订单查询或确认失败，请稍后重试。',
      };
    }
    return {
      kind: 'generic',
      code: 'NETWORK_ERROR',
      message: err instanceof Error ? err.message : '网络异常，请刷新订单状态确认结果。',
    };
  }, []);

  // Read-only query on mount and refresh (NEVER auto-confirms!)
  const loadCheckout = useCallback(async () => {
    if (!checkoutId) {
      setErrorState({
        kind: 'not_found',
        code: 'NOT_FOUND',
        message: '缺少有效的订单编号。',
      });
      setLoading(false);
      return;
    }
    setLoading(true);
    setErrorState(null);
    setResponseLostHint(null);
    try {
      const data = await api.getCheckoutSession(checkoutId);
      setCheckout(data);
      if (data.status === 'paid') {
        await loadBillingEvidence();
      }
    } catch (err) {
      const mapped = mapErrorToState(err);
      setErrorState(mapped);
      if (mapped.kind === 'unauthenticated') {
        openLoginModal(() => {
          void loadCheckout();
        });
      }
    } finally {
      setLoading(false);
    }
  }, [checkoutId, loadBillingEvidence, mapErrorToState, openLoginModal]);

  useEffect(() => {
    void loadCheckout();
  }, [loadCheckout]);

  useEffect(() => {
    void api.listPlans().then(setPlans).catch(() => {});
    void api.listCreditPacks().then(setPacks).catch(() => {});
  }, []);

  const matchedPlan = useMemo(
    () => (checkout?.itemType === 'subscription' ? plans.find((p) => p.id === checkout.offerId) : undefined),
    [checkout, plans]
  );
  const matchedPack = useMemo(
    () => (checkout?.itemType === 'credit_pack' ? packs.find((p) => p.id === checkout.offerId) : undefined),
    [checkout, packs]
  );

  const isExpiredByClock = useMemo(() => {
    if (!checkout?.expiresAt) return false;
    const expMs = Date.parse(checkout.expiresAt);
    return Number.isFinite(expMs) && Date.now() > expMs;
  }, [checkout?.expiresAt]);

  // Paid orders remain valid & readable even past original expiresAt
  const isPaid = checkout?.status === 'paid';
  const isCancelled = checkout?.status === 'cancelled';
  const isPendingExpired = checkout?.status === 'expired' || (checkout?.status === 'pending' && isExpiredByClock);
  const canSandboxConfirm =
    Boolean(checkout) &&
    checkout?.mode === 'sandbox' &&
    checkout?.status === 'pending' &&
    !isExpiredByClock &&
    errorState?.kind !== 'feature_disabled';

  const handleSandboxConfirm = async () => {
    if (!checkout || confirming || !canSandboxConfirm) return;
    setConfirming(true);
    setErrorState(null);
    setResponseLostHint(null);
    try {
      await api.sandboxConfirmCheckout(checkout.id);
      // Re-read order, billing/state, and billing/ledger per API_CONTRACT
      const [refreshedOrder] = await Promise.all([
        api.getCheckoutSession(checkout.id),
        loadBillingEvidence(),
      ]);
      setCheckout(refreshedOrder);
      pushToast({
        tone: 'success',
        title: '沙盒模拟支付已确认到账',
        description: '会员权益与本次赠分已实时同步。',
      });
    } catch (err) {
      if (isApiClientError(err)) {
        const mapped = mapErrorToState(err);
        setErrorState(mapped);
        if (mapped.kind === 'unauthenticated') {
          openLoginModal(() => {
            void loadCheckout();
          });
        } else if (
          mapped.kind === 'cancelled' ||
          mapped.kind === 'expired' ||
          err.code === 'INVALID_IDEMPOTENCY_KEY' ||
          err.code === 'IDEMPOTENCY_CONFLICT'
        ) {
          // Re-query latest order status for consistency
          void api
            .getCheckoutSession(checkout.id)
            .then((fresh) => {
              setCheckout(fresh);
              if (fresh.status === 'paid') {
                setErrorState(null);
                void loadBillingEvidence();
              }
            })
            .catch(() => {});
        }
      } else {
        // Confirmation response lost: re-query original order first; only allow retry if still pending
        try {
          const fresh = await api.getCheckoutSession(checkout.id);
          setCheckout(fresh);
          if (fresh.status === 'paid') {
            await loadBillingEvidence();
            pushToast({
              tone: 'success',
              title: '订单已确认支付到账',
              description: '已通过核单同步最新权益与账本流水。',
            });
          } else if (fresh.status === 'pending') {
            setResponseLostHint('确认请求响应超时，核单确认订单仍为待支付状态，可重新点击同一笔确认按钮。');
          }
        } catch (queryErr) {
          setErrorState(mapErrorToState(queryErr));
        }
      }
    } finally {
      setConfirming(false);
    }
  };

  const activeBilling = latestBilling || billingState;
  const orderLedgerGrant = useMemo(() => {
    if (!checkout) return null;
    return (
      ledgerEntries.find((e) => e.orderId === checkout.id && e.kind === 'grant') ||
      ledgerEntries.find((e) => e.orderId === checkout.id) ||
      null
    );
  }, [checkout, ledgerEntries]);

  return (
    <div className="mx-auto max-w-[760px] p-6 space-y-5">
      {/* Sandbox non-charge explicit banner */}
      {(checkout?.mode === 'sandbox' || !checkout) && errorState?.kind !== 'feature_disabled' && (
        <div
          data-testid="sandbox-notice-banner"
          className="flex items-center gap-2.5 rounded-xl border border-status-stale-border bg-status-stale-bg px-4 py-3 text-xs font-medium text-status-stale-fg"
        >
          <FlaskConical className="h-4 w-4 shrink-0" />
          <span>沙盒支付，本次不扣款 — 仅用于联调与订阅闭环验收，不会触发任何真实银行卡/第三方扣款。</span>
        </div>
      )}

      {/* Main Checkout Card */}
      <div className="rounded-2xl border border-line-subtle bg-surface p-6 shadow-card space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-subtle pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-vip-bg text-vip-fg">
              <Crown className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-ink-primary">收银台订单确认</h1>
              <div className="flex items-center gap-1.5 text-xs text-ink-tertiary tabular-metric">
                <span>订单编号：{checkoutId}</span>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(checkoutId);
                    pushToast({ tone: 'info', title: '订单号已复制' });
                  }}
                  title="复制订单号"
                  className="text-ink-muted hover:text-ink-primary"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={() => void loadCheckout()}
            className="inline-flex items-center gap-1.5 rounded-md border border-line-default bg-surface px-3 py-1.5 text-xs font-medium text-ink-primary hover:bg-hover disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新订单状态</span>
          </button>
        </div>

        {/* Loading State */}
        {loading && !checkout ? (
          <div className="space-y-3 py-4">
            <div className="h-16 rounded-xl skeleton-shimmer" />
            <div className="h-24 rounded-xl skeleton-shimmer" />
          </div>
        ) : errorState && !isPaid ? (
          /* Error States: 401 / 404 FEATURE_DISABLED / 404 NOT_FOUND / 409 CANCELLED / 410 EXPIRED */
          <div
            data-testid={`checkout-error-${errorState.kind}`}
            className="rounded-xl border border-status-failed-border bg-status-failed-bg p-5 space-y-4"
          >
            <div className="flex items-start gap-3">
              {errorState.kind === 'unauthenticated' ? (
                <LogIn className="h-5 w-5 shrink-0 text-status-failed-fg mt-0.5" />
              ) : errorState.kind === 'feature_disabled' ? (
                <ShieldAlert className="h-5 w-5 shrink-0 text-status-failed-fg mt-0.5" />
              ) : (
                <XCircle className="h-5 w-5 shrink-0 text-status-failed-fg mt-0.5" />
              )}
              <div className="space-y-1">
                <div className="text-sm font-semibold text-status-failed-fg">
                  {errorState.kind === 'unauthenticated'
                    ? '请先登录后查看订单'
                    : errorState.kind === 'feature_disabled'
                      ? '沙盒模拟支付未启用'
                      : errorState.kind === 'not_found'
                        ? '订单不存在或无权访问'
                        : errorState.kind === 'cancelled'
                          ? '订单已取消'
                          : errorState.kind === 'expired'
                            ? '订单已过期'
                            : '订单处理异常'}
                </div>
                <p className="text-xs text-status-failed-fg/90">{errorState.message}</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {errorState.kind === 'unauthenticated' ? (
                <button
                  type="button"
                  onClick={() => openLoginModal(() => void loadCheckout())}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
                >
                  <LogIn className="h-3.5 w-3.5" />
                  <span>登录并重新查询订单</span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => navigate('/billing/plans')}
                    className="rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
                  >
                    返回套餐页重新选购
                  </button>
                  <button
                    type="button"
                    onClick={() => openCashierDrawer('plans')}
                    className="rounded-md border border-line-default bg-surface px-4 py-2 text-xs font-medium text-ink-primary hover:bg-hover"
                  >
                    打开收银台抽屉
                  </button>
                </>
              )}
            </div>
          </div>
        ) : checkout ? (
          <div className="space-y-5">
            {/* Order Summary Grid */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 rounded-xl border border-line-subtle bg-muted p-4 text-xs">
              <div>
                <div className="text-ink-tertiary">购买项目</div>
                <div className="mt-1 text-sm font-semibold text-ink-primary">
                  {matchedPlan?.name ||
                    matchedPack?.name ||
                    (checkout.itemType === 'subscription' ? '会员订阅套餐' : '积分加购包')}
                </div>
                <div className="mt-0.5 text-[11px] text-ink-muted tabular-metric">
                  Offer ID：{checkout.offerId}
                </div>
              </div>

              <div className="sm:text-right">
                <div className="text-ink-tertiary">当前状态</div>
                <div className="mt-1">
                  <span
                    data-testid="checkout-status-badge"
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      isPaid
                        ? 'bg-status-success-bg text-status-success-fg'
                        : isCancelled || isPendingExpired
                          ? 'bg-status-failed-bg text-status-failed-fg'
                          : 'bg-status-running-bg text-status-running-fg'
                    }`}
                  >
                    {isPaid
                      ? '已支付到账'
                      : isCancelled
                        ? '已取消'
                        : isPendingExpired
                          ? '已过期'
                          : '待确认支付'}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-ink-muted tabular-metric">
                  {matchedPlan
                    ? `${formatMinorCurrency(matchedPlan.priceMinor, matchedPlan.currency)} · 赠 ${matchedPlan.periodCredits} 积分`
                    : matchedPack
                      ? `${formatMinorCurrency(matchedPack.priceMinor, matchedPack.currency)} · ${matchedPack.credits} 积分`
                      : `通道模式：${checkout.mode}`}
                </div>
              </div>

              <div className="sm:col-span-2 flex flex-wrap items-center justify-between gap-2 border-t border-line-subtle pt-2.5 text-[11px] text-ink-tertiary tabular-metric">
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" />
                  支付截止时间：{formatUtcDateTime(checkout.expiresAt)}
                </span>
                <span>模式：{checkout.mode === 'sandbox' ? '沙盒联调 (sandbox)' : '生产通道 (live)'}</span>
              </div>
            </div>

            {responseLostHint && (
              <div className="flex items-start gap-2 rounded-lg border border-status-stale-border bg-status-stale-bg p-3 text-xs text-status-stale-fg">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{responseLostHint}</span>
              </div>
            )}

            {/* Case A: Paid Order (even if past expiresAt) */}
            {isPaid && (
              <div
                data-testid="checkout-paid-panel"
                className="rounded-xl border border-status-success-border bg-status-success-bg p-5 space-y-4"
              >
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-status-success-fg mt-0.5" />
                  <div className="space-y-1">
                    <div className="text-sm font-semibold text-status-success-fg">
                      支付已确认，会员权益与积分已实时入账
                    </div>
                    <p className="text-xs text-status-success-fg/90">
                      本订单已完成核销，刷新页面或重复打开不会重复发放积分。
                    </p>
                  </div>
                </div>

                {activeBilling && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 rounded-lg border border-status-success-border/60 bg-surface p-3 text-xs">
                    <div>
                      <div className="text-ink-tertiary">当前会员权益</div>
                      <div className="mt-0.5 font-semibold text-ink-primary">
                        {activeBilling.subscription.planId || 'Pro 专业版'}（{activeBilling.subscription.state}）
                      </div>
                      {activeBilling.subscription.periodEnd && (
                        <div className="text-[11px] text-ink-muted tabular-metric">
                          到期：{formatUtcDate(activeBilling.subscription.periodEnd)}
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-ink-tertiary">当前可用总积分</div>
                      <div className="mt-0.5 text-base font-bold tabular-metric text-ink-primary">
                        {activeBilling.entitlements.availableCredits} 分
                      </div>
                      <div className="text-[11px] text-ink-muted tabular-metric">
                        并发槽位：{activeBilling.entitlements.maxConcurrentJobs} ·{' '}
                        {activeBilling.entitlements.watermark ? '带水印' : '无水印商用'}
                      </div>
                    </div>
                    <div>
                      <div className="text-ink-tertiary">本次订单赠分流水</div>
                      <div className="mt-0.5 text-base font-bold tabular-metric text-status-success-fg">
                        {orderLedgerGrant
                          ? `+${orderLedgerGrant.availableDelta} 分`
                          : matchedPlan
                            ? `+${matchedPlan.periodCredits} 分`
                            : matchedPack
                              ? `+${matchedPack.credits} 分`
                              : '已入账'}
                      </div>
                      <div className="text-[11px] text-ink-muted tabular-metric">
                        {orderLedgerGrant ? formatUtcDateTime(orderLedgerGrant.at) : '已写入审计账本'}
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-2.5">
                  <button
                    type="button"
                    onClick={() => navigate('/billing')}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
                  >
                    <ReceiptText className="h-3.5 w-3.5" />
                    <span>前往账单流水</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate('/studio')}
                    className="inline-flex items-center gap-1.5 rounded-md border border-line-default bg-surface px-4 py-2 text-xs font-semibold text-ink-primary hover:bg-hover"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-ai" />
                    <span>返回创作</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* Case B: Pending & Valid Sandbox Checkout -> Primary Confirm Button */}
            {canSandboxConfirm && (
              <div className="space-y-3">
                <button
                  type="button"
                  data-testid="sandbox-confirm-btn"
                  disabled={confirming}
                  onClick={() => void handleSandboxConfirm()}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
                >
                  {confirming ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      <span>正在确认沙盒支付并核对账本...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      <span>确认模拟支付</span>
                    </>
                  )}
                </button>
                <p className="text-center text-[11px] text-ink-muted">
                  点击后将调用服务端沙盒核销接口并在同一事务内发放权益，刷新本页不会自动扣款或重复发放。
                </p>
              </div>
            )}

            {/* Case C: Live pending checkout -> external redirect */}
            {checkout.mode === 'live' && checkout.status === 'pending' && !isPendingExpired && (
              <div className="space-y-3">
                {checkout.redirectUrl && /^https?:\/\//i.test(checkout.redirectUrl) && (
                  <a
                    href={checkout.redirectUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-primary text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span>前往第三方支付通道完成付款</span>
                  </a>
                )}
                <p className="text-center text-xs text-ink-tertiary">
                  真实订单请通过支付通道完成付款后点击右上角「刷新订单状态」核对到账。
                </p>
              </div>
            )}

            {/* Case D: Cancelled or Expired Order */}
            {(isCancelled || isPendingExpired) && !isPaid && (
              <div
                data-testid={isCancelled ? 'checkout-cancelled-panel' : 'checkout-expired-panel'}
                className="rounded-xl border border-status-failed-border bg-status-failed-bg p-4 space-y-3 text-xs text-status-failed-fg"
              >
                <div className="font-semibold">
                  {isCancelled
                    ? '该订单已取消，无法继续确认支付。'
                    : '该订单已超过支付截止时间且未付款，请重新创建订单。'}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => navigate('/billing/plans')}
                    className="rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground"
                  >
                    返回套餐页重新选购
                  </button>
                  <button
                    type="button"
                    onClick={() => openCashierDrawer('plans')}
                    className="rounded-md border border-line-default bg-surface px-4 py-2 text-xs font-medium text-ink-primary"
                  >
                    打开收银台
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default CheckoutPage;
