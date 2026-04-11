/**
 * `paper` covers both extracted paper files and virtual citation/reference nodes.
 * Use `semantic_kind` and `virtual` to distinguish semantic graph entities from
 * top-level source files when needed.
 */
export type FileType = 'code' | 'document' | 'paper' | 'image' | 'rationale'

export type Confidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'

export interface ExtractionNode {
  id: string
  label: string
  file_type: FileType
  source_file: string
  source_location?: string
  semantic_kind?: 'citation' | 'reference'
  citation_kind?: 'doi' | 'arxiv' | 'citation_key'
  citation_value?: string
  reference_index?: number
  rationale_kind?: 'docstring' | 'comment'
  virtual?: boolean
  [key: string]: unknown
}

export interface ExtractionEdge {
  source: string
  target: string
  relation: string
  confidence: Confidence
  source_file: string
  source_location?: string
  weight?: number
  [key: string]: unknown
}

export interface Hyperedge {
  id?: string
  label?: string
  nodes: string[]
  relation?: string
  confidence?: Extract<Confidence, 'EXTRACTED' | 'INFERRED'>
  confidence_score?: number
  source_file?: string
  [key: string]: unknown
}

export interface ExtractionData {
  nodes: ExtractionNode[]
  edges: ExtractionEdge[]
  hyperedges?: Hyperedge[]
  input_tokens?: number
  output_tokens?: number
  [key: string]: unknown
}
