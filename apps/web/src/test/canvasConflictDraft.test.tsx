import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api, ApiClientError } from '../api/client';
import type { Canvas, Session } from '../api/types';
import { CanvasEditorPage } from '../features/canvases/CanvasEditorPage';
import { clearMemoryDraftStoreForTest, loadLatestCanvasDraft } from '../lib/idbDrafts';
import { AppProvider } from '../state/AppContext';

const mockSession: Session = {
  userId: 'usr-1',
  displayName: '测试商家',
  workspaceId: 'ws-1',
  role: 'owner',
  mode: 'live',
  features: {
    virtual_tryon: false,
    org_collaboration: false,
    audio_studio: false,
  },
};

const initialCanvas: Canvas = {
  summary: {
    id: 'cvs-1',
    projectId: 'prj-1',
    name: '双11主图画布',
    revision: 3,
    nodeCount: 1,
    coverAssetId: null,
    canEdit: true,
    updatedAt: '2026-11-26T08:00:00Z',
    status: 'active',
  },
  graph: {
    schemaVersion: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'n1', type: 'text', label: '提示词', text: '旧文案', position: { x: 100, y: 100 } },
    ],
    edges: [],
  },
};

describe('409 CANVAS_CONFLICT IndexedDB Draft Retention & Recovery Flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearMemoryDraftStoreForTest();
    vi.spyOn(api, 'getSession').mockResolvedValue(mockSession);
    vi.spyOn(api, 'listModels').mockResolvedValue([]);
    vi.spyOn(api, 'getBillingState').mockResolvedValue({
      subscription: {
        planId: 'pro-year',
        state: 'active',
        periodStart: '2026-01-01T00:00:00Z',
        periodEnd: '2027-01-01T00:00:00Z',
        cancelAtPeriodEnd: false,
      },
      checkoutMode: 'live',
      entitlements: {
        availableCredits: 200,
        heldCredits: 0,
        spentCredits: 0,
        maxConcurrentJobs: 4,
        activeJobs: 0,
        allowedModelIds: [],
        asOf: '2026-11-26T08:00:00Z',
        watermark: false,
        storageLimitBytes: 1024 * 1024 * 1024,
        usedStorageBytes: 0,
        canvasNodeLimit: 200,
        walletLots: [],
        maxCanvasCount: 100,
        maxSeats: 1,
      },
    });
    vi.spyOn(api, 'listProjects').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, 'listJobs').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, 'getRecentCanvas').mockResolvedValue({ canvas: initialCanvas.summary });
    vi.spyOn(api, 'listAssets').mockResolvedValue({ items: [], nextCursor: null });
    vi.spyOn(api, 'listSubjects').mockResolvedValue([]);
  });

  it('persists local draft on 409 CANVAS_CONFLICT and supports both Save-as-Copy and Reload-Latest', async () => {
    const readSpy = vi.spyOn(api, 'readCanvas').mockResolvedValue(initialCanvas);
    vi.spyOn(api, 'saveCanvas').mockRejectedValueOnce(
      new ApiClientError({
        status: 409,
        code: 'CANVAS_CONFLICT',
        message: 'Revision mismatch',
        requestId: 'req-conflict-1',
        details: { currentRevision: 5 },
      })
    );

    render(
      <MemoryRouter initialEntries={['/canvases/cvs-1']}>
        <AppProvider>
          <Routes>
            <Route path="/canvases/:canvasId" element={<CanvasEditorPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>
    );

    const saveBtn = await screen.findByTestId('canvas-save-btn');
    fireEvent.click(saveBtn);

    // Conflict banner appears with both actions
    const banner = await screen.findByTestId('canvas-conflict-banner');
    expect(banner).toHaveTextContent('版本冲突');
    expect(banner).toHaveTextContent('v5');

    // Draft is preserved scoped by userId + workspaceId + canvasId + baseRevision
    const draft = await loadLatestCanvasDraft({
      userId: 'usr-1',
      workspaceId: 'ws-1',
      canvasId: 'cvs-1',
    });
    expect(draft).not.toBeNull();
    expect(draft?.baseRevision).toBe(3);
    expect(draft?.reason).toBe('conflict');

    // Test "另存为副本" (Save as Copy)
    const copyCanvas: Canvas = {
      ...initialCanvas,
      summary: { ...initialCanvas.summary, id: 'cvs-copy-2', revision: 1, name: '双11主图画布（冲突副本）' },
    };
    const createCopySpy = vi.spyOn(api, 'createCanvas').mockResolvedValue(copyCanvas);
    const saveCopySpy = vi.spyOn(api, 'saveCanvas').mockResolvedValue({
      ...copyCanvas,
      summary: { ...copyCanvas.summary, revision: 2 },
    });

    fireEvent.click(screen.getByTestId('conflict-save-copy-btn'));

    await waitFor(() => {
      expect(createCopySpy).toHaveBeenCalledWith('prj-1', expect.objectContaining({ name: expect.stringContaining('冲突副本') }));
      expect(saveCopySpy).toHaveBeenCalledWith('cvs-copy-2', expect.objectContaining({ baseRevision: 1 }));
    });

    expect(readSpy).toHaveBeenCalled();
  });

  it('reloads latest server revision and clears local draft when user clicks 重新载入最新画布', async () => {
    const latestCanvas: Canvas = {
      ...initialCanvas,
      summary: { ...initialCanvas.summary, revision: 5, name: '双11主图画布（云端最新）' },
    };
    const readSpy = vi
      .spyOn(api, 'readCanvas')
      .mockResolvedValueOnce(initialCanvas)
      .mockResolvedValueOnce(latestCanvas);
    vi.spyOn(api, 'saveCanvas').mockRejectedValueOnce(
      new ApiClientError({
        status: 409,
        code: 'CANVAS_CONFLICT',
        message: 'Revision mismatch',
        requestId: 'req-conflict-2',
        details: { currentRevision: 5 },
      })
    );

    render(
      <MemoryRouter initialEntries={['/canvases/cvs-1']}>
        <AppProvider>
          <Routes>
            <Route path="/canvases/:canvasId" element={<CanvasEditorPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByTestId('canvas-save-btn'));
    await screen.findByTestId('canvas-conflict-banner');

    fireEvent.click(screen.getByTestId('conflict-reload-btn'));
    await waitFor(() => {
      expect(readSpy).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('canvas-conflict-banner')).not.toBeInTheDocument();
    });
    expect(screen.getByText(/已保存 v5/)).toBeInTheDocument();
  });
});
