import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api, ApiClientError } from '../api/client';
import type { BillingState, Session } from '../api/types';
import { AppRoutes } from '../App';
import { summarizeCreditPools } from '../lib/creditPools';
import { AppProvider } from '../state/AppContext';

const mockSession: Session = {
  userId: 'usr-bill',
  displayName: '电商用户',
  workspaceId: 'ws-bill',
  role: 'owner',
  mode: 'live',
  features: {
    virtual_tryon: false,
    org_collaboration: false,
    audio_studio: false,
  },
};

const mockBilling: BillingState = {
  subscription: {
    planId: 'pro-month',
    state: 'active',
    periodStart: '2026-11-01T00:00:00Z',
    periodEnd: '2026-12-01T00:00:00Z',
    cancelAtPeriodEnd: false,
  },
  checkoutMode: 'live',
  entitlements: {
    availableCredits: 170,
    heldCredits: 30,
    spentCredits: 40,
    maxConcurrentJobs: 4,
    activeJobs: 1,
    allowedModelIds: ['studio-image'],
    asOf: '2026-11-26T08:00:00Z',
    watermark: false,
    storageLimitBytes: 1024 * 1024 * 1024,
    usedStorageBytes: 1024 * 1024 * 100,
    canvasNodeLimit: 200,
    maxCanvasCount: 100,
    maxSeats: 1,
    // Intentionally pass out-of-order walletLots to verify strict UI ordering!
    walletLots: [
      { id: 'lot-pack', source: 'pack', available: 50, held: 0, expiresAt: null },
      { id: 'lot-sub', source: 'subscription', available: 100, held: 10, expiresAt: '2026-12-20T00:00:00Z' },
      { id: 'lot-trial', source: 'trial', available: 20, held: 20, expiresAt: '2026-11-30T00:00:00Z' },
    ],
  },
};

describe('Three Credit Pools Order & In-Place 409 INSUFFICIENT_CREDITS Interception', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getSession').mockResolvedValue(mockSession);
    vi.spyOn(api, 'listModels').mockResolvedValue([
      {
        id: 'studio-image',
        label: 'Studio Image',
        modes: ['text_to_image'],
        aspectRatios: ['1:1'],
        durationSeconds: [],
        maxInputImages: 4,
        availability: 'available',
        execution: 'live',
        resolutions: ['1k'],
        nativeAudio: false,
        supportsLastFrame: false,
        supportsLockedSubject: true,
        submissionRecovery: 'idempotent_key',
      },
    ]);
    vi.spyOn(api, 'getBillingState').mockResolvedValue(mockBilling);
    vi.spyOn(api, 'listProjects').mockResolvedValue({
      items: [
        {
          id: 'prj-1',
          name: '电商主项目',
          industry: 'ecommerce',
          status: 'active',
          workspaceId: 'ws-bill',
          createdAt: '2026-11-01T00:00:00Z',
          updatedAt: '2026-11-26T00:00:00Z',
          revision: 1,
        },
      ],
      nextCursor: null,
    });
    vi.spyOn(api, 'listJobs').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, 'getRecentCanvas').mockResolvedValue({ canvas: null });
    vi.spyOn(api, 'listPlans').mockResolvedValue([]);
    vi.spyOn(api, 'listCreditPacks').mockResolvedValue([]);
    vi.spyOn(api, 'getLedger').mockResolvedValue({ items: [], nextCursor: null });
  });

  it('orders credit pools strictly: 限时赠分池 (trial) -> 周期订阅池 (subscription) -> 长期加购包池 (pack)', async () => {
    const summarized = summarizeCreditPools(mockBilling.entitlements.walletLots);
    expect(summarized.map((p) => p.source)).toEqual(['trial', 'subscription', 'pack']);
    expect(summarized.map((p) => p.available)).toEqual([20, 100, 50]);

    render(
      <MemoryRouter initialEntries={['/billing']}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>
    );

    // Check sidebar 3-pool list DOM order
    const sidebarList = await screen.findByTestId('credit-pool-list');
    const sidebarChildren = Array.from(sidebarList.children).map((el) =>
      el.getAttribute('data-testid')
    );
    expect(sidebarChildren).toEqual([
      'credit-pool-trial',
      'credit-pool-subscription',
      'credit-pool-pack',
    ]);
    expect(screen.getByTestId('reserved-credits-badge')).toHaveTextContent('冻结 30');

    // Check Billing page 3-pool cards DOM order
    const billingGrid = await screen.findByTestId('billing-three-pools');
    const billingChildren = Array.from(billingGrid.children).map((el) =>
      el.getAttribute('data-testid')
    );
    expect(billingChildren).toEqual([
      'billing-pool-card-trial',
      'billing-pool-card-subscription',
      'billing-pool-card-pack',
    ]);
  });

  it('intercepts 409 INSUFFICIENT_CREDITS in-place without clearing user prompt', async () => {
    vi.spyOn(api, 'quoteGeneration').mockResolvedValue({
      id: 'q-low-1',
      projectId: 'prj-1',
      credits: 20,
      pricingVersion: 'v1',
      expiresAt: '2026-12-01T00:00:00Z',
      mode: 'text_to_image',
      modelId: 'studio-image',
    });
    vi.spyOn(api, 'submitJob').mockRejectedValue(
      new ApiClientError({
        status: 409,
        code: 'INSUFFICIENT_CREDITS',
        message: 'Insufficient credits',
        requestId: 'req-insuff-1',
        details: { required: 20, available: 5, shortfall: 15 },
      })
    );

    render(
      <MemoryRouter initialEntries={['/studio']}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>
    );

    const promptInput = await screen.findByTestId('studio-prompt-input');
    const keptPrompt = '北欧木质书桌蓝牙音箱主图，保留金属机身 Logo';
    fireEvent.change(promptInput, { target: { value: keptPrompt } });

    fireEvent.click(screen.getByTestId('studio-submit-btn'));

    const modal = await screen.findByTestId('insufficient-credits-modal');
    expect(modal).toHaveTextContent('20 分');
    expect(modal).toHaveTextContent('5 分');
    expect(modal).toHaveTextContent('15 分');

    // Prompt state MUST remain 100% preserved!
    expect(screen.getByTestId('studio-prompt-input')).toHaveValue(keptPrompt);
  });
});
