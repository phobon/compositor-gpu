import type { ImageRecord } from '../scene/records'
import type { Scene } from '../scene/scene'
import type { Layer } from '../types'
import { readBox, toDocRect } from './styles'
import { readTextNode } from './textRuns'

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'])

/**
 * Walk a root subtree and populate the scene with box / image / text records.
 * Paint order is approximated by DOM order + depth (z). Full stacking-context
 * resolution is a follow-up (ROADMAP §Boxes).
 *
 * All layout reads happen here, in one pass, so the frame's write phase touches
 * no DOM. Deliberately synchronous and allocation-conscious.
 */
export function readSubtree(
  root: Element,
  scene: Scene,
  layers: Set<Layer>
): void {
  scene.clear()
  let z = 0

  const visit = (el: Element, depth: number): void => {
    if (SKIP_TAGS.has(el.tagName)) return
    z += 1

    if (layers.has('boxes')) {
      const box = readBox(el, scene.allocId(), z)
      if (box) scene.add(box)
    }

    if (layers.has('images') && el.tagName === 'IMG') {
      const img = el as HTMLImageElement
      if (img.complete && img.naturalWidth > 0) {
        const rec: ImageRecord = {
          kind: 'image',
          id: scene.allocId(),
          rect: toDocRect(img.getBoundingClientRect()),
          source: img,
          objectFit:
            getComputedStyle(img).objectFit === 'cover'
              ? 'cover'
              : getComputedStyle(img).objectFit === 'contain'
                ? 'contain'
                : 'fill',
          opacity: 1,
          z: z + 0.5
        }
        scene.add(rec)
      }
    }

    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        visit(child as Element, depth + 1)
      } else if (layers.has('text') && child.nodeType === Node.TEXT_NODE) {
        const run = readTextNode(
          child as Text,
          el,
          scene.allocId(),
          0, // fontId resolved by the text backend in a later stage
          0
        )
        if (run) {
          run.z = z + 0.75
          scene.add(run)
        }
      }
    }
  }

  visit(root, 0)
  scene.sort()
}
