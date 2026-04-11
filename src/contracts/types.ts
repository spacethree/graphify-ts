export type FileType = 'code' | 'document' | 'paper' | 'image' | 'rationale'

export type Confidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'

export interface ExtractionNode {
  id: string
  label: string
  file_type: FileType
  source_file: string
  source_location?: string
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
