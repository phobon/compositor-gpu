// The editor's icons: 16 px line glyphs on a 24 unit grid, drawn with
// currentColor.

const PATHS = {
  x: 'M6 6l12 12M18 6L6 18',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  play: 'M8 5.5v13l10.5-6.5z',
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  pointer: 'M5 3l13 6.5-5.5 1.8-2.2 5.7z',
  eye: 'M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  reset: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  folder:
    'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14'
} as const

export type IconName = keyof typeof PATHS

const NS = 'http://www.w3.org/2000/svg'

export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', `i i-${name}`)
  const p = document.createElementNS(NS, 'path')
  p.setAttribute('d', PATHS[name])
  if (name === 'play') {
    p.setAttribute('fill', 'currentColor')
  } else {
    p.setAttribute('fill', 'none')
    p.setAttribute('stroke', 'currentColor')
    p.setAttribute('stroke-width', name === 'more' ? '3' : '1.75')
    p.setAttribute('stroke-linecap', 'round')
    p.setAttribute('stroke-linejoin', 'round')
  }
  svg.append(p)
  return svg
}
