import type { ImageRecord, Rect } from '../scene/records'
import type { Scene } from '../scene/scene'
import type { Layer } from '../types'
import { clipRectFor, readBox, toDocRect } from './styles'
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
function intersect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b
  if (!b) return a
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  return {
    x: x1,
    y: y1,
    width: Math.max(0, x2 - x1),
    height: Math.max(0, y2 - y1)
  }
}

export function readSubtree(
  root: Element,
  scene: Scene,
  layers: Set<Layer>
): void {
  scene.clear()
  let z = 0

  const visit = (el: Element, depth: number, clip: Rect | null): void => {
    if (SKIP_TAGS.has(el.tagName)) return
    z += 1

    if (layers.has('boxes')) {
      const box = readBox(el, scene.allocId(), z)
      if (box) {
        box.clip = clip
        scene.add(box)
      }
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
          z: z + 0.5,
          clip
        }
        scene.add(rec)
      }
    }

    // An element's own box is clipped by its ancestors; its content (children
    // and text) is additionally clipped by its own overflow.
    const own = clipRectFor(el)
    const childClip = own ? intersect(clip, own) : clip

    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        visit(child as Element, depth + 1, childClip)
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
          run.clip = childClip
          scene.add(run)
        }
      }
    }
  }

  visit(root, 0, null)
  scene.sort()
}
