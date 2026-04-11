import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { KnowledgeGraph } from '../contracts/graph.js'
import { _nodeCommunityMap } from './analyze.js'
import type { Communities } from './cluster.js'

const COMMUNITY_COLORS = ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F', '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC']

const SVG_LAYOUT = {
  cellWidth: 360,
  cellHeight: 280,
  padding: 48,
  legendWidth: 240,
  communityBaseRadius: 42,
  communityRadiusIncrement: 8,
  communityRadiusCap: 92,
  nodeBaseRadius: 10,
  nodeRadiusScale: 16,
  nodeLabelOffset: 14,
  legendRowHeight: 24,
} as const

const FILE_TYPE_TAGS: Record<string, string> = {
  code: 'graphify/code',
  document: 'graphify/document',
  paper: 'graphify/paper',
  image: 'graphify/image',
}

const INLINE_SCRIPT_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function escapeXml(value: string): string {
  return escapeHtml(value)
}

function escapeCypher(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/\r?\n+/g, ' ').replace(/([\\`*_[\]()!])/g, '\\$1')
}

function sanitizeTag(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/\/+/g, '/')
    .replace(/^[_/]+|[_/]+$/g, '')
  return sanitized.length > 0 ? sanitized : 'graphify/unknown'
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => INLINE_SCRIPT_ESCAPES[character] ?? character)
}

function confidenceScore(attributes: Record<string, unknown>): number {
  if (typeof attributes.confidence_score === 'number') {
    return attributes.confidence_score
  }

  const confidence = String(attributes.confidence ?? 'EXTRACTED')
  if (confidence === 'AMBIGUOUS') {
    return 0.2
  }
  if (confidence === 'INFERRED') {
    return 0.5
  }
  if (confidence === 'EXTRACTED') {
    return 1.0
  }
  return 1.0
}

function safeName(label: string): string {
  const sanitized = label
    .replace(/[\\/*?:"<>|#^[\]]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  return sanitized.length > 0 ? sanitized : 'unnamed'
}

function dominantConfidence(graph: KnowledgeGraph, nodeId: string): string {
  const counts = new Map<string, number>()
  for (const [source, target, attributes] of graph.edgeEntries()) {
    if (source !== nodeId && target !== nodeId) {
      continue
    }
    const confidence = String(attributes.confidence ?? 'EXTRACTED')
    counts.set(confidence, (counts.get(confidence) ?? 0) + 1)
  }

  let winner = 'EXTRACTED'
  let winnerCount = -1
  for (const [confidence, count] of counts.entries()) {
    if (count > winnerCount) {
      winner = confidence
      winnerCount = count
    }
  }

  return winner
}

type ConnectionDirection = 'incoming' | 'outgoing' | 'undirected'

interface NodeConnection {
  neighborId: string
  direction: ConnectionDirection
  attributes: Record<string, unknown>
}

function nodeConnections(graph: KnowledgeGraph, nodeId: string): NodeConnection[] {
  const directionForUndirected = 'undirected' as const
  const connections: NodeConnection[] = []

  for (const [source, target, attributes] of graph.edgeEntries()) {
    if (source === nodeId) {
      connections.push({
        neighborId: target,
        direction: graph.isDirected() ? 'outgoing' : directionForUndirected,
        attributes,
      })
      continue
    }

    if (target === nodeId) {
      connections.push({
        neighborId: source,
        direction: graph.isDirected() ? 'incoming' : directionForUndirected,
        attributes,
      })
    }
  }

  return connections
}

function connectionPrefix(direction: ConnectionDirection): string {
  if (direction === 'incoming') {
    return '← '
  }
  if (direction === 'outgoing') {
    return '→ '
  }
  return ''
}

export function toJson(graph: KnowledgeGraph, communities: Communities, outputPath: string): void {
  const nodeCommunity = _nodeCommunityMap(communities)
  const data = {
    directed: graph.isDirected(),
    nodes: graph.nodeEntries().map(([id, attributes]) => ({
      id,
      ...attributes,
      community: nodeCommunity[id] ?? -1,
    })),
    links: graph.edgeEntries().map(([source, target, attributes]) => ({
      source,
      target,
      ...attributes,
      confidence_score: confidenceScore(attributes),
    })),
    hyperedges: Array.isArray(graph.graph.hyperedges) ? graph.graph.hyperedges : [],
  }

  writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

export function toCypher(graph: KnowledgeGraph, outputPath: string): void {
  const lines = ['// Neo4j Cypher import - generated by graphify-ts', '']

  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const label = escapeCypher(String(attributes.label ?? nodeId))
    const fileTypeRaw = String(attributes.file_type ?? 'entity').replace(/[^A-Za-z0-9_]/g, '')
    const fileType = fileTypeRaw && /^[A-Za-z]/.test(fileTypeRaw) ? `${fileTypeRaw.charAt(0).toUpperCase()}${fileTypeRaw.slice(1)}` : 'Entity'
    lines.push(`MERGE (n:${fileType} {id: '${escapeCypher(nodeId)}', label: '${label}'});`)
  }

  lines.push('')
  for (const [source, target, attributes] of graph.edgeEntries()) {
    const relation =
      String(attributes.relation ?? 'RELATES_TO')
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_') || 'RELATES_TO'
    const confidence = escapeCypher(String(attributes.confidence ?? 'EXTRACTED'))
    lines.push(`MATCH (a {id: '${escapeCypher(source)}'}), (b {id: '${escapeCypher(target)}'}) MERGE (a)-[:${relation} {confidence: '${confidence}'}]->(b);`)
  }

  writeFileSync(outputPath, lines.join('\n'), 'utf8')
}

export function toGraphml(graph: KnowledgeGraph, communities: Communities, outputPath: string): void {
  const nodeCommunity = _nodeCommunityMap(communities)
  const edgeDefault = graph.isDirected() ? 'directed' : 'undirected'
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    `  <graph id="graphify" edgedefault="${edgeDefault}">`,
  ]

  for (const [nodeId, attributes] of graph.nodeEntries()) {
    lines.push(`    <node id="${escapeXml(nodeId)}">`)
    lines.push(`      <data key="label">${escapeXml(String(attributes.label ?? nodeId))}</data>`)
    lines.push(`      <data key="community">${nodeCommunity[nodeId] ?? -1}</data>`)
    lines.push(`      <data key="source_file">${escapeXml(String(attributes.source_file ?? ''))}</data>`)
    lines.push('    </node>')
  }

  let edgeIndex = 0
  for (const [source, target, attributes] of graph.edgeEntries()) {
    lines.push(`    <edge id="e${edgeIndex}" source="${escapeXml(source)}" target="${escapeXml(target)}">`)
    lines.push(`      <data key="relation">${escapeXml(String(attributes.relation ?? ''))}</data>`)
    lines.push(`      <data key="confidence">${escapeXml(String(attributes.confidence ?? 'EXTRACTED'))}</data>`)
    lines.push('    </edge>')
    edgeIndex += 1
  }

  lines.push('  </graph>')
  lines.push('</graphml>')
  writeFileSync(outputPath, lines.join('\n'), 'utf8')
}

/**
 * Export the graph as a static SVG with a deterministic, dependency-free layout.
 *
 * Communities are arranged in a grid and nodes are positioned on a circle inside
 * each community cell, which keeps output stable across runs for the same input.
 */
export function toSvg(graph: KnowledgeGraph, communities: Communities, outputPath: string, communityLabels: Record<number, string> = {}): void {
  const communityIds = Object.keys(communities)
    .map(Number)
    .sort((left, right) => left - right)
  const totalCommunities = Math.max(communityIds.length, 1)
  const columns = Math.max(1, Math.ceil(Math.sqrt(totalCommunities)))
  const rows = Math.max(1, Math.ceil(totalCommunities / columns))
  const width = SVG_LAYOUT.padding * 2 + columns * SVG_LAYOUT.cellWidth + SVG_LAYOUT.legendWidth
  const height = SVG_LAYOUT.padding * 2 + rows * SVG_LAYOUT.cellHeight
  const degreeByNode = new Map(graph.nodeIds().map((nodeId) => [nodeId, graph.degree(nodeId)]))
  const maxDegree = Math.max(...degreeByNode.values(), 1)
  const positions = new Map<string, { x: number; y: number }>()

  communityIds.forEach((communityId, index) => {
    const nodeIds = [...(communities[communityId] ?? [])].sort((left, right) => {
      return String(graph.nodeAttributes(left).label ?? left).localeCompare(String(graph.nodeAttributes(right).label ?? right))
    })
    const column = index % columns
    const row = Math.floor(index / columns)
    const centerX = SVG_LAYOUT.padding + column * SVG_LAYOUT.cellWidth + SVG_LAYOUT.cellWidth / 2
    const centerY = SVG_LAYOUT.padding + row * SVG_LAYOUT.cellHeight + SVG_LAYOUT.cellHeight / 2

    if (nodeIds.length === 1) {
      positions.set(nodeIds[0]!, { x: centerX, y: centerY })
      return
    }

    const radius = Math.min(SVG_LAYOUT.communityRadiusCap, SVG_LAYOUT.communityBaseRadius + nodeIds.length * SVG_LAYOUT.communityRadiusIncrement)
    nodeIds.forEach((nodeId, nodeIndex) => {
      const angle = -Math.PI / 2 + (nodeIndex / nodeIds.length) * Math.PI * 2
      positions.set(nodeId, {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
      })
    })
  })

  const nodeElements = graph.nodeEntries().map(([nodeId, attributes]) => {
    const communityId = communityIds.find((id) => communities[id]?.includes(nodeId)) ?? 0
    const color = COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length] ?? COMMUNITY_COLORS[0]
    const position = positions.get(nodeId) ?? { x: SVG_LAYOUT.padding + 40, y: SVG_LAYOUT.padding + 40 }
    const radius = SVG_LAYOUT.nodeBaseRadius + SVG_LAYOUT.nodeRadiusScale * ((degreeByNode.get(nodeId) ?? 0) / maxDegree)
    const label = escapeXml(String(attributes.label ?? nodeId))
    return [
      `  <circle cx="${position.x.toFixed(2)}" cy="${position.y.toFixed(2)}" r="${radius.toFixed(2)}" fill="${color}" fill-opacity="0.9" stroke="#ffffff" stroke-width="1.5" />`,
      `  <text x="${position.x.toFixed(2)}" y="${(position.y + radius + SVG_LAYOUT.nodeLabelOffset).toFixed(2)}" font-family="Inter, Arial, sans-serif" font-size="12" text-anchor="middle" fill="#f8fafc">${label}</text>`,
    ].join('\n')
  })

  const edgeElements = graph.edgeEntries().map(([source, target, attributes]) => {
    const sourcePosition = positions.get(source)
    const targetPosition = positions.get(target)
    if (!sourcePosition || !targetPosition) {
      return ''
    }

    const confidence = String(attributes.confidence ?? 'EXTRACTED')
    const dashArray = confidence === 'EXTRACTED' ? '' : ' stroke-dasharray="6 4"'
    const opacity = confidence === 'EXTRACTED' ? '0.65' : '0.35'
    return `  <line x1="${sourcePosition.x.toFixed(2)}" y1="${sourcePosition.y.toFixed(2)}" x2="${targetPosition.x.toFixed(2)}" y2="${targetPosition.y.toFixed(2)}" stroke="#94a3b8" stroke-width="1.5" stroke-opacity="${opacity}"${dashArray} />`
  })

  const legendElements = communityIds.map((communityId, index) => {
    const color = COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length] ?? COMMUNITY_COLORS[0]
    const label = escapeXml(communityLabels[communityId] ?? `Community ${communityId}`)
    const y = SVG_LAYOUT.padding + 28 + index * SVG_LAYOUT.legendRowHeight
    return [
      `  <circle cx="${width - SVG_LAYOUT.legendWidth + 20}" cy="${y}" r="6" fill="${color}" />`,
      `  <text x="${width - SVG_LAYOUT.legendWidth + 34}" y="${y + 4}" font-family="Inter, Arial, sans-serif" font-size="12" fill="#e2e8f0">${label} (${communities[communityId]?.length ?? 0})</text>`,
    ].join('\n')
  })

  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="graphify-ts knowledge graph export">`,
    `  <rect width="${width}" height="${height}" fill="#111827" />`,
    '  <text x="48" y="32" font-family="Inter, Arial, sans-serif" font-size="20" font-weight="600" fill="#f8fafc">graphify-ts</text>',
    '  <text x="48" y="54" font-family="Inter, Arial, sans-serif" font-size="12" fill="#94a3b8">Static SVG knowledge graph export</text>',
    ...edgeElements.filter((line) => line.length > 0),
    ...nodeElements,
    `  <text x="${width - SVG_LAYOUT.legendWidth + 12}" y="${SVG_LAYOUT.padding}" font-family="Inter, Arial, sans-serif" font-size="14" font-weight="600" fill="#f8fafc">Communities</text>`,
    ...legendElements,
    '</svg>',
    '',
  ].join('\n')

  writeFileSync(outputPath, svg, 'utf8')
}

export function toHtml(graph: KnowledgeGraph, communities: Communities, outputPath: string, communityLabels: Record<number, string> = {}): void {
  const nodeCommunity = _nodeCommunityMap(communities)
  const nodes = graph.nodeEntries().map(([id, attributes]) => {
    const communityId = nodeCommunity[id] ?? 0
    const color = COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length] ?? COMMUNITY_COLORS[0]
    return {
      id,
      label: String(attributes.label ?? id),
      title: escapeHtml(String(attributes.label ?? id)),
      color: { background: color, border: color },
      community: communityId,
      community_name: communityLabels[communityId] ?? `Community ${communityId}`,
      source_file: String(attributes.source_file ?? ''),
      source_location: String(attributes.source_location ?? ''),
      source_url: String(attributes.source_url ?? ''),
      file_type: String(attributes.file_type ?? ''),
      degree: graph.degree(id),
      confidence: dominantConfidence(graph, id),
    }
  })
  const edges = graph.edgeEntries().map(([source, target, attributes]) => ({
    from: source,
    to: target,
    label: String(attributes.relation ?? ''),
    title: escapeHtml(`${String(attributes.relation ?? '')} [${String(attributes.confidence ?? 'EXTRACTED')}]`),
    confidence: String(attributes.confidence ?? 'EXTRACTED'),
    dashes: String(attributes.confidence ?? 'EXTRACTED') !== 'EXTRACTED',
  }))
  const legend = Object.entries(communities).map(([communityId, nodeIds]) => ({
    cid: Number(communityId),
    color: COMMUNITY_COLORS[Number(communityId) % COMMUNITY_COLORS.length] ?? COMMUNITY_COLORS[0],
    label: communityLabels[Number(communityId)] ?? `Community ${communityId}`,
    count: nodeIds.length,
  }))
  const stats = {
    nodes: graph.numberOfNodes(),
    edges: graph.numberOfEdges(),
    communities: Object.keys(communities).length,
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>graphify-ts</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
<style>
  :root {
    color-scheme: light;
    --panel-border: #d7dce5;
    --panel-bg: #fbfcfe;
    --text-muted: #5b6473;
    --accent: #2553d8;
  }

  * { box-sizing: border-box; }
  body {
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    margin: 0;
    display: flex;
    height: 100vh;
    color: #111827;
    background: #eef2f7;
  }

  #graph {
    flex: 1;
    min-width: 0;
    background: linear-gradient(180deg, #f8fbff 0%, #eef2f7 100%);
  }

  #sidebar {
    width: 360px;
    border-left: 1px solid var(--panel-border);
    padding: 16px;
    overflow: auto;
    background: rgba(255, 255, 255, 0.94);
    backdrop-filter: blur(8px);
  }

  h1, h2, h3, p { margin: 0; }
  h1 { font-size: 1.15rem; }
  h2 { font-size: 0.96rem; margin-bottom: 10px; }
  .lede { color: var(--text-muted); font-size: 0.9rem; line-height: 1.5; margin-top: 8px; }
  .panel {
    border: 1px solid var(--panel-border);
    border-radius: 14px;
    background: var(--panel-bg);
    padding: 14px;
    margin-bottom: 14px;
    box-shadow: 0 4px 14px rgba(15, 23, 42, 0.04);
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-top: 12px;
  }

  .stat {
    border-radius: 10px;
    padding: 10px;
    background: white;
    border: 1px solid #e6ebf2;
  }

  .stat strong {
    display: block;
    font-size: 1rem;
    margin-top: 3px;
  }

  .muted { color: var(--text-muted); font-size: 0.85rem; }

  #search {
    width: 100%;
    padding: 10px 12px;
    margin-bottom: 10px;
    border-radius: 10px;
    border: 1px solid #cdd6e3;
    background: white;
  }

  .toolbar {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    flex-wrap: wrap;
  }

  button {
    appearance: none;
    border: 1px solid #cbd5e1;
    background: white;
    color: #111827;
    border-radius: 10px;
    padding: 8px 10px;
    cursor: pointer;
    font: inherit;
  }

  button:hover { border-color: var(--accent); color: var(--accent); }
  button.primary {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }

  button.small {
    font-size: 0.82rem;
    padding: 6px 8px;
  }

  .list, #legend, #matches {
    display: grid;
    gap: 8px;
  }

  .legend-button,
  .match-button,
  .neighbor-button {
    width: 100%;
    text-align: left;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
  }

  .legend-chip {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    flex: 0 0 auto;
  }

  .meta-grid {
    display: grid;
    grid-template-columns: minmax(90px, auto) 1fr;
    gap: 8px 12px;
    font-size: 0.9rem;
  }

  .meta-grid dt { color: var(--text-muted); }
  .meta-grid dd { margin: 0; word-break: break-word; }

  .empty {
    color: var(--text-muted);
    font-size: 0.9rem;
    line-height: 1.5;
  }

  .neighbor-meta,
  .match-meta {
    color: var(--text-muted);
    font-size: 0.78rem;
  }

  code {
    background: #eef2ff;
    padding: 0.15rem 0.35rem;
    border-radius: 6px;
  }
