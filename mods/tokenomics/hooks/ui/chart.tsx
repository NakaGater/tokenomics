import type { RequestUsage } from '../../types'
import {
  AXIS_CELLS,
  BAR_CELLS,
  COLUMN_CELLS,
  INPUT_COLOR,
  INPUT_ROWS,
  OUTPUT_COLOR,
  OUTPUT_ROWS,
  columnCells,
  columnText,
  columnsFitting,
  eighthsFor,
  inputOf,
  inputScale,
  outputScale,
} from '../lib/chart'
import { formatTokens } from '../lib/format'
import { TERMINAL_DEFAULT, packCells } from '../lib/raster'

import type { RasterElement, Ui } from './ui'

export type RequestChartProps = {
  ui: Ui
  /** The terminal's grid of colored cells; null where there is none, and the columns are drawn in characters. */
  Raster: RasterElement | null
  /** The last requests, oldest first. */
  requests: readonly RequestUsage[]
  /** Cells across the pane's body. */
  columns: number
}

/** A text centered in `width` cells (the texts here are one cell to a character). */
const centered = (text: string, width: number): string => ' '.repeat(Math.max(0, Math.floor((width - text.length) / 2))) + text

/** A one-cell patch of a color, for the legend. */
const swatch = (color: number): string => packCells([{ ch: '█', fg: color, bg: TERMINAL_DEFAULT }])

/**
 * The last requests as two charts of columns, oldest at the left and lined up: the prompt above in blue, the output below in
 * green. The turn is marked under the columns where it begins, with each request's two figures. The prompt's axis starts at the
 * number given for it, which is not nothing.
 */
export const RequestChart = (p: RequestChartProps) => {
  const { Box, Text } = p.ui
  const { Raster } = p
  const shown = p.requests.slice(-columnsFitting(p.columns, p.requests.length))
  const inScale = inputScale(shown)
  const outScale = outputScale(shown)
  if (inScale === null || outScale === null) return <Text dimColor>まだありません。リクエストが返ると出ます。</Text>

  const inAxis = (row: number): string =>
    row === 0
      ? formatTokens(inScale.top)
      : row === INPUT_ROWS / 2 - 1
        ? formatTokens(inScale.base + (inScale.row * INPUT_ROWS) / 2)
        : row === INPUT_ROWS - 1
          ? formatTokens(inScale.base)
          : ''
  const outAxis = (row: number): string => (row === 0 ? formatTokens(outScale.top) : row === OUTPUT_ROWS - 1 ? '0' : '')

  /** One chart: its axis at the left and a column for each request. */
  const chart = (name: string, rows: number, color: number, axis: (row: number) => string, eighths: (r: RequestUsage) => number, isCut: (r: RequestUsage) => boolean) => (
    <Box>
      <Box flexDirection="column" width={AXIS_CELLS}>
        {Array.from({ length: rows }, (_, row) => (
          <Text key={`${name}-axis-${row}`} dimColor>
            {axis(row).padStart(AXIS_CELLS - 1)}
          </Text>
        ))}
      </Box>
      {shown.map((r, i) => (
        <Box key={`${name}-col-${i}`} flexDirection="column" width={COLUMN_CELLS}>
          {Raster !== null ? (
            <Raster key={`${name}-bar-${i}`} columns={BAR_CELLS} rows={rows} cells={columnCells(eighths(r), rows, color, isCut(r))} />
          ) : (
            columnText(eighths(r), rows, isCut(r)).map((line, row) => <Text key={`${name}-line-${i}-${row}`}>{line}</Text>)
          )}
        </Box>
      ))}
    </Box>
  )

  /** A row under the charts: a name at the left and a text under each column. */
  const footer = (name: string, label: string, text: (r: RequestUsage, i: number) => string, isDim: boolean) => (
    <Box>
      <Box width={AXIS_CELLS}>
        <Text dimColor>{label}</Text>
      </Box>
      {shown.map((r, i) => (
        <Box key={`${name}-${i}`} width={COLUMN_CELLS}>
          <Text dimColor={isDim}>{centered(text(r, i), COLUMN_CELLS)}</Text>
        </Box>
      ))}
    </Box>
  )

  const hasAdvisor = shown.some(r => r.isAdvisor)

  return (
    <Box flexDirection="column">
      <Box gap={2} flexWrap="wrap">
        <Box gap={1}>
          {Raster !== null ? <Raster key="swatch-input" columns={1} rows={1} cells={swatch(INPUT_COLOR)} /> : <Text>█</Text>}
          <Text dimColor>入力（キャッシュ読み ＋ キャッシュ書き込み ＋ キャッシュなし）</Text>
        </Box>
        <Box gap={1}>
          {Raster !== null ? <Raster key="swatch-output" columns={1} rows={1} cells={swatch(OUTPUT_COLOR)} /> : <Text>▒</Text>}
          <Text dimColor>出力</Text>
        </Box>
      </Box>
      <Text dimColor>{`入力 tok　縦軸の下端 ${formatTokens(inScale.base)}・1段 ${formatTokens(inScale.row)}`}</Text>
      {chart('input', INPUT_ROWS, INPUT_COLOR, inAxis, r => (r.isAdvisor ? INPUT_ROWS * 8 : eighthsFor(inputOf(r), inScale, INPUT_ROWS)), r => r.isAdvisor)}
      <Text dimColor>{`出力 tok　0 から・1段 ${formatTokens(outScale.row)}`}</Text>
      {chart('output', OUTPUT_ROWS, OUTPUT_COLOR, outAxis, r => eighthsFor(r.output, outScale, OUTPUT_ROWS), () => false)}
      {footer('turn', '', (r, i) => (r.isAdvisor ? '※' : i === 0 || shown[i - 1]?.turn !== r.turn ? `T${r.turn}` : '·'), true)}
      {footer('in', '入力', r => formatTokens(inputOf(r)), false)}
      {footer('out', '出力', r => formatTokens(r.output), false)}
      <Text dimColor>
        {'入力の縦軸は 0 ではなく、下端から始まります（棒の長さは入力の大きさに比例しません。下の数字が実際の大きさ）。' +
          (hasAdvisor ? '※はアドバイザーを呼んだ回で、入力の棒は上で切っています（アドバイザー自身の分は含みません）。' : '')}
      </Text>
    </Box>
  )
}
