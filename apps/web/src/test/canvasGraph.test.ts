import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '../api/types';
import {
  desensitizeGraphForTemplate,
  getDownstreamNodeIds,
  validateCanvasConnection,
  wouldCreateCycle,
} from '../lib/graphUtils';

describe('Infinite Canvas Graph Validation (Cycle & Port Types)', () => {
  const nodes: GraphNode[] = [
    { id: 'A', type: 'subject', label: '商品主体 A', subjectId: 'sub-1', position: { x: 0, y: 0 } },
    { id: 'B', type: 'text', label: '提示词 B', text: '北欧原木桌面', position: { x: 0, y: 120 } },
    { id: 'C', type: 'generation', mode: 'product_scene', label: '换景生图 C', position: { x: 300, y: 60 } },
    { id: 'D', type: 'generation', mode: 'image_to_video', label: '图生视频 D', position: { x: 600, y: 60 } },
    { id: 'E', type: 'placeholder', expectedKind: 'audio', label: '音频占位 E', position: { x: 600, y: 240 } },
  ];

  const baseEdges: GraphEdge[] = [
    { id: 'e1', source: 'A', target: 'C', role: 'reference' },
    { id: 'e2', source: 'B', target: 'C', role: 'prompt' },
    { id: 'e3', source: 'C', target: 'D', role: 'first_frame' },
  ];

  it('allows valid typed DAG edges (subject/text -> image -> video)', () => {
    const res1 = validateCanvasConnection({
      nodes,
      edges: [],
      sourceId: 'A',
      targetId: 'C',
      targetHandle: 'reference',
    });
    expect(res1.valid).toBe(true);

    const res2 = validateCanvasConnection({
      nodes,
      edges: baseEdges.slice(0, 2),
      sourceId: 'C',
      targetId: 'D',
      targetHandle: 'first_frame',
    });
    expect(res2.valid).toBe(true);
  });

  it('blocks direct self-loops and multi-hop directed cycles (D -> C, C -> A)', () => {
    expect(wouldCreateCycle(baseEdges, 'C', 'C')).toBe(true);
    expect(wouldCreateCycle(baseEdges, 'D', 'C')).toBe(true);
    expect(wouldCreateCycle(baseEdges, 'D', 'A')).toBe(true);

    const selfLoop = validateCanvasConnection({
      nodes,
      edges: baseEdges,
      sourceId: 'C',
      targetId: 'C',
    });
    expect(selfLoop.valid).toBe(false);
    expect(selfLoop.reason).toBe('self_loop');

    const cycleRes = validateCanvasConnection({
      nodes,
      edges: [
        { id: 'e-c-d', source: 'C', target: 'D', role: 'first_frame' },
        { id: 'e-d-f', source: 'D', target: 'F', role: 'clip' },
      ],
      sourceId: 'F',
      targetId: 'C',
      targetHandle: 'reference',
    });
    // Add node F with image output to verify cycle check specifically triggers
    const withF: GraphNode[] = [
      ...nodes,
      { id: 'F', type: 'generation', mode: 'text_to_image', position: { x: 900, y: 60 } },
    ];
    const multiHopCycle = validateCanvasConnection({
      nodes: withF,
      edges: [
        { id: 'e-c-d', source: 'C', target: 'D', role: 'first_frame' },
        { id: 'e-d-f', source: 'D', target: 'F', role: 'result' },
      ],
      sourceId: 'F',
      targetId: 'C',
      targetHandle: 'reference',
    });
    expect(cycleRes.valid).toBe(false);
    expect(multiHopCycle.valid).toBe(false);
    expect(multiHopCycle.reason).toBe('cycle');
    expect(multiHopCycle.message).toContain('循环连线');
  });

  it('blocks incompatible port data types (video -> static image, text -> first_frame, any -> source node)', () => {
    const videoToStaticImg = validateCanvasConnection({
      nodes,
      edges: [],
      sourceId: 'D',
      targetId: 'C',
      targetHandle: 'reference',
    });
    expect(videoToStaticImg.valid).toBe(false);
    expect(videoToStaticImg.reason).toBe('port_mismatch');

    const textToFirstFrame = validateCanvasConnection({
      nodes,
      edges: [],
      sourceId: 'B',
      targetId: 'D',
      targetHandle: 'first_frame',
    });
    expect(textToFirstFrame.valid).toBe(false);
    expect(textToFirstFrame.reason).toBe('port_mismatch');

    const intoSourceNode = validateCanvasConnection({
      nodes,
      edges: [],
      sourceId: 'D',
      targetId: 'A',
    });
    expect(intoSourceNode.valid).toBe(false);
    expect(intoSourceNode.reason).toBe('port_mismatch');
  });

  it('blocks P1 audio placeholder connections when audioStudioEnabled=false', () => {
    const audioBlocked = validateCanvasConnection({
      nodes,
      edges: [],
      sourceId: 'B',
      targetId: 'E',
      audioStudioEnabled: false,
    });
    expect(audioBlocked.valid).toBe(false);
    expect(audioBlocked.reason).toBe('audio_disabled');
  });

  it('marks all downstream nodes stale on upstream change and desensitizes private assets for templates', () => {
    expect(getDownstreamNodeIds(baseEdges, 'A').sort()).toEqual(['C', 'D']);
    expect(getDownstreamNodeIds(baseEdges, 'C')).toEqual(['D']);

    const { nodes: sanitized, strippedCount } = desensitizeGraphForTemplate(nodes);
    expect(strippedCount).toBe(1);
    const sanitizedA = sanitized.find((n) => n.id === 'A')!;
    expect(sanitizedA.type).toBe('placeholder');
    expect(sanitizedA.subjectId).toBeUndefined();
    expect(sanitizedA.expectedKind).toBe('subject');
  });
});
