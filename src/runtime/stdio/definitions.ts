export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface McpPromptDefinition {
  name: string
  title: string
  description: string
  arguments?: Array<{
    name: string
    description: string
    required?: boolean
  }>
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'query_graph',
    description: 'Traverse the graph to answer a question from graph evidence.',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string' },
        mode: { type: 'string', enum: ['bfs', 'dfs'] },
        depth: { type: 'number' },
        token_budget: { type: 'number' },
        rank_by: { type: 'string', enum: ['relevance', 'degree'] },
        community_id: { type: 'number' },
        file_type: { type: 'string' },
      },
    },
  },
  {
    name: 'get_node',
    description: 'Return details for one graph node.',
    inputSchema: {
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string' },
      },
    },
  },
  {
    name: 'graph_diff',
    description: 'Compare the current graph to a baseline graph.json and summarize what changed.',
    inputSchema: {
      type: 'object',
      required: ['baseline_graph_path'],
      properties: {
        baseline_graph_path: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'semantic_anomalies',
    description: 'Return the highest-signal semantic anomalies in the current graph snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        top_n: { type: 'number' },
      },
    },
  },
  {
    name: 'get_neighbors',
    description: 'Return neighbors for one node, optionally filtered by relation.',
    inputSchema: {
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string' },
        relation_filter: { type: 'string' },
      },
    },
  },
  {
    name: 'shortest_path',
    description: 'Find the shortest path between two labels in the graph.',
    inputSchema: {
      type: 'object',
      required: ['source', 'target'],
      properties: {
        source: { type: 'string' },
        target: { type: 'string' },
        max_hops: { type: 'number' },
      },
    },
  },
  {
    name: 'explain_node',
    description: 'Explain a node and summarize its neighborhood.',
    inputSchema: {
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string' },
        relation_filter: { type: 'string' },
      },
    },
  },
  {
    name: 'graph_stats',
    description: 'Return summary graph statistics.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'god_nodes',
    description: 'Return the most connected non-file nodes in the graph.',
    inputSchema: {
      type: 'object',
      properties: {
        top_n: { type: 'number' },
      },
    },
  },
  {
    name: 'get_community',
    description: 'Return the members of a community by numeric id.',
    inputSchema: {
      type: 'object',
      required: ['community_id'],
      properties: {
        community_id: { type: 'number' },
      },
    },
  },
  {
    name: 'community_details',
    description:
      'Get structured details about a community at different zoom levels. Micro: name + top 3 nodes. Mid: key nodes, entry/exit points, bridges. Macro: all nodes, edges, file distribution. Use with retrieve for token-efficient codebase exploration.',
    inputSchema: {
      type: 'object',
      required: ['community_id'],
      properties: {
        community_id: { type: 'number', description: 'Community ID to get details for' },
        zoom: { type: 'string', enum: ['micro', 'mid', 'macro'], description: 'Detail level (default: mid)' },
      },
    },
  },
  {
    name: 'community_overview',
    description:
      'Get a micro-level overview of all communities — names, sizes, and top nodes. Use this first to understand the codebase structure before diving into specific communities.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'impact',
    description:
      'Analyze the blast radius of changing a node. Returns direct dependents, transitive dependents, affected files, and affected communities. Use this before making changes to understand what could break.',
    inputSchema: {
      type: 'object',
      required: ['label'],
      properties: {
        label: { type: 'string', description: 'Label of the node to analyze impact for' },
        depth: { type: 'number', description: 'Maximum traversal depth (default 3, max 5)' },
        edge_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: limit to specific edge types (e.g. ["calls", "imports_from"])',
        },
      },
    },
  },
  {
    name: 'call_chain',
    description:
      'Find all execution paths between two nodes filtered by call/import edges. Returns ordered chains showing how execution flows from source to target.',
    inputSchema: {
      type: 'object',
      required: ['source', 'target'],
      properties: {
        source: { type: 'string', description: 'Starting node label' },
        target: { type: 'string', description: 'Target node label' },
        max_hops: { type: 'number', description: 'Maximum chain length (default 8)' },
        edge_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Edge types to follow (default: ["calls", "imports_from"])',
        },
      },
    },
  },
  {
    name: 'pr_impact',
    description:
      'Analyze the impact of current git changes against the knowledge graph. Parses git diff, finds affected nodes, and computes blast radius across the codebase. Use before creating a PR to understand risk.',
    inputSchema: {
      type: 'object',
      properties: {
        base_branch: { type: 'string', description: 'Base branch to diff against (default: auto-detect main/master)' },
        depth: { type: 'number', description: 'Blast radius depth (default 3)' },
      },
    },
  },
  {
    name: 'retrieve',
    description:
      'Retrieve relevant context from the knowledge graph for a natural language question. Returns matched nodes with code snippets, relationships, community context, and structural signals (god nodes, bridges). Use this as the primary tool for answering codebase questions.',
    inputSchema: {
      type: 'object',
      required: ['question', 'budget'],
      properties: {
        question: { type: 'string', description: 'Natural language question about the codebase' },
        budget: { type: 'number', description: 'Maximum tokens to return in the context bundle' },
        community: { type: 'number', description: 'Optional: limit retrieval to one community id' },
        file_type: { type: 'string', description: 'Optional: limit retrieval to one file type (e.g. code, document)' },
      },
    },
  },
]

export const MCP_PROMPTS: McpPromptDefinition[] = [
  {
    name: 'graph_query_prompt',
    title: 'Graph Evidence Query',
    description: 'Ask a question and answer it using graph evidence only.',
    arguments: [
      { name: 'question', description: 'The question to answer from the graph', required: true },
      { name: 'mode', description: 'Traversal mode: bfs or dfs' },
    ],
  },
  {
    name: 'graph_path_prompt',
    title: 'Graph Path Exploration',
    description: 'Explain the shortest path between two graph concepts.',
    arguments: [
      { name: 'source', description: 'Starting concept label', required: true },
      { name: 'target', description: 'Target concept label', required: true },
    ],
  },
  {
    name: 'graph_explain_prompt',
    title: 'Graph Node Explanation',
    description: 'Explain a single node and summarize its neighborhood.',
    arguments: [
      { name: 'label', description: 'Node label to explain', required: true },
      { name: 'relation', description: 'Optional neighbor relation filter' },
    ],
  },
  {
    name: 'graph_community_summary_prompt',
    title: 'Graph Community Summary',
    description: 'Summarize one community, its key nodes, and its boundaries.',
    arguments: [{ name: 'community_id', description: 'Numeric community id to summarize', required: true }],
  },
]