</style>
</head>
<body>
<div id="graph"></div>
<div id="sidebar">
  <section class="panel">
    <h1>graphify-ts</h1>
    <p class="lede">Explore the generated graph, inspect node evidence, and hop through neighbors without leaving the HTML export.</p>
    <div class="stats" id="stats"></div>
  </section>

  <section class="panel">
    <h2>Search</h2>
    <input id="search" placeholder="Search nodes by label or file..." />
    <div id="matches" class="list"></div>
    <div class="toolbar">
      <button id="resetView" class="small">Reset view</button>
      <button id="clearSelection" class="small">Clear selection</button>
    </div>
  </section>

  <section class="panel">
    <h2>Selected node</h2>
    <p id="selectionEmpty" class="empty">Click a node in the graph, choose a search match, or follow a neighbor to inspect it here.</p>
    <div id="selectionDetails" hidden>
      <h3 id="selectedLabel"></h3>
      <p id="selectedSummary" class="lede"></p>
      <dl class="meta-grid">
        <dt>Source</dt><dd id="selectedSource"></dd>
        <dt>Type</dt><dd id="selectedType"></dd>
        <dt>Community</dt><dd id="selectedCommunity"></dd>
        <dt>Confidence</dt><dd id="selectedConfidence"></dd>
        <dt>Degree</dt><dd id="selectedDegree"></dd>
      </dl>
      <div class="toolbar">
        <button id="focusNeighborhood" class="primary small">Focus neighborhood</button>
      </div>
    </div>
  </section>

  <section class="panel">
    <h2>Neighbors</h2>
    <p id="neighborsEmpty" class="empty">Neighbor navigation appears here once a node is selected.</p>
    <div id="neighborList" class="list"></div>
  </section>

  <section class="panel">
    <h2>Communities</h2>
    <div id="legend"></div>
  </section>
