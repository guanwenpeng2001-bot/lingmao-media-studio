import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api, ApiClientError } from '../api/client';
import type { BillingState, Checkout, Session } from '../api/types';
import { AppRoutes } from '../App';
import { AppProvider } from '../state/AppContext';

const sandboxSession: Session = {
  userId: 'usr-sbx',
  displayName: '沙盒验收用户',
  workspaceId: 'ws-sbx',
  role: 'owner',
  mode: 'sandbox',
  features: {
    virtual_tryon: false,
    org_collaboration: false,
    audio_studio: false,
  },
};

const pendingCheckout: Checkout = {
  id: 'chk-pro-01',
  status: 'pending',
  mode: 'sandbox',
  redirectUrl: '/billing/checkout/chk-pro-01',
  expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  itemType: 'subscription',
  offerId: 'pro-month',
};

const paidCheckout: Checkout = {
  ...pendingCheckout,
  status: 'paid',
};

const paidBillingState: BillingState = {
  subscription: {
    planId: 'pro-month',
    state: 'active',
    periodStart: '2026-11-27T00:00:00Z',
    periodEnd: '2026-12-27T00:00:00Z',
    cancelAtPeriodEnd: false,
  },
  checkoutMode: 'sandbox',
  entitlements: {
    availableCredits: 1700,
    heldCredits: 0,
    spentCredits: 0,
    maxConcurrentJobs: 4,
    activeJobs: 0,
    allowedModelIds: ['studio-image', 'studio-video'],
    asOf: '2026-11-27T01:00:00Z',
    watermark: false,
    storageLimitBytes: 20 * 1024 * 1024 * 1024,
    usedStorageBytes: 0,
    canvasNodeLimit: 200,
    maxCanvasCount: 100,
    maxSeats: 1,
    walletLots: [
      { id: 'lot-t', source: 'trial', available: 200, held: 0, expiresAt: null },
      { id: 'lot-s', source: 'subscription', available: 1500, held: 0, expiresAt: '2026-12-27T00:00:00Z' },
    ],
  },
};

