export type GraphAttributes = Record<string, unknown>

export interface KnowledgeGraphOptions {
  directed?: boolean
}

interface StoredEdge {
  source: string
  target: string
  attributes: GraphAttributes
}

export class KnowledgeGraph {
  public readonly graph: GraphAttributes = {}
  public readonly directed: boolean

  private readonly nodeMap = new Map<string, GraphAttributes>()
  private readonly edgeMap = new Map<string, StoredEdge>()
  private readonly successorMap = new Map<string, Set<string>>()
  private readonly predecessorMap = new Map<string, Set<string>>()

  constructor(options: KnowledgeGraphOptions | boolean = {}) {
    this.directed = typeof options === 'boolean' ? options : options.directed === true
    this.graph.directed = this.directed
  }

  private edgeKey(source: string, target: string): string {
    if (this.directed) {
      return `${source}\u0000${target}`
    }
    return [source, target].sort().join('\u0000')
  }

  addNode(id: string, attributes: GraphAttributes): void {
    this.nodeMap.set(id, { ...attributes })
    if (!this.successorMap.has(id)) {
      this.successorMap.set(id, new Set())
    }
    if (!this.predecessorMap.has(id)) {
      this.predecessorMap.set(id, new Set())
    }
  }

  addEdge(source: string, target: string, attributes: GraphAttributes): void {
    if (!this.nodeMap.has(source)) {
      this.addNode(source, {})
    }
    if (!this.nodeMap.has(target)) {
      this.addNode(target, {})
    }

    const key = this.edgeKey(source, target)
    this.edgeMap.set(key, {
      source,
      target,
      attributes: { ...attributes },
    })

    this.successorMap.get(source)?.add(target)
    this.predecessorMap.get(target)?.add(source)

    if (!this.directed) {
      this.successorMap.get(target)?.add(source)
      this.predecessorMap.get(source)?.add(target)
    }
  }

  isDirected(): boolean {
    return this.directed
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
    return [...(this.successorMap.get(id) ?? [])]
  }

  successors(id: string): string[] {
    return this.neighbors(id)
  }

  predecessors(id: string): string[] {
    return [...(this.predecessorMap.get(id) ?? [])]
  }

  incidentNeighbors(id: string): string[] {
    const neighbors = new Set<string>(this.successors(id))
    for (const predecessor of this.predecessors(id)) {
      neighbors.add(predecessor)
    }
    return [...neighbors]
  }

  degree(id: string): number {
    return this.incidentNeighbors(id).length
  }

  nodeAttributes(id: string): GraphAttributes {
    const attributes = this.nodeMap.get(id)
    if (!attributes) {
      throw new Error(`Unknown node: ${id}`)
    }
    return { ...attributes }
  }

  edgeAttributes(source: string, target: string): GraphAttributes {
    const edge = this.edgeMap.get(this.edgeKey(source, target))
    if (!edge) {
      throw new Error(`Unknown edge: ${source} ${this.directed ? '->' : '<->'} ${target}`)
    }
    return { ...edge.attributes }
  }
}
