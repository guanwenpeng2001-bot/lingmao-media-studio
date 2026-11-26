import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api, ApiClientError } from '../api/client';
import type { Canvas, Session } from '../api/types';
import { AppRoutes } from '../App';
import { AppProvider, useApp } from '../state/AppContext';

const demoP0Session: Session = {
  userId: 'usr-p0',
  displayName: 'P0 测试用户',
  workspaceId: 'ws-p0',
  role: 'owner',
  mode: 'demo',
  features: {
    virtual_tryon: false,
    org_collaboration: false,
    audio_studio: false,
  },
};

const mockCanvas: Canvas = {
  summary: {
    id: 'cvs-p0',
    projectId: 'prj-p0',
    name: 'P0 画布',
    revision: 1,
    nodeCount: 0,
    coverAssetId: null,
    canEdit: true,
    updatedAt: '2026-11-26T08:00:00Z',
    status: 'active',
  },
  graph: { schemaVersion: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] },
};

describe('P1 Feature Flags Gating & 404 FEATURE_DISABLED Graceful Fallback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getSession').mockResolvedValue(demoP0Session);
    vi.spyOn(api, 'listModels').mockResolvedValue([]);
    vi.spyOn(api, 'getBillingState').mockResolvedValue({
      subscription: {
        planId: null,
        state: 'none',
        periodStart: null,
        periodEnd: null,
        cancelAtPeriodEnd: false,
      },
      checkoutMode: 'sandbox',
      entitlements: {
        availableCredits: 200,
        heldCredits: 0,
        spentCredits: 0,
        maxConcurrentJobs: 1,
        activeJobs: 0,
        allowedModelIds: [],
        asOf: '2026-11-26T08:00:00Z',
        watermark: true,
        storageLimitBytes: 1024 * 1024 * 1024,
        usedStorageBytes: 0,
        canvasNodeLimit: 30,
        walletLots: [{ id: 'lot-1', source: 'trial', available: 200, held: 0, expiresAt: null }],
        maxCanvasCount: 5,
        maxSeats: 1,
      },
    });
    vi.spyOn(api, 'listProjects').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, 'listJobs').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, 'getRecentCanvas').mockResolvedValue({ canvas: null });
    vi.spyOn(api, 'listCanvases').mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    vi.spyOn(api, 'listTemplates').mockResolvedValue([]);
    vi.spyOn(api, 'getPlatformPresets').mockResolvedValue([]);
    vi.spyOn(api, 'readCanvas').mockResolvedValue(mockCanvas);
    vi.spyOn(api, 'listAssets').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, 'listSubjects').mockResolvedValue([]);
  });

  it('hides org_collaboration UI, shows demo banner, and disables virtual_tryon in Ecommerce', async () => {
    render(
      <MemoryRouter initialEntries={['/canvases']}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>
    );

    // Demo/sandbox mode banner must be visible
    expect(await screen.findByTestId('demo-mode-banner')).toHaveTextContent('联调演示');
    // org_collaboration=false hides 组织管理 nav and canvas scope filter
    expect(screen.queryByText('组织管理')).not.toBeInTheDocument();
    expect(screen.queryByTestId('canvas-scope-filter')).not.toBeInTheDocument();
  });

  it('keeps grayed disabled audio placeholder in canvas editor when audio_studio=false', async () => {
    render(
      <MemoryRouter initialEntries={['/canvases/cvs-p0']}>
        <AppProvider>
          <AppRoutes />
        </AppProvider>
      </MemoryRouter>
    );

    const audioBtn = await screen.findByTestId('palette-audio-node');
    expect(audioBtn).toBeDisabled();
    expect(audioBtn).toHaveTextContent('音频/配音节点');
    expect(audioBtn).toHaveTextContent('即将上线');
  });

  it('handles 404 FEATURE_DISABLED gracefully without crashing or deducting credits', async () => {
    const TriggerDisabledFeature = () => {
      const { handleApiError } = useApp();
      return (
        <button
          type="button"
          data-testid="trigger-feature-disabled"
          onClick={() =>
            handleApiError(
              new ApiClientError({
                status: 404,
                code: 'FEATURE_DISABLED',
                message: 'virtual_tryon is disabled in P0',
                requestId: 'req-fd-1',
              })
            )
          }
        >
          trigger
        </button>
      );
    };

    render(
      <MemoryRouter initialEntries={['/ecommerce']}>
        <AppProvider>
          <AppRoutes />
          <TriggerDisabledFeature />
        </AppProvider>
      </MemoryRouter>
    );

    const tryonBtn = await screen.findByTestId('ecom-tryon-placeholder');
    expect(tryonBtn).toHaveTextContent('P1 即将上线');

    fireEvent.click(screen.getByTestId('trigger-feature-disabled'));
    expect(await screen.findByText('该进阶功能将在下一阶段开放')).toBeInTheDocument();
    expect(screen.getByText(/未扣除任何积分/)).toBeInTheDocument();
  });
});
