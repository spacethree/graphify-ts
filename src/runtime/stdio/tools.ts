import { dirname } from 'node:path'

import type { CompareRefsInput } from '../../infrastructure/time-travel.js'
import { buildCommunityLabels } from '../../pipeline/community-naming.js'
import { communityDetailsAtZoom, communityDetailsMicro, type CommunityZoomLevel } from '../../pipeline/community-details.js'
import { validateGraphPath } from '../../shared/security.js'
import { analyzeImpact, callChains, compactImpactResult } from '../impact.js'
import { analyzePrImpact } from '../pr-impact.js'
import { compactRetrieveResult, retrieveContext } from '../retrieve.js'
import type { TimeTravelView } from '../time-travel.js'
import {
  communitiesFromGraph,
  getCommunity,
  getNeighbors,
  getNode,
  godNodesSummary,
  graphStats,
  queryGraph,
  semanticAnomaliesSummary,
  shortestPath,
} from '../serve.js'
import type { KnowledgeGraph } from '../../contracts/graph.js'

interface StdioResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

interface ToolHelpers {
  ok(id: string | number | null, result: unknown): StdioResponse
  failure(id: string | number | null, code: number, message: string): StdioResponse
  textToolResult(text: string): { content: Array<{ type: 'text'; text: string }> }
  stringParam(params: unknown, key: string): string | null
  stringParamAlias(params: unknown, keys: readonly string[]): string | null
  numberParamAlias(params: unknown, keys: readonly string[], options?: { min?: number; max?: number }): number | null
  recordParam(params: unknown, key: string): Record<string, unknown> | null
  loadGraphCached(graphPath: string): KnowledgeGraph
  queryOptionsFromParams(id: string | number | null, params: unknown): { failureResponse?: StdioResponse; queryOptions?: Record<string, unknown> }
  handleGraphDiff(id: string | number | null, currentGraphPath: string, params: unknown): StdioResponse
  compareRefs(input: CompareRefsInput): Promise<unknown>
  readStoredCommunityLabels(graphPath: string): Record<number, string>
  jsonrpcInvalidParams: number
  jsonrpcServerError: number
  maxStdioTextLength: number
  maxStdioHops: number
  maxStdioTokenBudget: number
}

const TIME_TRAVEL_VIEWS = new Set<TimeTravelView>(['summary', 'risk', 'drift', 'timeline'])