</div>
<script>
const RAW_NODES = ${serializeForInlineScript(nodes)};
const RAW_EDGES = ${serializeForInlineScript(edges)};
const LEGEND = ${serializeForInlineScript(legend)};
const STATS = ${serializeForInlineScript(stats)};
const IS_DIRECTED = ${serializeForInlineScript(graph.isDirected())};
const EDGE_ARROWS = ${serializeForInlineScript(graph.isDirected() ? { to: { enabled: true, scaleFactor: 0.45 } } : {})};

const nodes = new vis.DataSet(RAW_NODES);
const edges = new vis.DataSet(RAW_EDGES.map((edge) => ({ ...edge, arrows: EDGE_ARROWS, dashes: edge.dashes })));
const nodeIndex = new Map(RAW_NODES.map((node) => [node.id, node]));
const nodesByCommunity = new Map();
RAW_NODES.forEach((node) => {
  const group = nodesByCommunity.get(node.community) || [];
  group.push(node.id);
  nodesByCommunity.set(node.community, group);
});

const edgesByNode = new Map();
RAW_EDGES.forEach((edge) => {
  const outgoing = edgesByNode.get(edge.from) || [];
  outgoing.push(edge);
  edgesByNode.set(edge.from, outgoing);

  const incoming = edgesByNode.get(edge.to) || [];
  incoming.push(edge);
  edgesByNode.set(edge.to, incoming);
});

