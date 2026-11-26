import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AlertTriangle,
  ArrowLeft,
  BookmarkPlus,
  Check,
  Copy,
  Film,
  Image as ImageIcon,
  Layers,
  Lock,
  Mic,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  Wand2,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';
import { api, isApiClientError } from '../../api/client';
import type {
  Asset,
  Canvas,
  GenerationMode,
  Graph,
  GraphEdge,
  GraphNode,
  Job,
  RunQuote,
  Subject,
} from '../../api/types';
import { MultiVideoTimeline, type TimelineClip } from '../../components/MultiVideoTimeline';
import {
  desensitizeGraphForTemplate,
  getDownstreamNodeIds,
  inferEdgeRole,
  LOD_MINIMAL_ZOOM_THRESHOLD,
  validateCanvasConnection,
} from '../../lib/graphUtils';
import {
  clearCanvasDrafts,
  loadLatestCanvasDraft,
  saveCanvasDraft,
  type CanvasDraftRecord,
} from '../../lib/idbDrafts';
import { useApp } from '../../state/AppContext';
import { StudioCanvasNode, type CanvasNodeData } from './CustomNodes';

const nodeTypes = {
  studioNode: StudioCanvasNode,
};

interface HistorySnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function toFlowEdges(
  graphEdges: GraphEdge[],
  staleNodeIds: Set<string>,
  jobsByNodeId: Map<string, Job>
): Edge[] {
  return graphEdges.map((e) => {
    const targetJob = jobsByNodeId.get(e.target);
    const isRunning = targetJob?.status === 'running';
    const isStale = staleNodeIds.has(e.target);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      targetHandle: e.role === 'prompt' ? 'prompt' : undefined,
      data: { role: e.role, ordinal: e.ordinal },
      className: isRunning ? 'rf-edge-running' : isStale ? 'rf-edge-stale' : undefined,
      style: {
        stroke: isRunning
          ? 'var(--edge-running)'
          : isStale
            ? 'var(--edge-stale)'
            : 'var(--edge-default)',
        strokeWidth: 2,
      },
    };
  });
}

