import type { EdgeRole, GenerationMode, GraphEdge, GraphNode, PortExpectedKind } from '../api/types';

export type PortDataType = 'text' | 'image' | 'subject' | 'video' | 'mask' | 'audio';

export const LOD_MINIMAL_ZOOM_THRESHOLD = 0.4;

export interface ConnectionValidationResult {
  valid: boolean;
  reason?: 'self_loop' | 'cycle' | 'duplicate' | 'port_mismatch' | 'audio_disabled';
  message?: string;
}

/**
 * Determine the primary output data type of a canvas node.
 */
export function getNodeOutputPortType(node: GraphNode): PortDataType {
  switch (node.type) {
    case 'text':
      return 'text';
    case 'subject':
      return 'subject';
    case 'asset':
      return node.expectedKind === 'video'
        ? 'video'
        : node.expectedKind === 'audio'
          ? 'audio'
          : 'image';
    case 'placeholder':
      if (node.expectedKind === 'audio') return 'audio';
      if (node.expectedKind === 'text') return 'text';
      if (node.expectedKind === 'subject') return 'subject';
      if (node.expectedKind === 'video' || node.expectedKind === 'clip') return 'video';
      return 'image';
    case 'generation':
      if (
        node.mode === 'text_to_video' ||
        node.mode === 'image_to_video' ||
        node.mode === 'video_compose'
      ) {
        return 'video';
      }
      if (node.mode === 'subject_cutout') {
        return 'mask';
      }
      return 'image';
    case 'frame':
    default:
      return 'image';
  }
}

/**
 * Determine the expected input data types accepted by a target port role.
 */
export function getAcceptedSourceTypesForRole(role: EdgeRole): PortDataType[] {
  switch (role) {
    case 'prompt':
      return ['text'];
    case 'reference':
      return ['image', 'subject'];
    case 'first_frame':
    case 'last_frame':
      return ['image', 'subject'];
    case 'mask':
      return ['mask', 'image'];
    case 'clip':
      return ['video'];
    case 'result':
      return ['image', 'video', 'mask', 'subject'];
    default:
      return ['image', 'text', 'subject', 'video'];
  }
}

export function inferEdgeRole(
  sourceNode: GraphNode,
  targetNode: GraphNode,
  targetHandle?: string | null
): EdgeRole {
  if (
    targetHandle === 'prompt' ||
    targetHandle === 'reference' ||
    targetHandle === 'first_frame' ||
    targetHandle === 'last_frame' ||
    targetHandle === 'mask' ||
    targetHandle === 'clip' ||
    targetHandle === 'result'
  ) {
    return targetHandle;
  }
  const sourceType = getNodeOutputPortType(sourceNode);
  if (sourceType === 'text') return 'prompt';
  if (sourceType === 'mask') return 'mask';
  if (sourceType === 'video') return 'clip';
  if (
    targetNode.type === 'generation' &&
    (targetNode.mode === 'image_to_video' || targetNode.mode === 'text_to_video')
  ) {
    return 'first_frame';
  }
  return 'reference';
}

/**
 * Check if adding directed edge source -> target creates a cycle in the graph using BFS/DFS.
 */
export function wouldCreateCycle(
  edges: Pick<GraphEdge, 'source' | 'target'>[],
  sourceId: string,
  targetId: string
): boolean {
  if (sourceId === targetId) return true;
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.source);
    if (list) list.push(e.target);
    else adjacency.set(e.source, [e.target]);
  }
  // Check if sourceId is reachable from targetId
  const visited = new Set<string>();
  const queue: string[] = [targetId];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (curr === sourceId) return true;
    if (visited.has(curr)) continue;
    visited.add(curr);
    const nexts = adjacency.get(curr) || [];
    for (const n of nexts) {
      if (!visited.has(n)) queue.push(n);
    }
  }
  return false;
}

/**
 * Validate a proposed edge between sourceId and targetId with port-type and cycle checks.
 */