let selectedNodeId = null;

const elements = {
  stats: document.getElementById('stats'),
  search: document.getElementById('search'),
  matches: document.getElementById('matches'),
  selectionEmpty: document.getElementById('selectionEmpty'),
  selectionDetails: document.getElementById('selectionDetails'),
  selectedLabel: document.getElementById('selectedLabel'),
  selectedSummary: document.getElementById('selectedSummary'),
  selectedSource: document.getElementById('selectedSource'),
  selectedType: document.getElementById('selectedType'),
  selectedCommunity: document.getElementById('selectedCommunity'),
  selectedConfidence: document.getElementById('selectedConfidence'),
  selectedDegree: document.getElementById('selectedDegree'),
  neighborList: document.getElementById('neighborList'),
  neighborsEmpty: document.getElementById('neighborsEmpty'),
  legend: document.getElementById('legend'),
  resetView: document.getElementById('resetView'),
  clearSelection: document.getElementById('clearSelection'),
  focusNeighborhood: document.getElementById('focusNeighborhood'),
};

const network = new vis.Network(
  document.getElementById('graph'),
  { nodes, edges },
  {
    autoResize: true,
    interaction: { hover: true, navigationButtons: true, keyboard: true },
    physics: { stabilization: true, barnesHut: { gravitationalConstant: -4200, springLength: 120 } },
    nodes: {
      borderWidth: 1.25,
      shape: 'dot',
      font: { size: 14, face: 'Inter, ui-sans-serif, system-ui, sans-serif' },
      scaling: { min: 12, max: 34 },
    },
    edges: {
      arrows: EDGE_ARROWS,
      font: { align: 'middle', size: 10 },
      color: { inherit: false, color: '#94a3b8', highlight: '#334155' },
      smooth: { type: 'dynamic' },
    },
  },
);

