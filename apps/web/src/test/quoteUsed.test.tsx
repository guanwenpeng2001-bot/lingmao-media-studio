import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api, ApiClientError } from '../api/client';
import type { Job, Session } from '../api/types';
import { AppRoutes } from '../App';
import { AppProvider, useApp } from '../state/AppContext';

const session: Session = {
  userId: 'usr-q',
  displayName: '报价测试',
  workspaceId: 'ws-q',
  role: 'owner',
  mode: 'sandbox',
  features: { virtual_tryon: false, org_collaboration: false, audio_studio: false },
};

const existingJob: Job = {
  id: 'job-existing-99',
  projectId: 'prj-1',
  canvasId: null,
  nodeId: null,
  status: 'running',
  input: {
    mode: 'text_to_image',
    modelId: 'studio-image',
    prompt: '重复报价定位测试图',
    inputAssetIds: [],
    parameters: { aspectRatio: '1:1' },
  },
  retryOfJobId: null,
  outputAssetIds: [],
  progress: 45,
  reservedCredits: 8,
  chargedCredits: 0,
  errorCode: null,
  retryable: false,
  createdAt: '2026-11-27T01:00:00Z',
  updatedAt: '2026-11-27T01:00:05Z',
  batchId: null,
  cancelRequested: false,
  revision: 2,
  charging: 'held',
  expectedCredits: 8,
};

const QuoteUsedHarness: React.FC<{ detailKey: 'existingJobId' | 'jobId' }> = ({ detailKey }) => {
  const { handleApiError } = useApp();
  return (
    <button
      type="button"
      data-testid="trigger-quote-used"
      onClick={() =>
        handleApiError(
          new ApiClientError({
            status: 409,
            code: 'QUOTE_USED',
            message: 'Quote already consumed',
            requestId: 'req-qu-1',
            details: { [detailKey]: existingJob.id },
          })
        )
      }
    >
      trigger
    </button>
  );
};

describe('P2-1 Explicit 409 QUOTE_USED Handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getSession').mockResolvedValue(session);
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
        availableCredits: 100,
        heldCredits: 8,
        spentCredits: 0,
        maxConcurrentJobs: 1,
        activeJobs: 1,
        allowedModelIds: [],
        asOf: '2026-11-27T01:00:00Z',
        watermark: true,
        storageLimitBytes: 1024 * 1024 * 1024,
        usedStorageBytes: 0,
        canvasNodeLimit: 30,
        walletLots: [],
        maxCanvasCount: 5,
        maxSeats: 1,
      },
    });
    vi.spyOn(api, 'listProjects').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, 'listJobs').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, 'getRecentCanvas').mockResolvedValue({ canvas: null });
    vi.spyOn(api, 'listTemplates').mockResolvedValue([]);
  });

  it.each(['existingJobId', 'jobId'] as const)(
    'locates existing job via details.%s, merges into task drawer and opens drawer',
    async (detailKey) => {
      const getJobSpy = vi.spyOn(api, 'getJob').mockResolvedValue(existingJob);

      render(
        <MemoryRouter initialEntries={['/explore']}>
          <AppProvider>
            <AppRoutes />
            <QuoteUsedHarness detailKey={detailKey} />
          </AppProvider>
        </MemoryRouter>
      );

      fireEvent.click(await screen.findByTestId('trigger-quote-used'));

      expect(await screen.findByText('该报价已提交为任务，已定位到原任务进度')).toBeInTheDocument();
      await waitFor(() => {
        expect(getJobSpy).toHaveBeenCalledWith('job-existing-99');
      });
      const drawer = await screen.findByRole('dialog', { name: '全局异步任务抽屉' });
      expect(drawer).toHaveTextContent('重复报价定位测试图');
    }
  );
});
