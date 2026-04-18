import { Buffer } from 'node:buffer'

import { KnowledgeGraph } from '../../contracts/graph.js'
import { workspaceBridges } from '../analyze.js'
import type { Communities } from '../cluster.js'

export type OverviewCommunityPageMode = 'interactive' | 'summary'

export interface OverviewBridgeSummary {
  id: string
  label: string
  community_name: string
  connected_communities: string[]
  connection_summary: string
  source_files: string[]
  degree: number
  score: number
  href: string
}

export function nodeAnchorId(nodeId: string): string {
  return `node-${Buffer.from(nodeId, 'utf8').toString('base64url')}`
}

export function buildOverviewBridgeSummaries(
  graph: KnowledgeGraph,
  communities: Communities,
  communityLabels: Record<number, string>,
  communityPageModes: ReadonlyMap<number, OverviewCommunityPageMode>,
  communityPagesDirname: string,
): OverviewBridgeSummary[] {
  return workspaceBridges(graph, communities, communityLabels).map((bridge) => {
    const communityId = bridge.community_id
    const href =
      communityId === null
        ? '#'
        : `${communityPagesDirname}/community-${communityId}.html#${
            communityPageModes.get(communityId) === 'summary' ? nodeAnchorId(bridge.id) : encodeURIComponent(bridge.id)
          }`

    return {
      id: bridge.id,
      label: bridge.label,
      community_name: bridge.community_label,
      connected_communities: bridge.connected_communities.map((community) => community.label),
      connection_summary: `connects ${bridge.connected_communities.map((community) => community.label).join(', ')}`,
      source_files: bridge.source_files,
      degree: bridge.degree,
      score: bridge.score,
      href,
    }
  })
}
