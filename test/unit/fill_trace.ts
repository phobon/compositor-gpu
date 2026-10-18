// The format of test/unit/traces/*.json: per render() call, the inputs
// to the kept-texture fill decisions and what the renderer decided, as
// recorded on the M1 Pro from the code before src/gpu/fill_planner.ts
// (test:fill and a test:profile scroll on perf.html?band). The planner
// must decide the same way (fill_planner.test.ts).

type Rows = [number, number][]
type Rect4 = [number, number, number, number]

/** One render() call: its inputs, then what the current code decided. */
export interface FillTraceFrame {
  /** skip: skipFrame returned early; reuse: the post chain reused the
   * scene texture; draw: a full render. */
  kind: 'skip' | 'reuse' | 'draw'
  now: number
  scrollY: number
  /** Viewport height, CSS px. */
  height: number
  canvasX: number
  canvasY: number
  canvasWidth: number
  canvasHeight: number
  /** Canvas size, device px. */
  devW: number
  devH: number
  dpr: number
  canvasFill: 'band' | 'band-clear' | 'full'
  skipUnchanged: boolean
  reanchorStrips: boolean
  /** The post chain is active this frame. */
  chain: boolean
  backdrops: number
  /** contentChanged() before the uploads. */
  changed: boolean
  /** fixedRows(): viewport-y CSS px. */
  fixed: Rows
  /** layerState(): doc-y CSS px rows. */
  layers: { rows: Rows; key: string; live: boolean; fallback: boolean }
  // Decisions.
  lastStep: number
  /** keepMargins(): 'all', the rows a shift newly covered, or null. Absent
   * when it didn't run. */
  stale?: 'all' | [number, number] | null
  mainLoad?: 'clear' | 'load'
  /** The main pass's scissor (null: the whole canvas). */
  band?: Rect4 | null
  strip?: Rect4 | null
  extra?: Rect4[]
  bandIsStrip?: boolean
  trimmed?: boolean
  bandY?: [number, number] | null
  stripFrom?: [number, number] | null
  fillRows?: number
  // State after the frame.
  valid: Rows
  pending: Rows
  fixedScrollY: number | null
  layerKey: string
}
