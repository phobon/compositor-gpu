// A small XML reader for the bake tool's svg files: elements, attributes,
// text, CDATA, comments, processing instructions and a doctype (skipped;
// entities it declares are not expanded and make the read fail). Enough
// for svg as editors and icon sets write it; not a validating parser.

export interface XmlElement {
  /** Local name (any prefix dropped). */
  name: string
  /** As written (xlink:href keeps its prefix). */
  attrs: Map<string, string>
  children: XmlElement[]
  /** Text content directly inside (CDATA included). */
  text: string
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp =
        e[1] === 'x' || e[1] === 'X'
          ? Number.parseInt(e.slice(2), 16)
          : Number.parseInt(e.slice(1), 10)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m
    }
    const v = ENTITIES[e]
    if (v === undefined) {
      throw new Error(`xml: unknown entity &${e};`)
    }
    return v
  })
}

const local = (n: string): string => n.slice(n.indexOf(':') + 1)

/** The document's root element; throws on malformed input. */
export function parseXml(src: string): XmlElement {
  let i = 0
  const stack: XmlElement[] = []
  let root: XmlElement | null = null
  const fail = (msg: string): never => {
    const line = src.slice(0, i).split('\n').length
    throw new Error(`xml: ${msg} (line ${line})`)
  }
  const skipTo = (end: string): void => {
    const k = src.indexOf(end, i)
    if (k < 0) {
      fail(`missing ${end}`)
    }
    i = k + end.length
  }
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    const textEnd = lt < 0 ? src.length : lt
    const top = stack[stack.length - 1]
    if (textEnd > i && top) {
      top.text += decode(src.slice(i, textEnd))
    }
    if (lt < 0) {
      break
    }
    i = lt
    if (src.startsWith('<!--', i)) {
      skipTo('-->')
    } else if (src.startsWith('<![CDATA[', i)) {
      const k = src.indexOf(']]>', i)
      if (k < 0) {
        fail('missing ]]>')
      }
      if (top) {
        top.text += src.slice(i + 9, k)
      }
      i = k + 3
    } else if (src.startsWith('<?', i)) {
      skipTo('?>')
    } else if (
      src.startsWith('<!DOCTYPE', i) ||
      src.startsWith('<!doctype', i)
    ) {
      // A doctype with an internal subset: skip to its closing ]>.
      const bracket = src.indexOf('[', i)
      const close = src.indexOf('>', i)
      if (bracket >= 0 && bracket < close) {
        if (/<!ENTITY/i.test(src.slice(bracket, src.indexOf(']', bracket)))) {
          fail('doctype entities are not supported')
        }
        skipTo(']>')
      } else {
        skipTo('>')
      }
    } else if (src[i + 1] === '/') {
      const k = src.indexOf('>', i)
      if (k < 0) {
        fail('unclosed end tag')
      }
      const name = local(src.slice(i + 2, k).trim())
      const open = stack.pop()
      if (!open || open.name !== name) {
        fail(`</${name}> does not close <${open?.name ?? ''}>`)
      }
      i = k + 1
    } else {
      // Start tag.
      const m = /^<([A-Za-z_][\w:.-]*)/.exec(src.slice(i, i + 256))
      if (!m) {
        fail('bad tag')
      }
      const name = (m as RegExpExecArray)[1] as string
      i += name.length + 1
      const el: XmlElement = {
        name: local(name),
        attrs: new Map(),
        children: [],
        text: ''
      }
      const attr = /\s*([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/y
      let selfClose = false
      for (;;) {
        attr.lastIndex = i
        const a = attr.exec(src)
        if (a) {
          el.attrs.set(a[1] as string, decode(a[3] ?? a[4] ?? ''))
          i = attr.lastIndex
          continue
        }
        const rest = /\s*(\/?)>/y
        rest.lastIndex = i
        const r = rest.exec(src)
        if (!r) {
          fail(`bad attributes in <${name}>`)
        }
        selfClose = (r as RegExpExecArray)[1] === '/'
        i = rest.lastIndex
        break
      }
      if (top) {
        top.children.push(el)
      } else if (root) {
        fail('more than one root element')
      } else {
        root = el
      }
      if (!selfClose) {
        stack.push(el)
      }
    }
  }
  if (stack.length) {
    fail(`<${stack[stack.length - 1]?.name}> not closed`)
  }
  if (!root) {
    return fail('no root element')
  }
  return root
}