describe('P0-1 Sandbox Checkout Confirm Page (/billing/checkout/:checkoutId)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getSession').mockResolvedValue(sandboxSession);
    vi.spyOn(api, 'listModels').mockResolvedValue([]);
    vi.spyOn(api, 'listProjects').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, 'listJobs').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, 'getRecentCanvas').mockResolvedValue({ canvas: null });
    vi.spyOn(api, 'listPlans').mockResolvedValue([
      {
        id: 'pro-month',
        name: 'Pro 月卡',
        interval: 'month',
        priceMinor: 6900,
        currency: 'CNY',
        periodCredits: 1500,
        maxConcurrentJobs: 4,
        modelIds: ['studio-image'],
        offerVersion: 'v1',
      },
    ]);
    vi.spyOn(api, 'listCreditPacks').mockResolvedValue([]);
    vi.spyOn(api, 'getBillingState').mockResolvedValue({
      ...paidBillingState,
      subscription: {
        planId: null,
        state: 'none',
        periodStart: null,
        periodEnd: null,
        cancelAtPeriodEnd: false,
      },
      entitlements: { ...paidBillingState.entitlements, availableCredits: 200 },
    });
    vi.spyOn(api, 'getLedger').mockResolvedValue({ items: [], nextCursor: null });
  });

  it('loads order read-only on mount, confirms via sandbox-confirm on click, and refreshes order + billing/state + billing/ledger', async () => {
    const getOrderSpy = vi
      .spyOn(api, 'getCheckoutSession')
      .mockResolvedValueOnce(pendingCheckout)
      .mockResolvedValueOnce(paidCheckout);
    const confirmSpy = vi
      .spyOn(api, 'sandboxConfirmCheckout')
      .mockResolvedValueOnce(paidCheckout);
    const billingSpy = vi
      .spyOn(api, 'getBillingState')
      .mockResolvedValue(paidBillingState);
    const ledgerSpy = vi.spyOn(api, 'getLedger').mockResolvedValue({
      items: [
        {
          id: 'led-1',
          kind: 'grant',
          jobId: null,
          orderId: 'chk-pro-01',
          availableDelta: 1500,
          heldDelta: 0,
          spentDelta: 0,
          expiredDelta: 0,
          at: '2026-11-27T01:05:00Z',
        },
      ],
      nextCursor: null,
    });

    render(
      <MemoryRouter initialEntries={['/billing/checkout/chk-pro-01']}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>
    );

    // Mount must be strictly read-only: NO auto-confirm
    expect(await screen.findByTestId('sandbox-notice-banner')).toHaveTextContent('沙盒支付，本次不扣款');
    const confirmBtn = await screen.findByTestId('sandbox-confirm-btn');
    expect(confirmBtn).toHaveTextContent('确认模拟支付');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(getOrderSpy).toHaveBeenCalledWith('chk-pro-01');

    // Click confirm -> calls sandboxConfirmCheckout, re-reads order, billing/state, and billing/ledger
    fireEvent.click(confirmBtn);

    const paidPanel = await screen.findByTestId('checkout-paid-panel');
    expect(paidPanel).toHaveTextContent('+1500 分');
    expect(paidPanel).toHaveTextContent('1700 分');
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledWith('chk-pro-01');
    expect(getOrderSpy).toHaveBeenCalledTimes(2);
    expect(billingSpy).toHaveBeenCalled();
    expect(ledgerSpy).toHaveBeenCalled();
  });

  it('still displays paid status even when original expiresAt has already passed', async () => {
    const expiredButPaid: Checkout = {
      ...paidCheckout,
      expiresAt: '2020-01-01T00:00:00Z',
    };
    vi.spyOn(api, 'getCheckoutSession').mockResolvedValueOnce(expiredButPaid);

    render(
      <MemoryRouter initialEntries={['/billing/checkout/chk-pro-01']}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>
    );

    expect(await screen.findByTestId('checkout-paid-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('sandbox-confirm-btn')).not.toBeInTheDocument();
  });

  it('handles 401 UNAUTHENTICATED, 404 FEATURE_DISABLED, 409 CHECKOUT_CANCELLED, and 410 CHECKOUT_EXPIRED', async () => {
    // 1. 401 UNAUTHENTICATED -> opens login modal
    vi.spyOn(api, 'getCheckoutSession').mockRejectedValueOnce(
      new ApiClientError({
        status: 401,
        code: 'UNAUTHENTICATED',
        message: 'Not logged in',
        requestId: 'req-401',
      })
    );
    const { unmount } = render(
      <MemoryRouter initialEntries={['/billing/checkout/chk-401']}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>
    );
    expect(await screen.findByTestId('checkout-error-unauthenticated')).toBeInTheDocument();
    expect(await screen.findByRole('dialog', { name: '手机号验证码登录' })).toBeInTheDocument();
    unmount();

    // 2. 404 FEATURE_DISABLED
    vi.spyOn(api, 'getCheckoutSession').mockRejectedValueOnce(
      new ApiClientError({
        status: 404,
        code: 'FEATURE_DISABLED',
        message: 'Sandbox disabled',
        requestId: 'req-404',
      })
    );
    const r2 = render(
      <MemoryRouter initialEntries={['/billing/checkout/chk-404']}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>
    );
    expect(await screen.findByTestId('checkout-error-feature_disabled')).toHaveTextContent('未启用沙盒支付');
    expect(screen.queryByTestId('sandbox-confirm-btn')).not.toBeInTheDocument();
    r2.unmount();

    // 3. 409 CHECKOUT_CANCELLED on confirm
    vi.spyOn(api, 'getCheckoutSession').mockResolvedValue(pendingCheckout);
    vi.spyOn(api, 'sandboxConfirmCheckout').mockRejectedValueOnce(
      new ApiClientError({
        status: 409,
        code: 'CHECKOUT_CANCELLED',
        message: 'Order cancelled',
        requestId: 'req-409',
      })
    );
    const r3 = render(
      <MemoryRouter initialEntries={['/billing/checkout/chk-pro-01']}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByTestId('sandbox-confirm-btn'));
    expect(await screen.findByTestId('checkout-error-cancelled')).toHaveTextContent('已取消');
    r3.unmount();

    // 4. 410 CHECKOUT_EXPIRED on confirm
    vi.spyOn(api, 'getCheckoutSession').mockResolvedValue(pendingCheckout);
    vi.spyOn(api, 'sandboxConfirmCheckout').mockRejectedValueOnce(
      new ApiClientError({
        status: 410,
        code: 'CHECKOUT_EXPIRED',
        message: 'Order expired',
        requestId: 'req-410',
      })
    );
    const r4 = render(
      <MemoryRouter initialEntries={['/billing/checkout/chk-pro-01']}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByTestId('sandbox-confirm-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('checkout-error-expired')).toHaveTextContent('已过期');
    });
    r4.unmount();
  });

  it('sends deterministic Idempotency-Key header sandbox-confirm-{checkoutId} with empty body and refreshes order on 409 IDEMPOTENCY_CONFLICT', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(paidCheckout), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const res = await api.sandboxConfirmCheckout('chk-pro-01');
    expect(res.status).toBe('paid');
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/billing/checkout-sessions/chk-pro-01/sandbox-confirm',
      expect.objectContaining({
        method: 'POST',
        body: undefined,
        headers: expect.objectContaining({
          'Idempotency-Key': 'sandbox-confirm-chk-pro-01',
        }),
      })
    );

    // Also verify 409 IDEMPOTENCY_CONFLICT triggers error display and re-queries order status
    const getOrderSpy = vi
      .spyOn(api, 'getCheckoutSession')
      .mockResolvedValueOnce(pendingCheckout)
      .mockResolvedValueOnce(pendingCheckout);
    vi.spyOn(api, 'sandboxConfirmCheckout').mockRejectedValueOnce(
      new ApiClientError({
        status: 409,
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'Idempotency key conflict',
        requestId: 'req-idem-409',
      })
    );

    render(
      <MemoryRouter initialEntries={['/billing/checkout/chk-pro-01']}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByTestId('sandbox-confirm-btn'));
    expect(await screen.findByTestId('checkout-error-generic')).toHaveTextContent('Idempotency key conflict');
    await waitFor(() => {
      expect(getOrderSpy).toHaveBeenCalledTimes(2);
    });
  });
});
