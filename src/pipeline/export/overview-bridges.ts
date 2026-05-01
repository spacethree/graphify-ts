import { Buffer } from 'node:buffer'

import type { WorkspaceBridge } from '../analyze.js'

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

export function bridgePageFilename(nodeId: string): string {
  return `bridge-${Buffer.from(nodeId, 'utf8').toString('base64url')}.html`
}

export function buildOverviewBridgeSummaries(
  bridges: readonly WorkspaceBridge[],
  communityPagesDirname: string,
): OverviewBridgeSummary[] {
  return bridges.map((bridge) => {
    return {
      id: bridge.id,
      label: bridge.label,
      community_name: bridge.community_label,
      connected_communities: bridge.connected_communities.map((community) => community.label),
      connection_summary: `connects ${bridge.connected_communities.map((community) => community.label).join(', ')}`,
      source_files: bridge.source_files,
      degree: bridge.degree,
      score: bridge.score,
      href: `${communityPagesDirname}/${bridgePageFilename(bridge.id)}`,
    }
  })
}
