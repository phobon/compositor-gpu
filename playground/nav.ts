// Playground navigation: a "Tests" button (bottom left) listing every
// playground page with its useful URL switches, and jump links to the
// harness sections (`section[data-vr]`) of the current page. Imported by
// every page's entry script. Not under the harnesses (`?vr`, webdriver):
// it would land in their captures. `data-gpu-ignore` keeps it out of the
// mirror; its z-index puts it over the canvas, so it gets no hole.

interface Variant {
  label: string
  query: string
}

interface Page {
  file: string
  title: string
  about: string
  variants: Variant[]
}

const PAGES: Page[] = [
  {
    file: 'index.html',
    title: 'Mirror',
    about: 'Every mirrored feature, one section each (test:visual)',
    variants: [
      { label: 'harness view', query: '?vr' },
      { label: '/fx installed, nothing on', query: '?fx' },
      { label: 'no WebGPU (inert)', query: '?nogpu' },
      { label: 'unused @font-face', query: '?unusedfont' },
      { label: 'skeleton', query: '?skeleton=1' },
      { label: 'stats HUD', query: '?stats=1' }
    ]
  },
  {
    file: 'fx.html',
    title: 'Effects',
    about: 'Passes, materials, layers and presets (test:fx)',
    variants: [{ label: 'dials', query: '?dials=1' }]
  },
  {
    file: 'transition.html',
    title: 'Transitions',
    about: 'Page swaps through a held snapshot',
    variants: [
      { label: 'with lens', query: '?lens' },
      { label: 'auto-play', query: '?auto' }
    ]
  },
  {
    file: 'gallery.html',
    title: 'Gallery',
    about: '3D ring of image planes, opened by radialReveal',
    variants: []
  },
  {
    file: 'trail.html',
    title: 'Trails',
    about: 'Pointer trail field: pass, layer, material',
    variants: [
      { label: 'pixellate', query: '?pixel' },
      { label: 'scripted stroke, held', query: '?stroke&hold' },
      { label: 'page pass only', query: '?passonly' }
    ]
  },
  {
    file: 'morph.html',
    title: 'Morph',
    about: 'Text morphing into its next value, with a shockwave (M5d)',
    variants: [
      { label: 'auto', query: '?auto' },
      { label: '8 pieces', query: '?pieces=8' },
      { label: 'baked fonts (npm run bake:playground)', query: '?baked' },
      { label: 'slow', query: '?ms=3000' }
    ]
  },
  {
    file: 'layout.html',
    title: 'Layout morph',
    about: 'Keyed cards moving between a grid and a detail view (M5d-2)',
    variants: [
      { label: 'auto', query: '?auto' },
      { label: 'route swap (scroll down first)', query: '?scroll' },
      { label: 'slow', query: '?ms=3000' }
    ]
  },
  {
    file: 'sdf.html',
    title: 'Distance fields',
    about: "Glow and outline from each element's distance field (M5e)",
    variants: [
      { label: 'start without', query: '?off' },
      { label: 'baked fonts (heading falls back)', query: '?baked' }
    ]
  },
  {
    file: 'vectors.html',
    title: 'Vector images',
    about: 'Baked svg files drawn as vectors from <img> (M5f)',
    variants: [{ label: 'baked (npm run bake:playground)', query: '?baked' }]
  },
  {
    file: 'spike_morph.html',
    title: 'Morph spike',
    about: 'Segment outline morph with the wave pass (M5)',
    variants: [
      { label: 'sweep page', query: '?rows=6&size=96' },
      { label: 'no wave', query: '?nopost' },
      { label: 'plain page', query: '?off' }
    ]
  },
  {
    file: 'perf.html',
    title: 'Perf',
    about: '400 cards, ~84k glyphs (test:perf, test:profile)',
    variants: [
      { label: 'band fill', query: '?band' },
      { label: 'band-clear fill', query: '?bandclear' },
      { label: 'fixed content', query: '?fixed' },
      { label: 'no culling', query: '?nocull' },
      { label: 'no patching', query: '?nopatch' },
      { label: 'no frame skipping', query: '?noskip' }
    ]
  },
  {
    file: 'atlas.html',
    title: 'Image atlas',
    about: 'Atlas packing and eviction (test:atlas)',
    variants: []
  }
]