function createMeta(text, className) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function getNeighborEntries(nodeId) {
  const relatedEdges = edgesByNode.get(nodeId) || [];
  const deduped = new Map();
  relatedEdges.forEach((edge) => {
    const isOutgoing = edge.from === nodeId;
    const otherId = isOutgoing ? edge.to : edge.from;
    if (!nodeIndex.has(otherId)) {
      return;
    }

    const key = otherId + '::' + edge.label + '::' + edge.confidence;
    if (deduped.has(key)) {
      return;
    }

    const other = nodeIndex.get(otherId);
    deduped.set(key, {
      id: otherId,
      label: other.label,
      relation: edge.label || 'related_to',
      confidence: edge.confidence || 'EXTRACTED',
      direction: IS_DIRECTED ? (isOutgoing ? 'outgoing' : 'incoming') : 'connected',
      community: other.community_name,
      degree: other.degree,
    });
  });

  return [...deduped.values()].sort((left, right) => {
    return right.degree - left.degree || left.label.localeCompare(right.label);
  });
}

function renderStats() {
  const items = [
    { label: 'Nodes', value: STATS.nodes },
    { label: 'Edges', value: STATS.edges },
    { label: 'Communities', value: STATS.communities },
  ];

  items.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'stat';
    card.appendChild(createMeta(item.label, 'muted'));
    const value = document.createElement('strong');
    value.textContent = String(item.value);
    card.appendChild(value);
    elements.stats.appendChild(card);
  });
}

