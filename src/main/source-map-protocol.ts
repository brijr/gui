export interface MapRequest {
  scriptUrl: string
  line: number
  column: number
}

export interface MappedPosition {
  source: string
  line: number
  column: number | undefined
}