const NAV_CSS = `
.pg-nav {
  position: fixed; left: 12px; bottom: 12px; z-index: 2147483647;
  font: 12px/1.45 system-ui, sans-serif; color: #151517;
}
.pg-nav > button {
  font: inherit; font-weight: 600; padding: 6px 12px; border-radius: 8px;
  border: 1px solid #0002; background: #fff; color: inherit;
  box-shadow: 0 2px 10px #0003; cursor: pointer;
}
.pg-nav .pg-panel {
  position: absolute; left: 0; bottom: calc(100% + 8px);
  width: 300px; max-height: min(70vh, 640px); overflow: auto;
  background: #fff; border-radius: 10px; padding: 10px 12px;
  box-shadow: 0 6px 24px #0004; display: none;
}
.pg-nav.open .pg-panel { display: block; }
.pg-nav h4 {
  margin: 10px 0 4px; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.06em; color: #6b6b75;
}
.pg-nav h4:first-child { margin-top: 0; }
.pg-nav .pg-page { padding: 6px 0; border-top: 1px solid #0001; }
.pg-nav .pg-page:first-of-type { border-top: none; }
.pg-nav .pg-page.here > a { color: #4f46e5; }
.pg-nav a { color: inherit; text-decoration: none; }
.pg-nav a:hover { text-decoration: underline; }
.pg-nav .pg-title { font-weight: 600; font-size: 13px; }
.pg-nav .pg-about { color: #6b6b75; }
.pg-nav .pg-vars { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.pg-nav .pg-vars a {
  padding: 1px 6px; border-radius: 6px; background: #f1f1f4;
}
.pg-nav .pg-vars a.here { background: #e0e7ff; color: #3730a3; }
.pg-nav .pg-jumps { display: flex; flex-wrap: wrap; gap: 4px; }
.pg-nav .pg-jumps button {
  font: inherit; padding: 1px 6px; border-radius: 6px; border: none;
  background: #f1f1f4; color: inherit; cursor: pointer;
}
`

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) {
    e.className = cls
  }
  if (text) {
    e.textContent = text
  }
  return e
}

function mount(): void {
  const here = location.pathname.split('/').pop() || 'index.html'
  const search = location.search
  const root = el('nav', 'pg-nav')
  root.setAttribute('data-gpu-ignore', '')
  root.setAttribute('aria-label', 'Playground tests')
  const style = el('style')
  style.textContent = NAV_CSS
  const toggle = el('button', '', 'Tests')
  toggle.type = 'button'
  toggle.setAttribute('aria-expanded', 'false')
  const panel = el('div', 'pg-panel')
  toggle.addEventListener('click', () => {
    const open = root.classList.toggle('open')
    toggle.setAttribute('aria-expanded', String(open))
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      root.classList.remove('open')
      toggle.setAttribute('aria-expanded', 'false')
    }
  })

  // Jump links to this page's harness sections.
  const sections = [
    ...document.querySelectorAll<HTMLElement>('section[data-vr]')
  ]
  if (sections.length > 0) {
    panel.append(el('h4', '', 'On this page'))
    const jumps = el('div', 'pg-jumps')
    for (const s of sections) {
      const b = el('button', '', s.dataset.vr ?? '')
      b.type = 'button'
      b.addEventListener('click', () => {
        s.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
      jumps.append(b)
    }
    panel.append(jumps)
  }

  panel.append(el('h4', '', 'Pages'))
  for (const p of PAGES) {
    const onPage = p.file === here
    const item = el('div', onPage ? 'pg-page here' : 'pg-page')
    const link = el('a', 'pg-title', p.title)
    link.href = `./${p.file}`
    item.append(link, el('div', 'pg-about', p.about))
    if (p.variants.length > 0) {
      const vars = el('div', 'pg-vars')
      for (const v of p.variants) {
        const a = el('a', onPage && search === v.query ? 'here' : '', v.label)
        a.href = `./${p.file}${v.query}`
        a.title = `${p.file}${v.query}`
        vars.append(a)
      }
      item.append(vars)
    }
    panel.append(item)
  }

  root.append(style, panel, toggle)
  document.body.append(root)
}

const harness =
  new URLSearchParams(location.search).has('vr') || navigator.webdriver
if (!harness) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true })
  } else {
    mount()
  }
}

export {}