function renderSearchMatches(query) {
  elements.matches.replaceChildren();
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    elements.matches.appendChild(createMeta('Type to surface the best matching nodes.', 'empty'));
    return [];
  }

  const matches = RAW_NODES.filter((node) => {
    return node.label.toLowerCase().includes(trimmed) || node.source_file.toLowerCase().includes(trimmed);
  })
    .sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label))
    .slice(0, 8);

  if (matches.length === 0) {
    elements.matches.appendChild(createMeta('No matches yet. Try a file name, class, function, or concept.', 'empty'));
    return [];
  }

  matches.forEach((node) => {
    const button = document.createElement('button');
    button.className = 'match-button small';
    const left = document.createElement('span');
    left.textContent = node.label;
    const right = createMeta(node.community_name + ' · degree ' + node.degree, 'match-meta');
    button.append(left, right);
    button.addEventListener('click', () => selectNodeById(node.id, { focus: true }));
    elements.matches.appendChild(button);
  });

  return matches;
}

function renderNeighbors(nodeId) {
  elements.neighborList.replaceChildren();
  if (!nodeId) {
    elements.neighborsEmpty.hidden = false;
    return;
  }

  const neighbors = getNeighborEntries(nodeId);
  if (neighbors.length === 0) {
    elements.neighborsEmpty.hidden = false;
    elements.neighborsEmpty.textContent = 'This node currently has no rendered neighbors in the exported graph.';
    return;
  }

  elements.neighborsEmpty.hidden = true;
  neighbors.forEach((entry) => {
    const button = document.createElement('button');
    button.className = 'neighbor-button small';
    const left = document.createElement('span');
    left.textContent = entry.label;
    const right = createMeta(entry.direction + ' · ' + entry.relation + ' [' + entry.confidence + ']', 'neighbor-meta');
    button.append(left, right);
    button.addEventListener('click', () => selectNodeById(entry.id, { focus: true }));
    elements.neighborList.appendChild(button);
  });
}

function updateHash(nodeId) {
  if (!nodeId) {
    history.replaceState(null, '', location.pathname + location.search);
    return;
  }

  history.replaceState(null, '', '#' + encodeURIComponent(nodeId));
}

function renderSelection(nodeId) {
  if (!nodeId || !nodeIndex.has(nodeId)) {
    selectedNodeId = null;
    elements.selectionEmpty.hidden = false;
    elements.selectionDetails.hidden = true;
    elements.selectedLabel.textContent = '';
    elements.selectedSummary.textContent = '';
    elements.selectedSource.textContent = '';
    elements.selectedType.textContent = '';
    elements.selectedCommunity.textContent = '';
    elements.selectedConfidence.textContent = '';
    elements.selectedDegree.textContent = '';
    renderNeighbors(null);
    return;
  }

  const node = nodeIndex.get(nodeId);
  selectedNodeId = nodeId;
  elements.selectionEmpty.hidden = true;
  elements.selectionDetails.hidden = false;
  elements.selectedLabel.textContent = node.label;
  elements.selectedSummary.textContent = 'Inspect evidence, jump to neighbors, or focus this local neighborhood.';
  elements.selectedSource.textContent = [node.source_file, node.source_location].filter(Boolean).join(': ') || 'Unknown source';
  elements.selectedType.textContent = node.file_type || 'unknown';
  elements.selectedCommunity.textContent = node.community_name;
  elements.selectedConfidence.textContent = node.confidence;
  elements.selectedDegree.textContent = String(node.degree);
  renderNeighbors(nodeId);
}

