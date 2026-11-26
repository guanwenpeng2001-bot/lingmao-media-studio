import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Coins,
  Crown,
  Building2,
  ReceiptText,
  Sparkles,
  AlertCircle,
} from 'lucide-react';
import { api } from '../../api/client';
import type { CreditPack, LedgerEntry, LedgerKind, Plan } from '../../api/types';
import {
  formatMinorCurrency,
  formatUtcDate,
  formatUtcDateTime,
  summarizeCreditPools,
} from '../../lib/creditPools';
import { useApp } from '../../state/AppContext';

const LEDGER_LABELS: Record<LedgerKind, { label: string; cls: string }> = {
  grant: { label: '赠送 / 发放', cls: 'bg-status-success-bg text-status-success-fg' },
  hold: { label: '任务预占冻结', cls: 'bg-status-running-bg text-status-running-fg' },
  capture: { label: '任务实扣核销', cls: 'bg-subtle text-ink-primary' },
  release: { label: '失败 / 取消原路退回', cls: 'bg-status-success-bg text-status-success-fg' },
  expire: { label: '周期到期清零', cls: 'bg-status-cancelled-bg text-status-cancelled-fg' },
};

export const BillingPage: React.FC = () => {
  const {
    session,
    billingState,
    projects,
    openLoginModal,
    openCashierDrawer,
    refreshBillingState,
    pushToast,
    handleApiError,
  } = useApp();

  const [interval, setIntervalFilter] = useState<'month' | 'quarter' | 'year'>('year');
  const [plans, setPlans] = useState<Plan[]>([]);
  const [packs, setPacks] = useState<CreditPack[]>([]);
  const [ledgerItems, setLedgerItems] = useState<LedgerEntry[]>([]);
  const [ledgerNextCursor, setLedgerNextCursor] = useState<string | null>(null);
  const [ledgerKind, setLedgerKind] = useState<LedgerKind | ''>('');
  const [ledgerProjectId, setLedgerProjectId] = useState('');
  const [stoppingRenewal, setStoppingRenewal] = useState(false);

  // P1 Enterprise lead form placeholder
  const [leadModalOpen, setLeadModalOpen] = useState(false);
  const [leadCompany, setLeadCompany] = useState('');
  const [leadPhone, setLeadPhone] = useState('');

  useEffect(() => {
    void api.listPlans().then(setPlans).catch(() => {});
    void api.listCreditPacks().then(setPacks).catch(() => {});
  }, []);

  const loadLedger = useCallback(
    async (cursor?: string) => {
      if (!session) return;
      try {
        const res = await api.getLedger({
          kind: ledgerKind || undefined,
          projectId: ledgerProjectId || undefined,
          cursor,
          limit: 20,
        });
        setLedgerItems((prev) => (cursor ? [...prev, ...res.items] : res.items));
        setLedgerNextCursor(res.nextCursor);
      } catch (err) {
        handleApiError(err);
      }
    },
    [session, ledgerKind, ledgerProjectId, handleApiError]
  );

  useEffect(() => {
    void loadLedger();
  }, [loadLedger]);

  const handleStopRenewal = async () => {
    if (!window.confirm('确认关闭下期自动续费？关闭后当前周期已购 Pro 权益与积分仍正常有效至到期日。')) {
      return;
    }
    setStoppingRenewal(true);
    try {
      await api.stopRenewal();
      await refreshBillingState();
      pushToast({
        tone: 'success',
        title: '已关闭下期自动续费',
        description: '当前周期 Pro 权益与积分不受影响，正常有效至到期日。',
      });
    } catch (err) {
      handleApiError(err);
    } finally {
      setStoppingRenewal(false);
    }
  };

  const ent = billingState?.entitlements;
  const sub = billingState?.subscription;
  const pools = summarizeCreditPools(ent?.walletLots || []);
  const proPlanForInterval = plans.find((p) => p.interval === interval && p.priceMinor > 0);

  return (
    <div className="p-6 space-y-6 max-w-[1360px] mx-auto">
      {/* Top 3-Pool Dashboard (Authenticated) */}
      {session && ent && (
        <div className="rounded-xl border border-line-subtle bg-surface p-5 space-y-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-vip-bg text-vip-fg">
                <Crown className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-lg font-semibold text-ink-primary">
                    当前会员：{sub?.state === 'active' ? sub.planId || 'Pro 专业版' : 'Free 体验版'}
                  </h1>
                  {sub?.cancelAtPeriodEnd && (
                    <span className="rounded-xs bg-status-stale-bg px-2 py-0.5 text-[11px] font-medium text-status-stale-fg">
                      已关闭下期自动续费（有效期至 {formatUtcDate(sub.periodEnd)}）
                    </span>
                  )}
                </div>
                <div className="text-xs text-ink-tertiary tabular-metric">
                  可用总积分 <strong className="text-ink-primary">{ent.availableCredits}</strong> ·
                  任务冻结中 <strong className="text-status-running-fg">{ent.heldCredits}</strong> ·
                  累计已耗 {ent.spentCredits} · 并发槽位 {ent.activeJobs}/{ent.maxConcurrentJobs}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {sub?.state === 'active' && !sub.cancelAtPeriodEnd && (
                <button
                  type="button"
                  disabled={stoppingRenewal}
                  onClick={() => void handleStopRenewal()}
                  className="rounded-md border border-line-default bg-surface px-3 py-1.5 text-xs text-ink-secondary hover:bg-hover"
                >
                  {stoppingRenewal ? '处理中...' : '停止下期续订'}
                </button>
              )}
              <button
                type="button"
                onClick={() => openCashierDrawer('packs')}
                className="rounded-md bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
              >
                + 加购积分包
              </button>
            </div>
          </div>

          {/* Strictly Ordered 3 Credit Pools: 限时赠分池 -> 周期订阅池 -> 长期加购包池 */}
          <div
            data-testid="billing-three-pools"
            className="grid grid-cols-1 gap-3 md:grid-cols-3"
          >
            {pools.map((pool, idx) => (
              <div
                key={pool.source}
                data-testid={`billing-pool-card-${pool.source}`}
                className="rounded-lg border border-line-subtle bg-muted p-4 space-y-1.5"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 font-semibold text-ink-primary">
                    <span className={`h-2 w-2 rounded-full ${pool.bgClass}`} />
                    {idx + 1}. {pool.label}
                  </span>
                  <span className="text-[11px] text-ink-muted">
                    {idx === 0 ? '最优先扣减' : idx === 1 ? '次优先扣减' : '最后扣减'}
                  </span>
                </div>
                <div className="flex items-baseline justify-between tabular-metric">
                  <span className="text-2xl font-bold text-ink-primary">{pool.available}</span>
                  {pool.held > 0 && (
                    <span className="text-xs text-status-running-fg">冻结 {pool.held} 分</span>
                  )}
                </div>
                <div className="text-[11px] text-ink-tertiary tabular-metric">
                  最快到期：{formatUtcDate(pool.nearestExpiresAt)}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>
              扣减顺序规则（R-SUB-01）：限时赠分池 → 周期订阅池 → 长期加购包池；任务失败、超时或排队取消 100% 按原扣减池退还。
            </span>
          </div>
        </div>
      )}

      {/* Plans Comparison Matrix (Guest Browsable!) */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink-primary">会员订阅套餐对比</h2>
            <p className="text-xs text-ink-tertiary">
              P0 首发个人版 Free / Pro 在线订阅；Team / Enterprise 随 P1 团队协作同步开放。
            </p>
          </div>

          {/* Billing Cycle Toggle */}
          <div className="flex items-center gap-1 rounded-full bg-subtle p-1 text-xs">
            {(
              [
                { id: 'month', label: '月付', badge: null },
                { id: 'quarter', label: '季付', badge: '省20%' },
                { id: 'year', label: '年付', badge: '会员4.3折' },
              ] as const
            ).map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => setIntervalFilter(it.id)}
                className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-medium transition-colors ${
                  interval === it.id
                    ? 'bg-surface font-semibold text-ink-primary shadow-xs'
                    : 'text-ink-secondary hover:text-ink-primary'
                }`}
              >
                <span>{it.label}</span>
                {it.badge && (
                  <span className="rounded-xs bg-badge-discount-bg px-1.5 py-0.5 text-[10px] font-semibold text-badge-discount-fg">
                    {it.badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {/* Free */}
          <div className="flex flex-col justify-between rounded-xl border border-line-subtle bg-surface p-5 space-y-4">
            <div className="space-y-2">
              <div className="text-sm font-semibold text-ink-primary">Free 免费体验版</div>
              <div className="tabular-metric text-2xl font-bold text-ink-primary">¥0</div>
              <p className="text-xs text-ink-tertiary">新客注册即赠体验积分，适合轻量体验</p>
              <ul className="space-y-1.5 pt-2 text-xs text-ink-secondary">
                <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-status-success-fg" />1 个普通并发任务槽位</li>
                <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-status-success-fg" />最多 5 个画布 / 单画布 30 节点</li>
                <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-status-success-fg" />标清导出（带平台轻水印，非商用）</li>
                <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-status-success-fg" />到期降级永久保留历史资产</li>
              </ul>
            </div>
            <button
              type="button"
              onClick={() => (!session ? openLoginModal() : undefined)}
              className="w-full rounded-md border border-line-default bg-subtle py-2 text-xs font-semibold text-ink-primary"
            >
              {session ? '当前基础权益' : '免费注册领取体验分'}
            </button>
          </div>

          {/* Pro (P0 Hero Plan) */}
          <div className="relative flex flex-col justify-between rounded-xl border-2 border-vip bg-surface p-5 shadow-card space-y-4">
            <span className="absolute -top-2.5 right-4 rounded-full bg-vip-bg border border-vip px-2.5 py-0.5 text-[10px] font-bold text-vip-fg">
              推荐 · P0 个人专业版
            </span>
            <div className="space-y-2">
              <div className="text-sm font-semibold text-ink-primary">
                {proPlanForInterval?.name || 'Pro 个人专业版'}
              </div>
              <div className="flex items-baseline gap-1.5 tabular-metric">
                <span className="text-2xl font-bold text-ink-primary">
                  {proPlanForInterval
                    ? formatMinorCurrency(proPlanForInterval.priceMinor, proPlanForInterval.currency)
                    : interval === 'year'
                      ? '¥599'
                      : interval === 'quarter'
                        ? '¥169'
                        : '¥69'}
                </span>
                <span className="text-xs text-ink-muted">
                  /{interval === 'year' ? '年' : interval === 'quarter' ? '季' : '月'}
                </span>
              </div>
              <p className="text-xs text-ink-tertiary tabular-metric">
                周期赠送 {proPlanForInterval?.periodCredits ?? 1500} 积分 · 折合单图低至 ¥0.12
              </p>
              <ul className="space-y-1.5 pt-2 text-xs text-ink-secondary">
                <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-ai" />4 个优先加速并发任务槽位</li>
                <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-ai" />100 画布 / 单画布 200 节点</li>
                <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-ai" />高清超分、无水印、个人商用授权</li>
                <li className="flex items-center gap-1.5"><Check className="h-3.5 w-3.5 text-ai" />全品类电商保真换景与 8 规格套图</li>
              </ul>
            </div>
            <button
              type="button"
              onClick={() => openCashierDrawer('plans')}
              className="w-full rounded-md bg-primary py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
            >
              立即开通 / 升级 Pro
            </button>
          </div>

          {/* Team (P1 Preview) */}
          <div className="flex flex-col justify-between rounded-xl border border-dashed border-line-default bg-surface/80 p-5 space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-ink-primary">Team 团队协作版</span>
                <span className="rounded-xs bg-subtle px-1.5 py-0.5 text-[10px] font-semibold text-ink-tertiary">
                  P1 即将开放
                </span>
              </div>
              <div className="tabular-metric text-xl font-bold text-ink-secondary">¥199 / 席位 / 月起</div>
              <p className="text-xs text-ink-tertiary">面向电商运营团队与代运营视觉设计部</p>
              <ul className="space-y-1.5 pt-2 text-xs text-ink-tertiary">
                <li>• 10 并发高优队列 / 单画布 500 节点</li>
                <li>• 团队共享积分池与三态成员权限</li>
                <li>• 团队共享商品主体库与私有模板</li>
                <li>• 团队/店铺级商用授权书</li>
              </ul>
            </div>
            <button
              type="button"
              onClick={() => setLeadModalOpen(true)}
              className="w-full rounded-md border border-line-default bg-subtle py-2 text-xs font-medium text-ink-secondary hover:bg-hover"
            >
              预约团队版 / 留资咨询
            </button>
          </div>

          {/* Enterprise (P1/P2 Preview) */}
          <div className="flex flex-col justify-between rounded-xl border border-dashed border-line-default bg-surface/80 p-5 space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-ink-primary">Enterprise 企业定制</span>
                <span className="rounded-xs bg-subtle px-1.5 py-0.5 text-[10px] font-semibold text-ink-tertiary">
                  企业留资
                </span>
              </div>
              <div className="text-xl font-bold text-ink-secondary">对公年度定制</div>
              <p className="text-xs text-ink-tertiary">面向中大型品牌、MCN 与影视工作室</p>
              <ul className="space-y-1.5 pt-2 text-xs text-ink-tertiary">
                <li>• 独立专属并发通道与不限节点</li>
                <li>• 多部门子池核算与成员月限额</li>
                <li>• 专属合规模型与法务商用支持</li>
                <li>• 对公充值与增值税专票</li>
              </ul>
            </div>
            <button
              type="button"
              onClick={() => setLeadModalOpen(true)}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-line-default bg-subtle py-2 text-xs font-medium text-ink-secondary hover:bg-hover"
            >
              <Building2 className="h-3.5 w-3.5" />
              <span>联系企业服务</span>
            </button>
          </div>
        </div>
      </div>

      {/* Credit Packs */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Coins className="h-4 w-4 text-pool-topup" />
          <h2 className="text-base font-semibold text-ink-primary">独立积分加购包（永久加购池）</h2>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {packs.length === 0 ? (
            <div className="col-span-full rounded-xl border border-line-subtle bg-surface p-6 text-center text-xs text-ink-muted">
              暂无上架积分加购包
            </div>
          ) : (
            packs.map((pack) => (
              <div
                key={pack.id}
                className="flex items-center justify-between rounded-xl border border-line-subtle bg-surface p-4"
              >
                <div>
                  <div className="text-sm font-semibold text-ink-primary">{pack.name}</div>
                  <div className="tabular-metric text-xs text-ink-tertiary">
                    {pack.credits} 积分 · {pack.expiresInDays ? `${pack.expiresInDays} 天` : '永久有效'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => openCashierDrawer('packs')}
                  className="rounded-md bg-subtle px-3 py-1.5 text-xs font-semibold tabular-metric text-ink-primary hover:bg-hover"
                >
                  {formatMinorCurrency(pack.priceMinor, pack.currency)}
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Usage & Credit Audit Ledger */}
      {session && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ReceiptText className="h-4 w-4 text-ai" />
              <h2 className="text-base font-semibold text-ink-primary">用量与积分审计流水</h2>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <select
                value={ledgerKind}
                onChange={(e) => setLedgerKind(e.target.value as LedgerKind | '')}
                className="h-8 rounded-md border border-line-default bg-surface px-2.5 text-xs text-ink-primary"
              >
                <option value="">全部流水类型</option>
                <option value="grant">赠送 / 发放</option>
                <option value="hold">任务预占</option>
                <option value="capture">任务实扣</option>
                <option value="release">失败 / 取消退回</option>
                <option value="expire">到期清零</option>
              </select>
              <select
                value={ledgerProjectId}
                onChange={(e) => setLedgerProjectId(e.target.value)}
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
          </div>

          <div className="overflow-x-auto rounded-xl border border-line-subtle bg-surface">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-line-subtle bg-muted text-ink-tertiary">
                <tr>
                  <th className="px-4 py-2.5">时间</th>
                  <th className="px-4 py-2.5">类型</th>
                  <th className="px-4 py-2.5">可用余额变动</th>
                  <th className="px-4 py-2.5">冻结变动</th>
                  <th className="px-4 py-2.5">实扣变动</th>
                  <th className="px-4 py-2.5">关联任务 / 订单</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-subtle tabular-metric">
                {ledgerItems.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-ink-muted font-sans">
                      暂无积分流水记录
                    </td>
                  </tr>
                ) : (
                  ledgerItems.map((entry) => {
                    const meta = LEDGER_LABELS[entry.kind];
                    return (
                      <tr key={entry.id}>
                        <td className="px-4 py-2.5 text-ink-secondary">{formatUtcDateTime(entry.at)}</td>
                        <td className="px-4 py-2.5 font-sans">
                          <span className={`rounded-xs px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>
                            {meta.label}
                          </span>
                        </td>
                        <td
                          className={`px-4 py-2.5 font-semibold ${
                            entry.availableDelta > 0
                              ? 'text-status-success-fg'
                              : entry.availableDelta < 0
                                ? 'text-status-failed-fg'
                                : 'text-ink-muted'
                          }`}
                        >
                          {entry.availableDelta > 0 ? `+${entry.availableDelta}` : entry.availableDelta}
                        </td>
                        <td className="px-4 py-2.5 text-ink-secondary">
                          {entry.heldDelta > 0 ? `+${entry.heldDelta}` : entry.heldDelta}
                        </td>
                        <td className="px-4 py-2.5 text-ink-secondary">
                          {entry.spentDelta > 0 ? `+${entry.spentDelta}` : entry.spentDelta}
                        </td>
                        <td className="px-4 py-2.5 text-ink-tertiary">
                          {entry.jobId || entry.orderId || '—'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {ledgerNextCursor && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => void loadLedger(ledgerNextCursor)}
                className="rounded-md border border-line-default bg-surface px-4 py-1.5 text-xs text-ink-primary hover:bg-hover"
              >
                加载更多流水
              </button>
            </div>
          )}
        </div>
      )}

      {/* Enterprise Lead Modal */}
      {leadModalOpen && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          style={{ backgroundColor: 'var(--bg-modal-overlay)', zIndex: 'var(--z-modal)' }}
          onClick={() => setLeadModalOpen(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setLeadModalOpen(false);
              setLeadCompany('');
              setLeadPhone('');
              pushToast({
                tone: 'success',
                title: '已收到您的企业/团队版预约信息',
                description: 'P1 团队协作开放前将由专属顾问与您联系。',
              });
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[400px] rounded-modal border border-line-default bg-elevated p-6 shadow-modal space-y-4"
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-ink-primary">
              <Sparkles className="h-4 w-4 text-ai" />
              <span>Team / Enterprise 企业服务留资</span>
            </div>
            <input
              type="text"
              required
              value={leadCompany}
              onChange={(e) => setLeadCompany(e.target.value)}
              placeholder="公司 / 店铺 / 团队名称"
              className="h-9 w-full rounded-md border border-line-default bg-surface px-3 text-xs text-ink-primary"
            />
            <input
              type="tel"
              required
              value={leadPhone}
              onChange={(e) => setLeadPhone(e.target.value)}
              placeholder="联系手机号或企业微信"
              className="h-9 w-full rounded-md border border-line-default bg-surface px-3 text-xs text-ink-primary"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setLeadModalOpen(false)}
                className="rounded-md bg-subtle px-3 py-1.5 text-xs text-ink-secondary"
              >
                取消
              </button>
              <button
                type="submit"
                className="rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground"
              >
                提交预约
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