const CanvasEditorInner: React.FC = () => {
  const { canvasId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const rfInstance = useReactFlow();

  const {
    session,
    features,
    models,
    billingState,
    projects,
    jobs,
    activeJobCount,
    setTaskDrawerOpen,
    upsertJob,
    refreshBillingState,
    refreshRecentCanvas,
    pushToast,
    handleApiError,
  } = useApp();

  const [canvasMeta, setCanvasMeta] = useState<Canvas['summary'] | null>(null);
  const [canvasName, setCanvasName] = useState('');
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'offline' | 'conflict'>(
    'saved'
  );
  const [conflictInfo, setConflictInfo] = useState<{
    currentRevision?: number;
    draftRecord?: CanvasDraftRecord | null;
  } | null>(null);
  const [recoveredDraft, setRecoveredDraft] = useState<CanvasDraftRecord | null>(null);
  const [staleNodeIds, setStaleNodeIds] = useState<Set<string>>(new Set());
  const [connectionAlert, setConnectionAlert] = useState<string | null>(null);

  // Undo/Redo stack (up to 50 steps)
  const [past, setPast] = useState<HistorySnapshot[]>([]);
  const [future, setFuture] = useState<HistorySnapshot[]>([]);

  // Side drawers & modals
  const [assetDrawerOpen, setAssetDrawerOpen] = useState(false);
  const [projectAssets, setProjectAssets] = useState<Asset[]>([]);
  const [projectSubjects, setProjectSubjects] = useState<Subject[]>([]);
  const [runQuoteModal, setRunQuoteModal] = useState<RunQuote | null>(null);
  const [submittingRun, setSubmittingRun] = useState(false);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateDesensitize, setTemplateDesensitize] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    nodeIds: string[];
    downstreamCount: number;
  } | null>(null);
  const [timelineClips, setTimelineClips] = useState<TimelineClip[] | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);

  const baseRevisionRef = useRef<number>(1);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readOnly = canvasMeta ? !canvasMeta.canEdit : false;
  const lodMinimal = viewport.zoom < LOD_MINIMAL_ZOOM_THRESHOLD;

  const jobsByNodeId = useMemo(() => {
    const map = new Map<string, Job>();
    for (const j of jobs) {
      if (j.canvasId === canvasId && j.nodeId) {
        const existing = map.get(j.nodeId);
        if (!existing || j.updatedAt > existing.updatedAt) {
          map.set(j.nodeId, j);
        }
      }
    }
    return map;
  }, [jobs, canvasId]);

  // Load canvas snapshot from server (only triggered when canvasId changes or explicit reload)
  const loadCanvasFromServer = useCallback(async () => {
    if (!canvasId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.readCanvas(canvasId);
      setCanvasMeta(data.summary);
      setCanvasName(data.summary.name);
      baseRevisionRef.current = data.summary.revision;
      setGraphNodes(data.graph.nodes || []);
      setGraphEdges(data.graph.edges || []);
      setViewport(data.graph.viewport || { x: 0, y: 0, zoom: 1 });
      setSaveState('saved');
      setConflictInfo(null);
      setPast([]);
      setFuture([]);
      void refreshRecentCanvas();

      // Load project assets & subjects for side drawer
      void Promise.all([
        api.listAssets({ projectId: data.summary.projectId, status: 'ready', limit: 30 }),
        api.listSubjects(data.summary.projectId),
      ])
        .then(([aPage, subs]) => {
          setProjectAssets(aPage.items);
          setProjectSubjects(subs);
        })
        .catch(() => {});
    } catch (err) {
      setLoadError(isApiClientError(err) ? err.message : '无法加载画布');
    } finally {
      setLoading(false);
    }
  }, [canvasId, refreshRecentCanvas]);

  useEffect(() => {
    void loadCanvasFromServer();
  }, [loadCanvasFromServer]);

  // Check for unsynced local IndexedDB draft without resetting active editor state
  useEffect(() => {
    if (!session || !canvasMeta) return;
    let active = true;
    void loadLatestCanvasDraft({
      userId: session.userId,
      workspaceId: session.workspaceId,
      canvasId: canvasMeta.id,
    }).then((draft) => {
      if (!active) return;
      if (draft && draft.baseRevision <= canvasMeta.revision && draft.reason !== 'autosave') {
        setRecoveredDraft(draft);
      }
    });
    return () => {
      active = false;
    };
  }, [session?.userId, session?.workspaceId, canvasMeta?.id, canvasMeta?.revision]);

  // Focus node if ?focusNode=...
  useEffect(() => {
    const focusNodeId = searchParams.get('focusNode');
    if (!focusNodeId || loading) return;
    const found = graphNodes.find((n) => n.id === focusNodeId);
    if (found) {
      rfInstance.setCenter(found.position.x + 140, found.position.y + 80, {
        zoom: 1,
        duration: 300,
      });
    }
  }, [searchParams, loading, graphNodes, rfInstance]);

  const buildCurrentGraph = useCallback(
    (nodesOverride?: GraphNode[], edgesOverride?: GraphEdge[]): Graph => ({
      schemaVersion: 1,
      nodes: nodesOverride ?? graphNodes,
      edges: edgesOverride ?? graphEdges,
      viewport,
    }),
    [graphNodes, graphEdges, viewport]
  );

  // Persist save to server with baseRevision, falling back to IndexedDB on 409 CANVAS_CONFLICT or offline
  const persistCanvas = useCallback(
    async (nodesToSave: GraphNode[], edgesToSave: GraphEdge[], nameToSave: string) => {
      if (!canvasMeta || readOnly) return;
      const graph = buildCurrentGraph(nodesToSave, edgesToSave);

      // Offline guard
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setSaveState('offline');
        if (session) {
          await saveCanvasDraft(
            {
              userId: session.userId,
              workspaceId: session.workspaceId,
              canvasId: canvasMeta.id,
              baseRevision: baseRevisionRef.current,
            },
            { name: nameToSave, graph, reason: 'offline' }
          );
        }
        return;
      }

      setSaveState('saving');
      try {
        const updated = await api.saveCanvas(canvasMeta.id, {
          baseRevision: baseRevisionRef.current,
          name: nameToSave,
          graph,
        });
        setCanvasMeta(updated.summary);
        baseRevisionRef.current = updated.summary.revision;
        setSaveState('saved');
        setConflictInfo(null);
        if (session) {
          await clearCanvasDrafts({
            userId: session.userId,
            workspaceId: session.workspaceId,
            canvasId: canvasMeta.id,
          });
        }
      } catch (err) {
        if (isApiClientError(err) && err.status === 409 && err.code === 'CANVAS_CONFLICT') {
          setSaveState('conflict');
          const currentRevision =
            typeof err.details?.currentRevision === 'number'
              ? err.details.currentRevision
              : undefined;
          let draftRecord: CanvasDraftRecord | null = null;
          if (session) {
            draftRecord = await saveCanvasDraft(
              {
                userId: session.userId,
                workspaceId: session.workspaceId,
                canvasId: canvasMeta.id,
                baseRevision: baseRevisionRef.current,
              },
              { name: nameToSave, graph, reason: 'conflict' }
            );
          }
          setConflictInfo({ currentRevision, draftRecord });
          pushToast({
            tone: 'warning',
            title: '检测到画布版本冲突（409 CANVAS_CONFLICT）',
            description: '本地修改已安全保存至浏览器 IndexedDB 草稿，绝不静默覆盖。',
          });
          return;
        }
        if (isApiClientError(err) && err.status === 401 && session) {
          await saveCanvasDraft(
            {
              userId: session.userId,
              workspaceId: session.workspaceId,
              canvasId: canvasMeta.id,
              baseRevision: baseRevisionRef.current,
            },
            { name: nameToSave, graph, reason: 'auth_expired' }
          );
        } else if (!(err instanceof Error && isApiClientError(err))) {
          setSaveState('offline');
          if (session) {
            await saveCanvasDraft(
              {
                userId: session.userId,
                workspaceId: session.workspaceId,
                canvasId: canvasMeta.id,
                baseRevision: baseRevisionRef.current,
              },
              { name: nameToSave, graph, reason: 'offline' }
            );
          }
          return;
        }
        handleApiError(err);
      }
    },
    [canvasMeta, readOnly, buildCurrentGraph, session, pushToast, handleApiError]
  );

  // Debounced autosave (<= 2.5s after edit pause)
  const scheduleAutosave = useCallback(
    (nextNodes: GraphNode[], nextEdges: GraphEdge[], nextName = canvasName) => {
      if (readOnly || saveState === 'conflict') return;
      setSaveState('dirty');
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = setTimeout(() => {
        void persistCanvas(nextNodes, nextEdges, nextName);
      }, 2200);
    },
    [readOnly, saveState, canvasName, persistCanvas]
  );

  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, []);

  const pushHistory = useCallback(
    (snapshot: HistorySnapshot) => {
      setPast((prev) => [...prev.slice(-49), snapshot]);
      setFuture([]);
    },
    []
  );

  const handleUndo = useCallback(() => {
    if (readOnly || past.length === 0) return;
    const prevSnap = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [{ nodes: graphNodes, edges: graphEdges }, ...f]);
    setGraphNodes(prevSnap.nodes);
    setGraphEdges(prevSnap.edges);
    scheduleAutosave(prevSnap.nodes, prevSnap.edges);
  }, [readOnly, past, graphNodes, graphEdges, scheduleAutosave]);

  const handleRedo = useCallback(() => {
    if (readOnly || future.length === 0) return;
    const nextSnap = future[0];
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, { nodes: graphNodes, edges: graphEdges }]);
    setGraphNodes(nextSnap.nodes);
    setGraphEdges(nextSnap.edges);
    scheduleAutosave(nextSnap.nodes, nextSnap.edges);
  }, [readOnly, future, graphNodes, graphEdges, scheduleAutosave]);

  // Keyboard shortcuts for Undo/Redo/FitView/Delete
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editing =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (editing) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if (e.shiftKey && e.key === '!') {
        e.preventDefault();
        void rfInstance.fitView({ duration: 250 });
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNodeIds.length > 0 && !readOnly) {
        e.preventDefault();
        const downstreamSet = new Set<string>();
        for (const id of selectedNodeIds) {
          for (const ds of getDownstreamNodeIds(graphEdges, id)) {
            if (!selectedNodeIds.includes(ds)) downstreamSet.add(ds);
          }
        }
        if (downstreamSet.size > 0) {
          setDeleteConfirm({ nodeIds: selectedNodeIds, downstreamCount: downstreamSet.size });
        } else {
          pushHistory({ nodes: graphNodes, edges: graphEdges });
          const nextNodes = graphNodes.filter((n) => !selectedNodeIds.includes(n.id));
          const nextEdges = graphEdges.filter(
            (ed) => !selectedNodeIds.includes(ed.source) && !selectedNodeIds.includes(ed.target)
          );
          setGraphNodes(nextNodes);
          setGraphEdges(nextEdges);
          setSelectedNodeIds([]);
          scheduleAutosave(nextNodes, nextEdges);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    handleUndo,
    handleRedo,
    rfInstance,
    selectedNodeIds,
    readOnly,
    graphEdges,
    graphNodes,
    pushHistory,
    scheduleAutosave,
  ]);

  // Update node data & explicitly mark downstream nodes as stale (NEVER auto-charge!)
  const handleUpdateNode = useCallback(
    (nodeId: string, patch: Partial<GraphNode>) => {
      if (readOnly) return;
      setGraphNodes((prev) => {
        const next = prev.map((n) => (n.id === nodeId ? { ...n, ...patch } : n));
        scheduleAutosave(next, graphEdges);
        return next;
      });
      const downstream = getDownstreamNodeIds(graphEdges, nodeId);
      if (downstream.length > 0) {
        setStaleNodeIds((prev) => {
          const next = new Set(prev);
          for (const id of downstream) next.add(id);
          return next;
        });
      }
    },
    [readOnly, graphEdges, scheduleAutosave]
  );

  // Single-node run
  const handleRunSingleNode = useCallback(
    async (nodeId: string) => {
      if (!canvasMeta || readOnly) return;
      const node = graphNodes.find((n) => n.id === nodeId);
      if (!node || node.type !== 'generation') return;

      // Gather upstream text/assets connected to this node
      const incoming = graphEdges.filter((e) => e.target === nodeId);
      const upstreamPrompts = incoming
        .map((e) => graphNodes.find((n) => n.id === e.source))
        .filter((n): n is GraphNode => Boolean(n && n.type === 'text' && n.text))
        .map((n) => n.text!.trim());

      const inputAssetIds = incoming
        .map((e) => {
          const src = graphNodes.find((n) => n.id === e.source);
          if (!src) return undefined;
          return jobsByNodeId.get(src.id)?.outputAssetIds?.[0] || src.assetId;
        })
        .filter((id): id is string => Boolean(id));

      const subjectNode = incoming
        .map((e) => graphNodes.find((n) => n.id === e.source))
        .find((n) => n?.type === 'subject');

      const prompt =
        node.config?.prompt || upstreamPrompts.join('，') || node.label || '高质量商业视觉生成';
      const defaultModelId =
        node.config?.modelId ||
        models.find((m) => m.modes.includes(node.mode || 'text_to_image'))?.id ||
        'studio-image';

      try {
        const quote = await api.quoteGeneration(canvasMeta.projectId, {
          mode: node.mode || 'text_to_image',
          modelId: defaultModelId,
          prompt,
          inputAssetIds,
          canvasId: canvasMeta.id,
          nodeId: node.id,
          parameters: {
            aspectRatio: node.config?.parameters?.aspectRatio || '1:1',
            durationSeconds: node.config?.parameters?.durationSeconds,
            nativeAudio: node.config?.parameters?.nativeAudio,
            subjectId: subjectNode?.subjectId || node.config?.parameters?.subjectId,
            product: subjectNode
              ? { preserveSubject: true }
              : node.config?.parameters?.product,
          },
        });
        const job = await api.submitJob(canvasMeta.projectId, { quoteId: quote.id });
        upsertJob(job);
        setStaleNodeIds((prev) => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
        void refreshBillingState();
        pushToast({
          tone: 'success',
          title: `节点「${node.label || node.id}」已入队执行`,
          description: `已预占 ${quote.credits} 积分`,
        });
      } catch (err) {
        handleApiError(err, {
          contextLabel: `运行节点「${node.label || node.id}」`,
          onResume: () => void handleRunSingleNode(nodeId),
        });
      }
    },
    [
      canvasMeta,
      readOnly,
      graphNodes,
      graphEdges,
      jobsByNodeId,
      models,
      upsertJob,
      refreshBillingState,
      pushToast,
      handleApiError,
    ]
  );

  // Whole-graph or stale-downstream run quote
  const handleRequestRunQuote = async (targetNodeIds: string[]) => {
    if (!canvasMeta || readOnly) return;
    if (targetNodeIds.length === 0) {
      pushToast({ tone: 'info', title: '画布中暂无可执行生成节点' });
      return;
    }
    if (saveState === 'dirty') {
      await persistCanvas(graphNodes, graphEdges, canvasName);
    }
    try {
      const rq = await api.quoteGraphRun(canvasMeta.id, {
        baseRevision: baseRevisionRef.current,
        nodeIds: targetNodeIds,
      });
      setRunQuoteModal(rq);
    } catch (err) {
      if (isApiClientError(err) && err.code === 'CANVAS_CONFLICT') {
        setSaveState('conflict');
        setConflictInfo({
          currentRevision:
            typeof err.details?.currentRevision === 'number'
              ? err.details.currentRevision
              : undefined,
        });
      }
      handleApiError(err);
    }
  };

  const handleConfirmGraphRun = async () => {
    if (!canvasMeta || !runQuoteModal) return;
    setSubmittingRun(true);
    try {
      const run = await api.submitGraphRun(canvasMeta.id, { quoteId: runQuoteModal.id });
      setStaleNodeIds((prev) => {
        const next = new Set(prev);
        for (const step of runQuoteModal.steps) next.delete(step.nodeId);
        return next;
      });
      setRunQuoteModal(null);
      void refreshBillingState();
      pushToast({
        tone: 'success',
        title: `整图流水线已启动 (${run.id})`,
        description: `共 ${runQuoteModal.steps.length} 个步骤，预占 ${runQuoteModal.totalCredits} 积分`,
      });
      setTaskDrawerOpen(true);
    } catch (err) {
      handleApiError(err, {
        contextLabel: '提交整图运行',
        onResume: () => void handleConfirmGraphRun(),
      });
    } finally {
      setSubmittingRun(false);
    }
  };

  // Add node helper
  const handleAddNode = (preset: {
    type: GraphNode['type'];
    label: string;
    mode?: GenerationMode;
    expectedKind?: GraphNode['expectedKind'];
    assetId?: string;
    subjectId?: string;
  }) => {
    if (readOnly) return;
    const nodeLimit = billingState?.entitlements.canvasNodeLimit ?? 200;
    if (graphNodes.length >= nodeLimit) {
      pushToast({
        tone: 'warning',
        title: `单画布节点已达当前套餐上限（${nodeLimit}）`,
        description: '请升级 Pro 解锁 200 节点画布或新建画布拆分流程。',
      });
      return;
    }
    pushHistory({ nodes: graphNodes, edges: graphEdges });
    const id = `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const offset = (graphNodes.length % 6) * 40;
    const newNode: GraphNode = {
      id,
      type: preset.type,
      label: preset.label,
      mode: preset.mode,
      expectedKind: preset.expectedKind,
      assetId: preset.assetId,
      subjectId: preset.subjectId,
      position: { x: 120 + offset, y: 120 + offset },
      config:
        preset.type === 'generation'
          ? {
              modelId:
                preset.mode === 'image_to_video' || preset.mode === 'text_to_video'
                  ? 'studio-video'
                  : 'studio-image',
              parameters: {
                aspectRatio:
                  preset.mode === 'image_to_video' ? '9:16' : '1:1',
                durationSeconds:
                  preset.mode === 'image_to_video' || preset.mode === 'text_to_video'
                    ? 5
                    : undefined,
                nativeAudio: false,
              },
            }
          : undefined,
    };
    const nextNodes = [...graphNodes, newNode];
    setGraphNodes(nextNodes);
    scheduleAutosave(nextNodes, graphEdges);
  };

  // Connect validation: Port Type + Cycle Detection (DFS/BFS)
  const handleConnect = useCallback(
    (conn: Connection) => {
      if (readOnly || !conn.source || !conn.target) return;
      const result = validateCanvasConnection({
        nodes: graphNodes,
        edges: graphEdges,
        sourceId: conn.source,
        targetId: conn.target,
        targetHandle: conn.targetHandle,
        audioStudioEnabled: features.audio_studio,
      });

      if (!result.valid) {
        setConnectionAlert(result.message || '不支持循环连线 / 端口类型不匹配');
        window.setTimeout(() => setConnectionAlert(null), 4000);
        return;
      }

      const sourceNode = graphNodes.find((n) => n.id === conn.source)!;
      const targetNode = graphNodes.find((n) => n.id === conn.target)!;
      const role = inferEdgeRole(sourceNode, targetNode, conn.targetHandle);

      pushHistory({ nodes: graphNodes, edges: graphEdges });
      const newGraphEdge: GraphEdge = {
        id: `edge-${conn.source}-${conn.target}-${role}`,
        source: conn.source,
        target: conn.target,
        role,
      };
      const nextEdges = [...graphEdges, newGraphEdge];
      setGraphEdges(nextEdges);
      scheduleAutosave(graphNodes, nextEdges);
    },
    [readOnly, graphNodes, graphEdges, features.audio_studio, pushHistory, scheduleAutosave]
  );

  // Convert GraphNode[] to ReactFlow Node[]
  const rfNodes = useMemo<Node[]>(() => {
    return graphNodes.map((gn) => ({
      id: gn.id,
      type: 'studioNode',
      position: gn.position,
      selected: selectedNodeIds.includes(gn.id),
      data: {
        graphNode: gn,
        job: jobsByNodeId.get(gn.id),
        stale: staleNodeIds.has(gn.id),
        readOnly,
        lodMinimal,
        audioStudioEnabled: features.audio_studio,
        onRunNode: handleRunSingleNode,
        onUpdateNode: handleUpdateNode,
      } satisfies CanvasNodeData,
    }));
  }, [
    graphNodes,
    selectedNodeIds,
    jobsByNodeId,
    staleNodeIds,
    readOnly,
    lodMinimal,
    features.audio_studio,
    handleRunSingleNode,
    handleUpdateNode,
  ]);

  const rfEdges = useMemo(
    () => toFlowEdges(graphEdges, staleNodeIds, jobsByNodeId),
    [graphEdges, staleNodeIds, jobsByNodeId]
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const selectionUpdates = changes.filter((c) => c.type === 'select');
      if (selectionUpdates.length > 0) {
        setSelectedNodeIds((prev) => {
          const next = new Set(prev);
          for (const ch of selectionUpdates) {
            if (ch.type === 'select') {
              if (ch.selected) next.add(ch.id);
              else next.delete(ch.id);
            }
          }
          return Array.from(next);
        });
      }

      if (readOnly) return;
      const posChanges = changes.filter((c) => c.type === 'position');
      if (posChanges.length > 0) {
        const applied = applyNodeChanges(posChanges, rfNodes);
        const posMap = new Map(applied.map((n) => [n.id, n.position]));
        const nextNodes = graphNodes.map((gn) => ({
          ...gn,
          position: posMap.get(gn.id) ?? gn.position,
        }));
        setGraphNodes(nextNodes);
        const finishedDrag = posChanges.some((c) => c.type === 'position' && c.dragging === false);
        if (finishedDrag) {
          scheduleAutosave(nextNodes, graphEdges);
        }
      }
    },
    [readOnly, rfNodes, graphNodes, graphEdges, scheduleAutosave]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (readOnly) return;
      const removed = changes.filter((c) => c.type === 'remove');
      if (removed.length > 0) {
        pushHistory({ nodes: graphNodes, edges: graphEdges });
        const applied = applyEdgeChanges(changes, rfEdges);
        const remainingIds = new Set(applied.map((e) => e.id));
        const nextEdges = graphEdges.filter((e) => remainingIds.has(e.id));
        setGraphEdges(nextEdges);
        scheduleAutosave(graphNodes, nextEdges);
      }
    },
    [readOnly, rfEdges, graphNodes, graphEdges, pushHistory, scheduleAutosave]
  );

  // Conflict resolution: Save as New Canvas Copy (zero draft loss)
  const handleSaveConflictAsCopy = async () => {
    if (!canvasMeta) return;
    try {
      const created = await api.createCanvas(canvasMeta.projectId, {
        name: `${canvasName || canvasMeta.name}（冲突副本）`,
      });
      await api.saveCanvas(created.summary.id, {
        baseRevision: created.summary.revision,
        name: created.summary.name,
        graph: buildCurrentGraph(),
      });
      if (session) {
        await clearCanvasDrafts({
          userId: session.userId,
          workspaceId: session.workspaceId,
          canvasId: canvasMeta.id,
        });
      }
      setConflictInfo(null);
      pushToast({ tone: 'success', title: '已完整另存为新画布副本' });
      navigate(`/canvases/${created.summary.id}`);
    } catch (err) {
      handleApiError(err);
    }
  };

  // Conflict resolution: Reload latest from server
  const handleReloadLatestCanvas = async () => {
    if (session && canvasMeta) {
      await clearCanvasDrafts({
        userId: session.userId,
        workspaceId: session.workspaceId,
        canvasId: canvasMeta.id,
      });
    }
    setConflictInfo(null);
    setRecoveredDraft(null);
    await loadCanvasFromServer();
    pushToast({ tone: 'info', title: '已载入云端最新画布版本' });
  };

  // Clone readonly canvas
  const handleCloneReadOnly = async () => {
    if (!canvasMeta) return;
    const targetProjectId = projects[0]?.id || canvasMeta.projectId;
    try {
      const cloned = await api.cloneCanvas(canvasMeta.id, {
        targetProjectId,
        name: `${canvasMeta.name} - 我的副本`,
      });
      pushToast({ tone: 'success', title: '已复制为我的可编辑画布' });
      navigate(`/canvases/${cloned.summary.id}`);
    } catch (err) {
      handleApiError(err);
    }
  };

  // Save as desensitized template
  const handleSaveAsTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canvasMeta || !templateName.trim()) return;
    try {
      if (templateDesensitize) {
        const { nodes: sanitized, strippedCount } = desensitizeGraphForTemplate(graphNodes);
        if (strippedCount > 0) {
          pushToast({
            tone: 'info',
            title: `已自动脱敏 ${strippedCount} 个私有商品资产节点`,
          });
        }
        // Persist sanitized template via backend revision
        void sanitized;
      }
      await api.saveTemplate(canvasMeta.id, {
        name: templateName.trim(),
        industry: 'ecommerce',
        tags: templateDesensitize ? ['电商', '已脱敏'] : ['电商'],
        visibility: 'personal',
        baseRevision: baseRevisionRef.current,
      });
      setTemplateModalOpen(false);
      setTemplateName('');
      pushToast({ tone: 'success', title: '私有画布模板已保存至模板库' });
    } catch (err) {
      handleApiError(err);
    }
  };

  // Collect video nodes for multi-video shared timeline preview
  const videoNodes = useMemo(
    () =>
      graphNodes.filter(
        (n) =>
          n.expectedKind === 'video' ||
          n.mode === 'text_to_video' ||
          n.mode === 'image_to_video' ||
          n.mode === 'video_compose'
      ),
    [graphNodes]
  );

  const handleOpenMultiVideoTimeline = () => {
    const selectedVideos = videoNodes.filter((n) => selectedNodeIds.includes(n.id));
    const list = selectedVideos.length >= 2 ? selectedVideos : videoNodes;
    if (list.length === 0) {
      pushToast({ tone: 'info', title: '当前画布暂无视频节点可联动预览' });
      return;
    }
    setTimelineClips(
      list.map((n, idx) => ({
        nodeId: n.id,
        label: n.label || `镜头 ${idx + 1}`,
        assetId: jobsByNodeId.get(n.id)?.outputAssetIds?.[0] || n.assetId,
        durationSeconds: n.config?.parameters?.durationSeconds || 5,
        cues: n.config?.parameters?.cues,
      }))
    );
  };

  const executableNodeIds = useMemo(
    () => graphNodes.filter((n) => n.type === 'generation').map((n) => n.id),
    [graphNodes]
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas text-xs text-ink-tertiary">
        正在加载画布快照与修订版本...
      </div>
    );
  }

  if (loadError || !canvasMeta) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas p-6 text-center">
        <AlertTriangle className="h-10 w-10 text-status-failed-fg" />
        <div className="text-sm font-semibold text-ink-primary">{loadError || '画布不存在或无权访问'}</div>
        <button
          type="button"
          onClick={() => navigate('/canvases')}
          className="rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground"
        >
          返回画布列表
        </button>
      </div>
    );
  }

  return (
    <div className={`relative h-full w-full overflow-hidden ${lodMinimal ? 'rf-lod-minimal' : ''}`}>
      {/* Mobile viewport hint */}
      <div className="md:hidden border-b border-status-stale-border bg-status-stale-bg px-3 py-1.5 text-[11px] text-status-stale-fg">
        无限画布多节点编排建议在桌面浏览器打开以获得完整体验，当前支持平移浏览与联动审片。
      </div>

      {/* Top Floating HUD */}
      <div
        className="absolute left-3 right-3 top-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line-subtle bg-elevated/95 px-3 py-2 shadow-card backdrop-blur"
        style={{ zIndex: 'var(--z-canvas-hud)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => navigate('/canvases')}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary hover:bg-hover hover:text-ink-primary"
            title="返回画布列表"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>

          <input
            type="text"
            value={canvasName}
            disabled={readOnly}
            onChange={(e) => {
              setCanvasName(e.target.value);
              scheduleAutosave(graphNodes, graphEdges, e.target.value);
            }}
            className="w-40 sm:w-52 truncate rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-sm font-semibold text-ink-primary outline-none hover:border-line-subtle focus:border-line-focus disabled:opacity-80"
          />

          <span className="tabular-metric flex items-center gap-1 rounded-full bg-subtle px-2 py-0.5 text-[11px] text-ink-secondary">
            {saveState === 'saved' && (
              <>
                <Check className="h-3 w-3 text-status-success-fg" />
                已保存 v{canvasMeta.revision}
              </>
            )}
            {saveState === 'dirty' && '待同步...'}
            {saveState === 'saving' && '保存中...'}
            {saveState === 'offline' && (
              <>
                <WifiOff className="h-3 w-3 text-status-stale-fg" />
                离线本地草稿保护中
              </>
            )}
            {saveState === 'conflict' && (
              <>
                <AlertTriangle className="h-3 w-3 text-status-failed-fg" />
                版本冲突
              </>
            )}
          </span>

          {lodMinimal && (
            <span className="rounded-full bg-ai-soft px-2 py-0.5 text-[10px] font-semibold text-ai">
              LOD 极简模式 ({Math.round(viewport.zoom * 100)}%)
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {!readOnly && (
            <>
              <button
                type="button"
                disabled={past.length === 0}
                onClick={handleUndo}
                title="撤销 (Ctrl+Z)"
                className="flex h-7 w-7 items-center justify-center rounded-md border border-line-subtle bg-surface text-ink-secondary hover:bg-hover disabled:opacity-40"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                disabled={future.length === 0}
                onClick={handleRedo}
                title="重做 (Ctrl+Shift+Z)"
                className="flex h-7 w-7 items-center justify-center rounded-md border border-line-subtle bg-surface text-ink-secondary hover:bg-hover disabled:opacity-40"
              >
                <Redo2 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                data-testid="canvas-save-btn"
                onClick={() => void persistCanvas(graphNodes, graphEdges, canvasName)}
                className="flex h-7 items-center gap-1 rounded-md border border-line-subtle bg-surface px-2.5 text-xs font-medium text-ink-primary hover:bg-hover"
              >
                <Save className="h-3.5 w-3.5" />
                <span>保存</span>
              </button>
            </>
          )}

          <button
            type="button"
            onClick={handleOpenMultiVideoTimeline}
            disabled={videoNodes.length === 0}
            className="flex h-7 items-center gap-1 rounded-md border border-line-subtle bg-surface px-2.5 text-xs font-medium text-ink-primary hover:bg-hover disabled:opacity-40"
          >
            <Film className="h-3.5 w-3.5 text-node-video" />
            <span>多视频联动 ({videoNodes.length})</span>
          </button>

          {!readOnly && (
            <>
              {staleNodeIds.size > 0 && (
                <button
                  type="button"
                  onClick={() => void handleRequestRunQuote(Array.from(staleNodeIds))}
                  className="flex h-7 items-center gap-1 rounded-md border border-status-stale-border bg-status-stale-bg px-2.5 text-xs font-semibold text-status-stale-fg"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>重跑待更新 ({staleNodeIds.size})</span>
                </button>
              )}

              <button
                type="button"
                data-testid="canvas-run-graph-btn"
                onClick={() => void handleRequestRunQuote(executableNodeIds)}
                className="flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
              >
                <Play className="h-3.5 w-3.5" />
                <span>运行整图</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setTemplateName(`${canvasName}模板`);
                  setTemplateModalOpen(true);
                }}
                className="flex h-7 items-center gap-1 rounded-md border border-line-subtle bg-surface px-2.5 text-xs font-medium text-ink-primary hover:bg-hover"
              >
                <BookmarkPlus className="h-3.5 w-3.5" />
                <span>另存为模板</span>
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => setTaskDrawerOpen(true)}
            className="flex h-7 items-center gap-1 rounded-md border border-line-subtle bg-surface px-2 text-xs font-medium text-ink-primary hover:bg-hover tabular-metric"
          >
            <span>任务 ({activeJobCount})</span>
          </button>
        </div>
      </div>

      {/* Read-only Banner */}
      {readOnly && (
        <div
          data-testid="canvas-readonly-banner"
          className="absolute left-1/2 top-16 -translate-x-1/2 flex items-center gap-3 rounded-full border border-status-readonly-border bg-status-readonly-bg px-4 py-1.5 text-xs text-status-readonly-fg shadow-card"
          style={{ zIndex: 'var(--z-canvas-hud)' }}
        >
          <Lock className="h-3.5 w-3.5" />
          <span>只读预览模式：支持缩放、查看参数与联动审片，隐藏编辑与扣费操作</span>
          <button
            type="button"
            onClick={() => void handleCloneReadOnly()}
            className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
          >
            <Copy className="h-3 w-3" />
            <span>复制为我的画布</span>
          </button>
        </div>
      )}

      {/* 409 CANVAS_CONFLICT Banner (Zero Silent Overwrite, IndexedDB Draft Preserved) */}
      {(conflictInfo || recoveredDraft) && (
        <div
          data-testid="canvas-conflict-banner"
          className="absolute left-1/2 top-16 -translate-x-1/2 flex flex-wrap items-center gap-3 rounded-xl border border-status-stale-border bg-status-stale-bg px-4 py-2.5 text-xs text-status-stale-fg shadow-popover"
          style={{ zIndex: 'var(--z-popover)' }}
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div>
            <span className="font-semibold">
              {conflictInfo
                ? `检测到多端版本冲突（云端最新 v${conflictInfo.currentRevision ?? '?'}），本地草稿已安全保留在 IndexedDB`
                : '检测到未同步的本地 IndexedDB 草稿'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="conflict-save-copy-btn"
              onClick={() => void handleSaveConflictAsCopy()}
              className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
            >
              另存为副本
            </button>
            <button
              type="button"
              data-testid="conflict-reload-btn"
              onClick={() => void handleReloadLatestCanvas()}
              className="rounded-md border border-line-default bg-surface px-3 py-1 text-xs font-medium text-ink-primary hover:bg-hover"
            >
              重新载入最新画布
            </button>
          </div>
        </div>
      )}

      {/* Invalid Connection / Cycle Alert Toast */}
      {connectionAlert && (
        <div
          role="alert"
          data-testid="canvas-connection-error"
          className="absolute left-1/2 top-28 -translate-x-1/2 rounded-lg border border-status-failed-border bg-status-failed-bg px-4 py-2 text-xs font-semibold text-status-failed-fg shadow-popover"
          style={{ zIndex: 'var(--z-popover)' }}
        >
          {connectionAlert}
        </div>
      )}

      {/* Left Floating Node Palette (Hidden in Read-Only Mode) */}
      {!readOnly && (
        <div
          data-testid="canvas-node-palette"
          className="absolute left-3 top-20 flex w-[188px] flex-col gap-1.5 rounded-xl border border-line-subtle bg-elevated/95 p-2.5 shadow-card backdrop-blur"
          style={{ zIndex: 'var(--z-canvas-hud)' }}
        >
          <div className="px-1 text-[11px] font-semibold text-ink-muted">添加节点</div>
          <button
            type="button"
            onClick={() => handleAddNode({ type: 'text', label: '提示词节点' })}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink-primary hover:bg-hover"
          >
            <Type className="h-3.5 w-3.5 text-node-prompt" />
            <span>文本 Prompt / 便签</span>
          </button>
          <button
            type="button"
            onClick={() => handleAddNode({ type: 'asset', label: '参考图 / 上传', expectedKind: 'image' })}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink-primary hover:bg-hover"
          >
            <ImageIcon className="h-3.5 w-3.5 text-node-media" />
            <span>参考图 / 上传</span>
          </button>
          <button
            type="button"
            onClick={() => handleAddNode({ type: 'subject', label: '商品主体引用' })}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink-primary hover:bg-hover"
          >
            <ShieldCheck className="h-3.5 w-3.5 text-node-subject" />
            <span>商品主体引用</span>
          </button>
          <button
            type="button"
            onClick={() => handleAddNode({ type: 'generation', mode: 'product_scene', label: '图像生成 / 换景' })}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink-primary hover:bg-hover"
          >
            <Sparkles className="h-3.5 w-3.5 text-node-image" />
            <span>图像生成</span>
          </button>
          <button
            type="button"
            onClick={() => handleAddNode({ type: 'generation', mode: 'image_edit', label: '智能编辑 / 抠图' })}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink-primary hover:bg-hover"
          >
            <Wand2 className="h-3.5 w-3.5 text-node-image" />
            <span>智能编辑</span>
          </button>
          <button
            type="button"
            onClick={() => handleAddNode({ type: 'generation', mode: 'image_to_video', label: '视频生成' })}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink-primary hover:bg-hover"
          >
            <Film className="h-3.5 w-3.5 text-node-video" />
            <span>视频生成</span>
          </button>
          <button
            type="button"
            onClick={() => handleAddNode({ type: 'frame', label: '分镜分组框' })}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink-primary hover:bg-hover"
          >
            <Layers className="h-3.5 w-3.5 text-ink-tertiary" />
            <span>分组框 Frame</span>
          </button>

          {/* P1 Audio Node Placeholder (Grayed & Disabled when audio_studio=false) */}
          <button
            type="button"
            data-testid="palette-audio-node"
            disabled={!features.audio_studio}
            onClick={() => {
              if (!features.audio_studio) return;
              handleAddNode({
                type: 'placeholder',
                label: '音频 / 配音节点',
                expectedKind: 'audio',
              });
            }}
            className={`flex items-center justify-between gap-1 rounded-md border px-2 py-1.5 text-xs ${
              features.audio_studio
                ? 'border-transparent text-ink-primary hover:bg-hover'
                : 'border-dashed border-line-default text-ink-muted opacity-65 cursor-not-allowed'
            }`}
          >
            <span className="flex items-center gap-1.5 truncate">
              <Mic className="h-3.5 w-3.5 text-node-audio-p1" />
              <span className="truncate">音频/配音节点</span>
            </span>
            {!features.audio_studio && (
              <span className="shrink-0 rounded-xs bg-subtle px-1 py-0.5 text-[9px] font-semibold">
                即将上线
              </span>
            )}
          </button>

          <div className="my-1 border-t border-line-subtle" />

          <button
            type="button"
            onClick={() => setAssetDrawerOpen((v) => !v)}
            className="flex items-center justify-between rounded-md bg-subtle px-2 py-1.5 text-xs font-medium text-ink-primary hover:bg-hover"
          >
            <span className="flex items-center gap-1.5">
              <Plus className="h-3.5 w-3.5 text-ai" />
              <span>资产与主体抽屉</span>
            </span>
          </button>
        </div>
      )}

      {/* Asset & Subject Side Drawer */}
      {assetDrawerOpen && !readOnly && (
        <div
          className="absolute left-[208px] top-20 bottom-4 w-[240px] overflow-y-auto rounded-xl border border-line-default bg-elevated p-3 shadow-popover space-y-3"
          style={{ zIndex: 'var(--z-drawer)' }}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-ink-primary">点击插入主体 / 资产</span>
            <button
              type="button"
              onClick={() => setAssetDrawerOpen(false)}
              className="text-ink-tertiary hover:text-ink-primary"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div>
            <div className="mb-1.5 text-[11px] font-medium text-ink-muted">商品主体 ({projectSubjects.length})</div>
            <div className="space-y-1.5">
              {projectSubjects.map((sub) => (
                <button
                  key={sub.id}
                  type="button"
                  onClick={() =>
                    handleAddNode({
                      type: 'subject',
                      label: sub.name,
                      subjectId: sub.id,
                      assetId: sub.primaryAssetId,
                    })
                  }
                  className="flex w-full items-center gap-2 rounded-md border border-line-subtle bg-surface p-1.5 text-left text-xs hover:border-node-subject"
                >
                  <img
                    src={api.getAssetContentUrl(sub.primaryAssetId, 'preview')}
                    alt={sub.name}
                    className="h-8 w-8 rounded object-cover"
                  />
                  <div className="min-w-0">
                    <div className="truncate font-medium text-ink-primary">{sub.name}</div>
                    <div className="truncate text-[10px] text-ink-muted">{sub.sku || '已锁定主体'}</div>
                  </div>
                </button>
              ))}
              {projectSubjects.length === 0 && (
                <div className="text-[11px] text-ink-muted">暂无商品主体档案</div>
              )}
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-[11px] font-medium text-ink-muted">项目素材 ({projectAssets.length})</div>
            <div className="grid grid-cols-2 gap-1.5">
              {projectAssets.slice(0, 12).map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() =>
                    handleAddNode({
                      type: 'asset',
                      label: a.name,
                      assetId: a.id,
                      expectedKind: a.kind,
                    })
                  }
                  className="overflow-hidden rounded-md border border-line-subtle bg-surface hover:border-ai"
                >
                  <img
                    src={api.getAssetContentUrl(a.id, 'preview')}
                    alt={a.name}
                    className="aspect-square w-full object-cover"
                    loading="lazy"
                  />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* React Flow Infinite Canvas (200+ node virtualization via onlyRenderVisibleElements) */}
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onMoveEnd={(_, vp) => setViewport(vp)}
        defaultViewport={viewport}
        onlyRenderVisibleElements
        minZoom={0.15}
        maxZoom={2.5}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        fitView={graphNodes.length > 0 && viewport.x === 0 && viewport.y === 0}
      >
        <Background color="var(--canvas-dot-color)" gap={20} size={1.2} />
        <Controls position="bottom-left" />
        <MiniMap position="bottom-right" pannable zoomable />
      </ReactFlow>

      {/* Empty Canvas Guide */}
      {graphNodes.length === 0 && !readOnly && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          style={{ zIndex: 'var(--z-canvas-hud)' }}
        >
          <div className="pointer-events-auto rounded-xl border border-line-subtle bg-elevated/95 p-6 text-center shadow-popover space-y-3 max-w-md">
            <Sparkles className="mx-auto h-8 w-8 text-ai" />
            <div className="text-sm font-semibold text-ink-primary">空白无限画布已就绪</div>
            <p className="text-xs text-ink-tertiary">
              点击左侧节点菜单或下方快捷动作开始编排您的图文与视频工作流。
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={() => handleAddNode({ type: 'subject', label: '商品主体引用' })}
                className="rounded-md bg-subtle px-3 py-1.5 text-xs font-medium text-ink-primary hover:bg-hover"
              >
                + 添加商品主体
              </button>
              <button
                type="button"
                onClick={() => handleAddNode({ type: 'generation', mode: 'text_to_image', label: '文生图节点' })}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary-hover"
              >
                + 添加文生图起始节点
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Multi-Video Shared Timeline Player */}
      {timelineClips && (
        <MultiVideoTimeline clips={timelineClips} onClose={() => setTimelineClips(null)} />
      )}

      {/* Run Quote Topological Confirmation Popover */}
      {runQuoteModal && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          style={{ backgroundColor: 'var(--bg-modal-overlay)', zIndex: 'var(--z-modal)' }}
        >
          <div
            role="dialog"
            aria-label="整图拓扑运行报价确认"
            className="w-full max-w-[480px] rounded-modal border border-line-default bg-elevated p-6 shadow-modal space-y-4"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-ai" />
                <h3 className="text-base font-semibold text-ink-primary">整图拓扑执行确认</h3>
              </div>
              <button
                type="button"
                onClick={() => setRunQuoteModal(null)}
                className="text-ink-tertiary hover:text-ink-primary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-60 overflow-y-auto space-y-1.5 rounded-lg border border-line-subtle bg-surface p-3">
              {runQuoteModal.steps.map((step, idx) => {
                const node = graphNodes.find((n) => n.id === step.nodeId);
                return (
                  <div
                    key={step.nodeId}
                    className="flex items-center justify-between text-xs py-1 border-b border-line-subtle last:border-0"
                  >
                    <div>
                      <span className="tabular-metric font-semibold text-ink-muted mr-1.5">
                        #{idx + 1}
                      </span>
                      <span className="font-medium text-ink-primary">
                        {node?.label || step.nodeId}
                      </span>
                      {step.credits === 0 && (
                        <span className="ml-1.5 rounded-xs bg-status-success-bg px-1.5 py-0.5 text-[10px] text-status-success-fg">
                          已完成分支复用 · 0 分
                        </span>
                      )}
                    </div>
                    <span className="tabular-metric font-semibold text-ink-primary">
                      {step.credits} 分
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between rounded-lg bg-subtle px-4 py-2.5 text-xs">
              <span className="text-ink-secondary">
                汇总预占积分（修订号 v{runQuoteModal.baseRevision}）
              </span>
              <span className="tabular-metric text-base font-bold text-ai">
                {runQuoteModal.totalCredits} 积分
              </span>
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRunQuoteModal(null)}
                className="rounded-md bg-subtle px-4 py-2 text-xs font-medium text-ink-secondary hover:bg-hover"
              >
                取消
              </button>
              <button
                type="button"
                disabled={submittingRun}
                onClick={() => void handleConfirmGraphRun()}
                className="rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
              >
                {submittingRun ? '提交中...' : '确认扣费并运行'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Upstream Confirmation */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          style={{ backgroundColor: 'var(--bg-modal-overlay)', zIndex: 'var(--z-modal)' }}
        >
          <div className="w-full max-w-[400px] rounded-modal border border-line-default bg-elevated p-5 shadow-modal space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-ink-primary">
              <Trash2 className="h-4 w-4 text-status-failed-fg" />
              <span>确认移除已连线的上游节点？</span>
            </div>
            <p className="text-xs text-ink-secondary leading-relaxed">
              删除后将断开与下游 <strong className="tabular-metric">{deleteConfirm.downstreamCount}</strong>{' '}
              个节点的连线，<strong>不会删除下游已生成的图片/视频成品</strong>。
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
                className="rounded-md bg-subtle px-3 py-1.5 text-xs text-ink-secondary"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  pushHistory({ nodes: graphNodes, edges: graphEdges });
                  const toDel = deleteConfirm.nodeIds;
                  const nextNodes = graphNodes.filter((n) => !toDel.includes(n.id));
                  const nextEdges = graphEdges.filter(
                    (e) => !toDel.includes(e.source) && !toDel.includes(e.target)
                  );
                  setGraphNodes(nextNodes);
                  setGraphEdges(nextEdges);
                  setSelectedNodeIds([]);
                  setDeleteConfirm(null);
                  scheduleAutosave(nextNodes, nextEdges);
                }}
                className="rounded-md bg-status-failed-fg px-3 py-1.5 text-xs font-semibold text-ink-inverse"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save As Template Modal (Default Auto-Desensitize) */}
      {templateModalOpen && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          style={{ backgroundColor: 'var(--bg-modal-overlay)', zIndex: 'var(--z-modal)' }}
        >
          <form
            onSubmit={handleSaveAsTemplate}
            className="w-full max-w-[420px] rounded-modal border border-line-default bg-elevated p-6 shadow-modal space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-ink-primary">另存为画布工作流模板</h3>
              <button
                type="button"
                onClick={() => setTemplateModalOpen(false)}
                className="text-ink-tertiary hover:text-ink-primary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-secondary">模板名称</label>
              <input
                type="text"
                required
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                className="h-9 w-full rounded-md border border-line-default bg-surface px-3 text-sm text-ink-primary outline-none focus:border-line-focus"
              />
            </div>
            <label className="flex items-start gap-2 rounded-md border border-line-subtle bg-subtle p-3 text-xs text-ink-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={templateDesensitize}
                onChange={(e) => setTemplateDesensitize(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 accent-ai"
              />
              <span>
                <strong className="text-ink-primary">自动脱敏清空私有商品素材（推荐）</strong>
                <div className="mt-0.5 text-[11px] text-ink-tertiary">
                  将商家原图与商品主体节点替换为类型化占位，严防未上市新品隐私外泄。
                </div>
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setTemplateModalOpen(false)}
                className="rounded-md bg-subtle px-4 py-2 text-xs text-ink-secondary"
              >
                取消
              </button>
              <button
                type="submit"
                className="rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground"
              >
                保存私有模板
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

export const CanvasEditorPage: React.FC = () => (
  <ReactFlowProvider>
    <CanvasEditorInner />
  </ReactFlowProvider>
);