function selectNodeById(nodeId, options = { focus: true }) {
  if (!nodeIndex.has(nodeId)) {
    return;
  }

  network.selectNodes([nodeId]);
  renderSelection(nodeId);
  updateHash(nodeId);
  if (options.focus !== false) {
    network.focus(nodeId, { scale: 1.15, animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
  }
}

function focusNeighborhood() {
  if (!selectedNodeId) {
    return;
  }

  const nodeIds = [selectedNodeId, ...getNeighborEntries(selectedNodeId).map((entry) => entry.id)];
  network.selectNodes(nodeIds);
  network.fit({ nodes: nodeIds, animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
}

function focusCommunity(communityId) {
  const nodeIds = nodesByCommunity.get(communityId) || [];
  if (nodeIds.length === 0) {
    return;
  }

  network.selectNodes(nodeIds);
  network.fit({ nodes: nodeIds, animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
}

function clearSelection() {
  network.unselectAll();
  renderSelection(null);
  updateHash(null);
}

function renderLegend() {
  LEGEND.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  LEGEND.forEach((entry) => {
    const button = document.createElement('button');
    button.className = 'legend-button small';
    const left = document.createElement('span');
    const chip = document.createElement('span');
    chip.className = 'legend-chip';
    chip.style.background = entry.color;
    const label = document.createElement('span');
    label.textContent = entry.label;
    left.append(chip, document.createTextNode(' '), label);
    const right = createMeta(String(entry.count), 'neighbor-meta');
    button.append(left, right);
    button.addEventListener('click', () => focusCommunity(entry.cid));
    elements.legend.appendChild(button);
  });
}

renderStats();
renderLegend();
renderSearchMatches('');
renderSelection(null);

elements.search.addEventListener('input', (event) => {
  renderSearchMatches(event.target.value || '');
});

elements.search.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') {
    return;
  }
  const matches = renderSearchMatches(elements.search.value || '');
  if (matches.length > 0) {
    selectNodeById(matches[0].id, { focus: true });
  }
});

elements.resetView.addEventListener('click', () => {
  network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
});
elements.clearSelection.addEventListener('click', clearSelection);
elements.focusNeighborhood.addEventListener('click', focusNeighborhood);

network.on('selectNode', (event) => {
  const nodeId = event.nodes && event.nodes[0];
  if (nodeId) {
    selectNodeById(nodeId, { focus: false });
  }
});

network.on('deselectNode', () => {
  renderSelection(null);
  updateHash(null);
});

window.addEventListener('hashchange', () => {
  const hashId = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  if (hashId && nodeIndex.has(hashId)) {
    selectNodeById(hashId, { focus: true });
  }
});

const initialHash = decodeURIComponent(window.location.hash.replace(/^#/, ''));
if (initialHash && nodeIndex.has(initialHash)) {
  selectNodeById(initialHash, { focus: true });
} else {
  network.fit({ animation: false });
}
</script>
</body>
</html>`

  writeFileSync(outputPath, html, 'utf8')
}

export function toObsidian(
  graph: KnowledgeGraph,
  communities: Communities,
  outputDir: string,
  communityLabels: Record<number, string> = {},
  cohesionScores: Record<number, number> = {},
): number {
  mkdirSync(outputDir, { recursive: true })

  const nodeCommunity = _nodeCommunityMap(communities)
  const nodeFilename = new Map<string, string>()
  const seenNames = new Map<string, number>()

  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const base = safeName(String(attributes.label ?? nodeId))
    const count = seenNames.get(base) ?? 0
    nodeFilename.set(nodeId, count === 0 ? base : `${base}_${count}`)
    seenNames.set(base, count + 1)
  }

  for (const [nodeId, attributes] of graph.nodeEntries()) {
    const label = escapeMarkdownInline(String(attributes.label ?? nodeId))
    const communityId = nodeCommunity[nodeId] ?? -1
    const communityName = escapeMarkdownInline(communityLabels[communityId] ?? `Community ${communityId}`)
    const fileType = String(attributes.file_type ?? '')
    const fileTypeTag = sanitizeTag(FILE_TYPE_TAGS[fileType] ?? (fileType.length > 0 ? `graphify/${fileType}` : 'graphify/document'))
    const confidenceTag = sanitizeTag(`graphify/${dominantConfidence(graph, nodeId)}`)
    const communityTag = sanitizeTag(`community/${communityName.replaceAll(' ', '_')}`)
    const tags = [fileTypeTag, confidenceTag, communityTag]
    const lines = [
      '---',
      `source_file: ${JSON.stringify(String(attributes.source_file ?? ''))}`,
      `type: ${JSON.stringify(fileType)}`,
      `community: ${JSON.stringify(communityName)}`,
    ]

    if (typeof attributes.source_location === 'string' && attributes.source_location.length > 0) {
      lines.push(`location: ${JSON.stringify(attributes.source_location)}`)
    }

    lines.push('tags:')
    for (const tag of tags) {
      lines.push(`  - ${tag}`)
    }

    lines.push('---', '', `# ${label}`, '')

    const connections = nodeConnections(graph, nodeId).sort((left, right) => {
      const leftLabel = String(graph.nodeAttributes(left.neighborId).label ?? left.neighborId)
      const rightLabel = String(graph.nodeAttributes(right.neighborId).label ?? right.neighborId)
      return leftLabel.localeCompare(rightLabel)
    })
    if (connections.length > 0) {
      lines.push('## Connections')
      for (const connection of connections) {
        const neighborId = connection.neighborId
        lines.push(
          `- ${connectionPrefix(connection.direction)}[[${nodeFilename.get(neighborId) ?? safeName(String(graph.nodeAttributes(neighborId).label ?? neighborId))}]] - \`${escapeMarkdownInline(String(connection.attributes.relation ?? ''))}\` [${escapeMarkdownInline(String(connection.attributes.confidence ?? 'EXTRACTED'))}]`,
        )
      }
      lines.push('')
    }

    lines.push(tags.map((tag) => `#${tag}`).join(' '))
    writeFileSync(join(outputDir, `${nodeFilename.get(nodeId) ?? safeName(label)}.md`), `${lines.join('\n')}\n`, 'utf8')
  }

  const interCommunityEdges: Record<number, Record<number, number>> = {}
  for (const communityId of Object.keys(communities).map(Number)) {
    interCommunityEdges[communityId] = {}
  }

  for (const [sourceNodeId, targetNodeId] of graph.edgeEntries()) {
    const sourceCommunity = nodeCommunity[sourceNodeId]
    const targetCommunity = nodeCommunity[targetNodeId]
    if (sourceCommunity === undefined || targetCommunity === undefined || sourceCommunity === targetCommunity) {
      continue
    }

    interCommunityEdges[sourceCommunity] ??= {}
    interCommunityEdges[targetCommunity] ??= {}
    interCommunityEdges[sourceCommunity]![targetCommunity] = (interCommunityEdges[sourceCommunity]![targetCommunity] ?? 0) + 1
    interCommunityEdges[targetCommunity]![sourceCommunity] = (interCommunityEdges[targetCommunity]![sourceCommunity] ?? 0) + 1
  }

  const communityReach = (nodeId: string): number => {
    const currentCommunity = nodeCommunity[nodeId]
    return new Set(
      nodeConnections(graph, nodeId)
        .map((connection) => nodeCommunity[connection.neighborId])
        .filter((neighborCommunityId): neighborCommunityId is number => neighborCommunityId !== undefined && neighborCommunityId !== currentCommunity),
    ).size
  }

  let communityNotesWritten = 0
  for (const [communityIdRaw, nodeIds] of Object.entries(communities).sort((left, right) => Number(left[0]) - Number(right[0]))) {
    const communityId = Number(communityIdRaw)
    const communityName = escapeMarkdownInline(communityLabels[communityId] ?? `Community ${communityId}`)
    const lines = ['---', 'type: community']
    if (cohesionScores[communityId] !== undefined) {
      lines.push(`cohesion: ${cohesionScores[communityId]}`)
    }
    lines.push(`members: ${nodeIds.length}`, '---', '', `# ${communityName}`, '')
    if (cohesionScores[communityId] !== undefined) {
      lines.push(`**Cohesion:** ${cohesionScores[communityId]}`)
    }
    lines.push(`**Members:** ${nodeIds.length} nodes`, '', '## Members')
    for (const nodeId of [...nodeIds].sort((left, right) =>
      String(graph.nodeAttributes(left).label ?? left).localeCompare(String(graph.nodeAttributes(right).label ?? right)),
    )) {
      const attributes = graph.nodeAttributes(nodeId)
      const entry = [`- [[${nodeFilename.get(nodeId) ?? safeName(String(attributes.label ?? nodeId))}]]`]
      if (typeof attributes.file_type === 'string' && attributes.file_type.length > 0) {
        entry.push(escapeMarkdownInline(String(attributes.file_type)))
      }
      if (typeof attributes.source_file === 'string' && attributes.source_file.length > 0) {
        entry.push(escapeMarkdownInline(String(attributes.source_file)))
      }
      lines.push(entry.join(' - '))
    }

    const crossCommunity = interCommunityEdges[communityId] ?? {}
    if (Object.keys(crossCommunity).length > 0) {
      lines.push('', '## Connections to other communities')
      for (const [otherCommunityIdRaw, edgeCount] of Object.entries(crossCommunity).sort((left, right) => Number(right[1]) - Number(left[1]))) {
        const otherCommunityId = Number(otherCommunityIdRaw)
        const otherCommunityName = communityLabels[otherCommunityId] ?? `Community ${otherCommunityId}`
        lines.push(`- ${edgeCount} edge${edgeCount === 1 ? '' : 's'} to [[_COMMUNITY_${safeName(otherCommunityName)}]]`)
      }
    }

    const bridgeNodes = [...nodeIds]
      .map((nodeId) => ({ nodeId, degree: graph.degree(nodeId), reach: communityReach(nodeId) }))
      .filter((entry) => entry.reach > 0)
      .sort((left, right) => right.reach - left.reach || right.degree - left.degree)
      .slice(0, 5)
    if (bridgeNodes.length > 0) {
      lines.push('', '## Top bridge nodes')
      for (const bridgeNode of bridgeNodes) {
        lines.push(
          `- [[${nodeFilename.get(bridgeNode.nodeId) ?? safeName(String(graph.nodeAttributes(bridgeNode.nodeId).label ?? bridgeNode.nodeId))}]] - degree ${bridgeNode.degree}, connects to ${bridgeNode.reach} ${bridgeNode.reach === 1 ? 'community' : 'communities'}`,
        )
      }
    }

    writeFileSync(join(outputDir, `_COMMUNITY_${safeName(communityName)}.md`), `${lines.join('\n')}\n`, 'utf8')
    communityNotesWritten += 1
  }

  mkdirSync(join(outputDir, '.obsidian'), { recursive: true })
  const colorGroups = Object.entries(communities)
    .map(([communityIdRaw]) => Number(communityIdRaw))
    .sort((left, right) => left - right)
    .map((communityId) => {
      const color = COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length] ?? '#4E79A7'
      return {
        query: `tag:#community/${(communityLabels[communityId] ?? `Community ${communityId}`).replaceAll(' ', '_')}`,
        color: { a: 1, rgb: Number.parseInt(color.slice(1), 16) },
      }
    })
  writeFileSync(join(outputDir, '.obsidian', 'graph.json'), `${JSON.stringify({ colorGroups }, null, 2)}\n`, 'utf8')

  return graph.numberOfNodes() + communityNotesWritten
}
