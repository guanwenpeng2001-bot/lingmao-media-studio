import type { Entitlements, WalletLot, WalletLotSource } from '../api/types';

export interface CreditPoolSummary {
  source: WalletLotSource;
  label: string;
  shortLabel: string;
  available: number;
  held: number;
  nearestExpiresAt: string | null;
  colorClass: string;
  bgClass: string;
}

// Strict deduction priority per R-SUB-01:
// 1. 限时赠分池 (trial) -> 2. 周期订阅池 (subscription) -> 3. 长期加购包池 (pack)
export const CREDIT_POOL_ORDER: WalletLotSource[] = ['trial', 'subscription', 'pack'];

const POOL_META: Record<
  WalletLotSource,
  { label: string; shortLabel: string; colorClass: string; bgClass: string }
> = {
  trial: {
    label: '限时赠分池',
    shortLabel: '限时赠分',
    colorClass: 'text-pool-grant',
    bgClass: 'bg-pool-grant',
  },
  subscription: {
    label: '周期订阅池',
    shortLabel: '周期订阅',
    colorClass: 'text-pool-subscription',
    bgClass: 'bg-pool-subscription',
  },
  pack: {
    label: '长期加购包池',
    shortLabel: '永久加购',
    colorClass: 'text-pool-topup',
    bgClass: 'bg-pool-topup',
  },
};

export function summarizeCreditPools(lots: WalletLot[] = []): CreditPoolSummary[] {
  return CREDIT_POOL_ORDER.map((source) => {
    const matched = lots.filter((l) => l.source === source);
    const available = matched.reduce((acc, item) => acc + Math.max(0, item.available), 0);
    const held = matched.reduce((acc, item) => acc + Math.max(0, item.held), 0);
    const expiries = matched
      .map((item) => item.expiresAt)
      .filter((x): x is string => Boolean(x))
      .sort();
    const meta = POOL_META[source];
    return {
      source,
      label: meta.label,
      shortLabel: meta.shortLabel,
      available,
      held,
      nearestExpiresAt: expiries[0] ?? null,
      colorClass: meta.colorClass,
      bgClass: meta.bgClass,
    };
  });
}

export function formatMinorCurrency(priceMinor: number, currency = 'CNY'): string {
  const major = priceMinor / 100;
  const symbol = currency === 'CNY' ? '¥' : `${currency} `;
  return Number.isInteger(major) ? `${symbol}${major}` : `${symbol}${major.toFixed(2)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** idx;
  return `${val >= 100 ? Math.round(val) : val.toFixed(1)} ${units[idx]}`;
}

export function getStorageAlertLevel(
  entitlements: Entitlements | null | undefined
): { percent: number; level: 'normal' | 'warning' | 'full' } {
  if (!entitlements || entitlements.storageLimitBytes <= 0) {
    return { percent: 0, level: 'normal' };
  }
  const percent = Math.min(
    100,
    Math.round((entitlements.usedStorageBytes / entitlements.storageLimitBytes) * 100)
  );
  if (percent >= 100) return { percent, level: 'full' };
  if (percent >= 85) return { percent, level: 'warning' };
  return { percent, level: 'normal' };
}

export function formatUtcDate(iso: string | null | undefined): string {
  if (!iso) return '永久有效';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

export function formatUtcDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${day} ${hh}:${mm}`;
}