export function validateCanvasConnection(params: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  sourceId: string;
  targetId: string;
  targetHandle?: string | null;
  audioStudioEnabled?: boolean;
}): ConnectionValidationResult {
  const { nodes, edges, sourceId, targetId, targetHandle, audioStudioEnabled = false } = params;
  if (sourceId === targetId) {
    return {
      valid: false,
      reason: 'self_loop',
      message: '不支持节点连接到自身（循环连线）',
    };
  }

  const sourceNode = nodes.find((n) => n.id === sourceId);
  const targetNode = nodes.find((n) => n.id === targetId);
  if (!sourceNode || !targetNode) {
    return { valid: false, reason: 'port_mismatch', message: '目标或源节点不存在' };
  }

  if (
    !audioStudioEnabled &&
    (sourceNode.expectedKind === 'audio' || targetNode.expectedKind === 'audio')
  ) {
    return {
      valid: false,
      reason: 'audio_disabled',
      message: '音频/配音节点即将上线，当前暂不可连线运行',
    };
  }

  // Only generation or placeholder nodes accept incoming data ports
  if (targetNode.type === 'text' || targetNode.type === 'subject' || targetNode.type === 'asset') {
    return {
      valid: false,
      reason: 'port_mismatch',
      message: '端口类型不匹配：输入源节点不支持接入上游连线',
    };
  }

  const role = inferEdgeRole(sourceNode, targetNode, targetHandle);
  const sourceType = getNodeOutputPortType(sourceNode);
  const accepted = getAcceptedSourceTypesForRole(role);

  if (!accepted.includes(sourceType)) {
    return {
      valid: false,
      reason: 'port_mismatch',
      message: `端口类型不匹配：${sourceType} 输出不能连接到 ${role} 输入端口`,
    };
  }

  // Additional target mode compatibility check
  if (targetNode.type === 'generation' && targetNode.mode) {
    if (
      sourceType === 'video' &&
      targetNode.mode !== 'video_compose'
    ) {
      return {
        valid: false,
        reason: 'port_mismatch',
        message: '端口类型不匹配：视频流仅可连入视频合成节点，不能连入静态图像节点',
      };
    }
  }

  const duplicate = edges.some(
    (e) => e.source === sourceId && e.target === targetId && e.role === role
  );
  if (duplicate) {
    return { valid: false, reason: 'duplicate', message: '已存在相同连线' };
  }

  if (wouldCreateCycle(edges, sourceId, targetId)) {
    return {
      valid: false,
      reason: 'cycle',
      message: '不支持循环连线：该连接将形成有向环路',
    };
  }

  return { valid: true };
}

/**
 * Find all downstream node IDs reachable from changedNodeId (excluding changedNodeId itself).
 * Used to mark downstream nodes as "上游已变更（待更新）" without auto-charging.
 */
export function getDownstreamNodeIds(
  edges: Pick<GraphEdge, 'source' | 'target'>[],
  changedNodeId: string
): string[] {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.source);
    if (list) list.push(e.target);
    else adjacency.set(e.source, [e.target]);
  }
  const visited = new Set<string>();
  const queue = [...(adjacency.get(changedNodeId) || [])];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (visited.has(curr)) continue;
    visited.add(curr);
    for (const next of adjacency.get(curr) || []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return Array.from(visited);
}

/**
 * Estimate single-node credit cost locally as a fast visual indicator before formal server quote.
 */
export function estimateNodeCredits(node: GraphNode): number | null {
  if (node.type !== 'generation') return null;
  const mode: GenerationMode = node.mode || 'text_to_image';
  const duration = node.config?.parameters?.durationSeconds || 5;
  switch (mode) {
    case 'text_to_image':
    case 'image_to_image':
      return 4;
    case 'subject_cutout':
    case 'remove_background':
      return 2;
    case 'product_scene':
    case 'image_edit':
    case 'outpaint':
    case 'upscale':
      return 8;
    case 'text_to_video':
    case 'image_to_video':
      return duration >= 10 ? 30 : 15;
    case 'video_compose':
      return 10;
    default:
      return 6;
  }
}

/**
 * Strip private asset/subject bindings from a graph when saving as a desensitized template.
 */
export function desensitizeGraphForTemplate(
  nodes: GraphNode[]
): { nodes: GraphNode[]; strippedCount: number } {
  let strippedCount = 0;
  const sanitized = nodes.map((n) => {
    if (n.type === 'asset' || n.type === 'subject') {
      strippedCount += 1;
      const expectedKind: PortExpectedKind =
        n.type === 'subject' ? 'subject' : n.expectedKind || 'image';
      return {
        ...n,
        type: 'placeholder' as const,
        assetId: undefined,
        subjectId: undefined,
        expectedKind,
        label: n.label ? `${n.label}（请替换为您的素材）` : '待替换素材占位',
      };
    }
    return n;
  });
  return { nodes: sanitized, strippedCount };
}
