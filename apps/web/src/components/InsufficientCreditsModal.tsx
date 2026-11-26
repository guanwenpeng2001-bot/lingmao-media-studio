import React from 'react';
import { AlertCircle, Coins, Crown, X } from 'lucide-react';
import { useApp } from '../state/AppContext';

export const InsufficientCreditsModal: React.FC = () => {
  const { insufficientCreditsModal, closeInsufficientCreditsModal, openCashierDrawer } = useApp();

  if (!insufficientCreditsModal.open) return null;

  const { required, available, shortfall } = insufficientCreditsModal.details;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-modal-overlay)', zIndex: 'var(--z-modal)' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-testid="insufficient-credits-modal"
        className="w-full max-w-[440px] rounded-modal border border-line-default bg-elevated p-6 shadow-modal space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-status-stale-bg text-status-stale-fg">
              <AlertCircle className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-ink-primary">可用积分不足</h3>
              <p className="text-xs text-ink-tertiary">
                {insufficientCreditsModal.contextLabel || '本次生成已前置拦截，零冻结扣费'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={closeInsufficientCreditsModal}
            className="rounded-md p-1 text-ink-tertiary hover:bg-hover hover:text-ink-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2 rounded-lg border border-line-subtle bg-surface p-3 text-center tabular-metric">
          <div>
            <div className="text-[11px] text-ink-tertiary">本次需要</div>
            <div className="mt-0.5 text-base font-bold text-ink-primary">{required} 分</div>
          </div>
          <div>
            <div className="text-[11px] text-ink-tertiary">当前可用</div>
            <div className="mt-0.5 text-base font-bold text-ink-secondary">{available} 分</div>
          </div>
          <div>
            <div className="text-[11px] text-ink-tertiary">还差积分</div>
            <div className="mt-0.5 text-base font-bold text-status-failed-fg">{shortfall} 分</div>
          </div>
        </div>

        <div className="rounded-md bg-status-success-bg px-3 py-2 text-xs text-status-success-fg">
          您的提示词、已上传商品图与画布节点编辑现场已 100% 完整保留，充值后可一键继续提交。
        </div>

        <div className="flex gap-2.5 pt-1">
          <button
            type="button"
            onClick={() => {
              const resume = insufficientCreditsModal.onResume;
              closeInsufficientCreditsModal();
              openCashierDrawer('packs', resume);
            }}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-line-default bg-surface py-2 text-xs font-semibold text-ink-primary hover:bg-hover"
          >
            <Coins className="h-3.5 w-3.5 text-ai" />
            <span>购买加购包</span>
          </button>
          <button
            type="button"
            onClick={() => {
              const resume = insufficientCreditsModal.onResume;
              closeInsufficientCreditsModal();
              openCashierDrawer('plans', resume);
            }}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-primary py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
          >
            <Crown className="h-3.5 w-3.5" />
            <span>升级 Pro 会员</span>
          </button>
        </div>
      </div>
    </div>
  );
};
