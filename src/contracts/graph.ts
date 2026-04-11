export type GraphAttributes = Record<string, unknown>

interface StoredEdge {
  source: string
  target: string
  attributes: GraphAttributes
}

function edgeKey(source: string, target: string): string {
  return [source, target].sort().join('\u0000')
}

export class KnowledgeGraph {
  // Mirrors the Python reference, which uses an undirected NetworkX graph and
  // stores the original direction on each edge via _src/_tgt attributes.
  public readonly graph: GraphAttributes = {}

  private readonly nodeMap = new Map<string, GraphAttributes>()
  private readonly edgeMap = new Map<string, StoredEdge>()
  private readonly adjacencyMap = new Map<string, Set<string>>()

  addNode(id: string, attributes: GraphAttributes): void {
    this.nodeMap.set(id, { ...attributes })
    if (!this.adjacencyMap.has(id)) {
      this.adjacencyMap.set(id, new Set())
    }
  }

  addEdge(source: string, target: string, attributes: GraphAttributes): void {
    if (!this.nodeMap.has(source)) {
      this.addNode(source, {})
    }
    if (!this.nodeMap.has(target)) {
      this.addNode(target, {})
    }

    const key = edgeKey(source, target)
    this.edgeMap.set(key, {
      source,
      target,
      attributes: { ...attributes },
    })

    this.adjacencyMap.get(source)?.add(target)
    this.adjacencyMap.get(target)?.add(source)
  }

  hasNode(id: string): boolean {
    return this.nodeMap.has(id)
  }

  numberOfNodes(): number {
    return this.nodeMap.size
  }

  numberOfEdges(): number {
    return this.edgeMap.size
  }

  nodeIds(): string[] {
    return [...this.nodeMap.keys()]
  }

  nodeEntries(): Array<[string, GraphAttributes]> {
    return [...this.nodeMap.entries()].map(([id, attributes]) => [id, { ...attributes }])
  }

  edgeEntries(): Array<[string, string, GraphAttributes]> {
    return [...this.edgeMap.values()].map(({ source, target, attributes }) => [source, target, { ...attributes }])
  }

  neighbors(id: string): string[] {
    return [...(this.adjacencyMap.get(id) ?? [])]
  }

  degree(id: string): number {
    return this.adjacencyMap.get(id)?.size ?? 0
  }

  nodeAttributes(id: string): GraphAttributes {
    const attributes = this.nodeMap.get(id)
    if (!attributes) {
      throw new Error(`Unknown node: ${id}`)
    }
    return { ...attributes }
  }

  edgeAttributes(source: string, target: string): GraphAttributes {
    const edge = this.edgeMap.get(edgeKey(source, target))
    if (!edge) {
      throw new Error(`Unknown edge: ${source} <-> ${target}`)
    }
    return { ...edge.attributes }
  }
}