export function handleToolCall(id: string | number | null, graphPath: string, params: unknown, helpers: ToolHelpers): StdioResponse | Promise<StdioResponse> {
  const toolName = helpers.stringParam(params, 'name')
  if (!toolName) {
    return helpers.failure(id, helpers.jsonrpcInvalidParams, `tools/call requires a string name parameter <= ${helpers.maxStdioTextLength} characters`)
  }

  const toolArguments = helpers.recordParam(params, 'arguments') ?? {}
  const graph = helpers.loadGraphCached(graphPath)

  switch (toolName) {
    case 'query_graph': {
      const question = helpers.stringParam(toolArguments, 'question')
      if (!question) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `query_graph requires a string question parameter <= ${helpers.maxStdioTextLength} characters`)
      }

      const { failureResponse, queryOptions } = helpers.queryOptionsFromParams(id, toolArguments)
      if (failureResponse) {
        return failureResponse
      }

      return helpers.ok(id, helpers.textToolResult(queryGraph(graph, question, queryOptions)))
    }
    case 'get_node': {
      const label = helpers.stringParam(toolArguments, 'label')
      if (!label) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `get_node requires a string label parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      return helpers.ok(id, helpers.textToolResult(getNode(graph, label)))
    }
    case 'graph_diff': {
      const diffResponse = helpers.handleGraphDiff(id, graphPath, toolArguments)
      return 'error' in diffResponse && diffResponse.error ? diffResponse : helpers.ok(id, helpers.textToolResult(String(diffResponse.result ?? '')))
    }
    case 'semantic_anomalies':
      return helpers.ok(id, helpers.textToolResult(semanticAnomaliesSummary(graphPath, helpers.numberParamAlias(toolArguments, ['top_n', 'topN'], { min: 1, max: 100 }) ?? 5)))
    case 'get_neighbors': {
      const label = helpers.stringParam(toolArguments, 'label')
      if (!label) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `get_neighbors requires a string label parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      return helpers.ok(id, helpers.textToolResult(getNeighbors(graph, label, helpers.stringParamAlias(toolArguments, ['relation_filter', 'relation']) ?? '')))
    }
    case 'shortest_path': {
      const source = helpers.stringParam(toolArguments, 'source')
      const target = helpers.stringParam(toolArguments, 'target')
      if (!source || !target) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `shortest_path requires string source and target parameters <= ${helpers.maxStdioTextLength} characters`)
      }
      return helpers.ok(id, helpers.textToolResult(shortestPath(graph, source, target, helpers.numberParamAlias(toolArguments, ['max_hops', 'maxHops'], { min: 1, max: helpers.maxStdioHops }) ?? 8)))
    }
    case 'explain_node': {
      const label = helpers.stringParam(toolArguments, 'label')
      if (!label) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `explain_node requires a string label parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      const relation = helpers.stringParamAlias(toolArguments, ['relation_filter', 'relation']) ?? ''
      return helpers.ok(id, helpers.textToolResult(`${getNode(graph, label)}\n\n${getNeighbors(graph, label, relation)}`))
    }
    case 'graph_stats':
      return helpers.ok(id, helpers.textToolResult(graphStats(graph)))
    case 'god_nodes':
      return helpers.ok(id, helpers.textToolResult(godNodesSummary(graph, helpers.numberParamAlias(toolArguments, ['top_n', 'topN'], { min: 1, max: 100 }) ?? 10)))
    case 'get_community': {
      const communityId = helpers.numberParamAlias(toolArguments, ['community_id', 'communityId'], { min: 0 })
      if (communityId === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'get_community requires a numeric community_id parameter >= 0')
      }
      return helpers.ok(id, helpers.textToolResult(getCommunity(graph, communitiesFromGraph(graph), communityId)))
    }
    case 'community_details': {
      const detailCommunityId = helpers.numberParamAlias(toolArguments, ['community_id', 'communityId'], { min: 0 })
      if (detailCommunityId === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'community_details requires a numeric community_id parameter >= 0')
      }
      const zoomRaw = helpers.stringParam(toolArguments, 'zoom') ?? 'mid'
      const zoom: CommunityZoomLevel = zoomRaw === 'micro' || zoomRaw === 'mid' || zoomRaw === 'macro' ? zoomRaw : 'mid'
      const detailCommunities = communitiesFromGraph(graph)
      const detailLabels = { ...buildCommunityLabels(graph, detailCommunities), ...helpers.readStoredCommunityLabels(graphPath) }
      const details = communityDetailsAtZoom(graph, detailCommunities, detailLabels, detailCommunityId, zoom)
      if (!details) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unknown community: ${detailCommunityId}`)
      }
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(details)))
    }
    case 'community_overview': {
      const overviewCommunities = communitiesFromGraph(graph)
      const overviewLabels = { ...buildCommunityLabels(graph, overviewCommunities), ...helpers.readStoredCommunityLabels(graphPath) }
      const overview = communityDetailsMicro(graph, overviewCommunities, overviewLabels)
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(overview)))
    }
    case 'impact': {
      const label = helpers.stringParam(toolArguments, 'label')
      if (!label) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `impact requires a string label parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      const impactDepth = helpers.numberParamAlias(toolArguments, ['depth'], { min: 1, max: 5 })
      const rawEdgeTypes = toolArguments.edge_types
      const edgeTypes = Array.isArray(rawEdgeTypes) ? rawEdgeTypes.filter((t): t is string => typeof t === 'string') : undefined
      const communityLabels = helpers.readStoredCommunityLabels(graphPath)
      const impactResult = analyzeImpact(graph, communityLabels, {
        label,
        ...(impactDepth !== null ? { depth: impactDepth } : {}),
        ...(edgeTypes && edgeTypes.length > 0 ? { edgeTypes } : {}),
      })
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(compactImpactResult(impactResult))))
    }
    case 'call_chain': {
      const chainSource = helpers.stringParam(toolArguments, 'source')
      const chainTarget = helpers.stringParam(toolArguments, 'target')
      if (!chainSource || !chainTarget) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `call_chain requires string source and target parameters <= ${helpers.maxStdioTextLength} characters`)
      }
      const chainMaxHops = helpers.numberParamAlias(toolArguments, ['max_hops', 'maxHops'], { min: 1, max: helpers.maxStdioHops })
      const rawChainEdgeTypes = toolArguments.edge_types
      const chainEdgeTypes = Array.isArray(rawChainEdgeTypes) ? rawChainEdgeTypes.filter((t): t is string => typeof t === 'string') : undefined
      const chains = callChains(graph, chainSource, chainTarget, chainMaxHops ?? 8, chainEdgeTypes)
      return helpers.ok(id, helpers.textToolResult(JSON.stringify({ source: chainSource, target: chainTarget, chains, total: chains.length })))
    }
    case 'pr_impact': {
      const prBaseBranch = helpers.stringParamAlias(toolArguments, ['base_branch', 'baseBranch'])
      const prDepth = helpers.numberParamAlias(toolArguments, ['depth'], { min: 1, max: 5 })
      const graphDir = dirname(validateGraphPath(graphPath))
      const projectRoot = dirname(graphDir)
      const prResult = analyzePrImpact(graph, projectRoot, {
        ...(prBaseBranch ? { baseBranch: prBaseBranch } : {}),
        ...(prDepth !== null ? { depth: prDepth } : {}),
      })
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(prResult)))
    }
    case 'retrieve': {
      const question = helpers.stringParam(toolArguments, 'question')
      if (!question) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `retrieve requires a string question parameter <= ${helpers.maxStdioTextLength} characters`)
      }
      const retrieveBudget = helpers.numberParamAlias(toolArguments, ['budget'], { min: 1, max: helpers.maxStdioTokenBudget })
      if (retrieveBudget === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `retrieve requires a numeric budget parameter between 1 and ${helpers.maxStdioTokenBudget}`)
      }
      const retrieveCommunity = helpers.numberParamAlias(toolArguments, ['community', 'community_id', 'communityId'], { min: 0 })
      const retrieveFileType = helpers.stringParamAlias(toolArguments, ['file_type', 'fileType'])
      const result = retrieveContext(graph, {
        question,
        budget: retrieveBudget,
        ...(retrieveCommunity !== null ? { community: retrieveCommunity } : {}),
        ...(retrieveFileType ? { fileType: retrieveFileType } : {}),
      })
      return helpers.ok(id, helpers.textToolResult(JSON.stringify(compactRetrieveResult(result))))
    }
    case 'time_travel_compare': {
      const fromRef = helpers.stringParamAlias(toolArguments, ['from_ref', 'fromRef'])
      const toRef = helpers.stringParamAlias(toolArguments, ['to_ref', 'toRef'])
      if (!fromRef || !toRef) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, `time_travel_compare requires string from_ref and to_ref parameters <= ${helpers.maxStdioTextLength} characters`)
      }

      const rawView = helpers.stringParam(toolArguments, 'view')
      if (Object.hasOwn(toolArguments, 'view') && (!rawView || !TIME_TRAVEL_VIEWS.has(rawView as TimeTravelView))) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'view must be one of summary, risk, drift, timeline')
      }

      const limit = helpers.numberParamAlias(toolArguments, ['limit'], { min: 0, max: 100 })
      if (Object.hasOwn(toolArguments, 'limit') && limit === null) {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'limit must be a number between 0 and 100')
      }

      const refresh = toolArguments.refresh
      if (Object.hasOwn(toolArguments, 'refresh') && typeof refresh !== 'boolean') {
        return helpers.failure(id, helpers.jsonrpcInvalidParams, 'refresh must be a boolean')
      }

      return helpers.compareRefs({
        fromRef,
        toRef,
        ...(rawView ? { view: rawView as TimeTravelView } : {}),
        ...(typeof refresh === 'boolean' ? { refresh } : {}),
        ...(limit !== null ? { limit } : {}),
      }).then((result) => {
        return helpers.ok(id, helpers.textToolResult(JSON.stringify(result)))
      }).catch((error: unknown) => {
        return helpers.failure(id, helpers.jsonrpcServerError, error instanceof Error ? error.message : 'Time travel comparison failed')
      })
    }
    default:
      return helpers.failure(id, helpers.jsonrpcInvalidParams, `Unknown tool: ${toolName}`)
  }
}
