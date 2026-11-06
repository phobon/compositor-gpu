// A small element builder for the devtools and the editor (shadow-root
// UIs, no framework).

/** Build a DOM element: `h('div', { class: 'x' }, child, 'text')`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) {
      continue
    }
    if (k === 'class') {
      el.className = String(v)
    } else if (k === 'text') {
      el.textContent = String(v)
    } else {
      el.setAttribute(k, v === true ? '' : String(v))
    }
  }
  for (const c of children) {
    if (c !== null && c !== undefined && c !== false) {
      el.append(c)
    }
  }
  return el
}
