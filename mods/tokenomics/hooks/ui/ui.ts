import type { Elements } from 'claude-code'

/** The elements the band, the pane and the offers draw with; terminal and desktop agree on these three. */
export type Ui = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

/** The terminal's grid of colored cells: the cat and the gauge are drawn with it. The desktop has none. */
export type RasterElement = Elements['terminal']['Raster']

/** The terminal's picture leaf, for a PNG over a box of cells where the terminal can draw pixels (kitty, Ghostty); the cat is drawn with it there. */
export type ImageElement = Elements['terminal']['Image']
