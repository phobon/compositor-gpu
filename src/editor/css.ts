import { UI_BASE, UI_TOKENS } from '../util/ui_css'

// The editor's styles (in its shadow root), on the tools' shared look
// (util/ui_css.ts).
export const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.ed {
${UI_TOKENS}}
.ed[hidden] { display: none !important; }
.note { color: var(--danger); margin: 0; }
.empty { color: var(--muted-fg); margin: 0; padding: 4px 0; }
${UI_BASE}
/* Page overlays */
.catch { position: fixed; inset: 0; z-index: 2147483646; cursor: default; }
.ed.preview .catch { display: none; }
.box { position: fixed; z-index: 2147483646; pointer-events: none;
  border-radius: 4px; }
.box span { position: absolute; left: -1px; top: -21px; white-space: nowrap;
  padding: 2px 6px; border-radius: 4px; font: 500 11px/14px var(--mono); }
.box.hover { box-shadow: inset 0 0 0 1.5px var(--brand);
  background: rgb(139 124 246 / 0.08); }
.box.hover span { background: var(--brand); color: #fff; }
.box.sel { box-shadow: inset 0 0 0 2px var(--brand); }
.box.sel span { background: #fff; color: #2a2150; }
.box.mark { box-shadow: inset 0 0 0 1px rgb(139 124 246 / 0.45);
  background-image: linear-gradient(rgb(139 124 246 / 0.04), rgb(139 124 246 / 0.04)); }
.ed.preview .box.hover, .ed.preview .box.mark { display: none; }

.badge { display: inline-flex; align-items: center; height: 20px; padding: 0 6px;
  border-radius: var(--r-sm); background: var(--muted); color: var(--fg-2);
  font-size: 11px; font-weight: 500; white-space: nowrap; }
.badge.warn { background: rgb(242 184 75 / 0.14); color: var(--warn); }
.code { display: inline-block; max-width: 100%; padding: 3px 6px;
  border-radius: 4px; background: var(--muted); font: 11px/1.35 var(--mono);
  color: var(--fg-2); word-break: break-all; }

.field { display: grid; grid-template-columns: 84px minmax(0, 1fr);
  align-items: center; column-gap: 8px; min-height: 28px; }
.fl { display: flex; align-items: center; gap: 2px; min-width: 0; }
.flt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--muted-fg); }
.prow.set .flt { color: var(--fg); }
.prow.set .flt::before { content: ''; display: inline-block; width: 5px; height: 5px;
  margin: 0 5px 1px 0; border-radius: 50%; background: var(--brand); }
.fc { display: flex; align-items: center; gap: 6px; min-width: 0; }
.fc.wrap { flex-wrap: wrap; padding: 4px 0; }
.field:has(> .fc.wrap) { align-items: start; }
.field:has(> .fc.wrap) > .fl { padding-top: 8px; }
.fc.vec { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); }
.fc.vec .input.num { width: 100%; }
.live { grid-column: 2; font: 10.5px var(--mono); color: var(--brand); }
.live:empty { display: none; }

/* Toolbar */
.toolbar { position: fixed; z-index: 2147483647; top: 12px; left: 50%;
  translate: -50% 0; display: flex; align-items: center; gap: 2px; height: 44px;
  padding: 0 6px; border-radius: var(--r-lg); background: var(--bg);
  box-shadow: var(--shadow); backdrop-filter: blur(12px); white-space: nowrap; }
.brand { display: inline-flex; align-items: center; gap: 6px; padding: 0 6px 0 4px;
  font-weight: 600; color: var(--fg); }
.brand .i { color: var(--brand); }
.sep { width: 1px; height: 18px; margin: 0 4px; background: var(--ring-1); }
.tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--r-md);
  background: var(--muted); }
.tab { appearance: none; display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px; border: 0; border-radius: var(--r-sm);
  background: none; color: var(--muted-fg); font-weight: 500; cursor: pointer;
  transition-property: background-color, color, box-shadow;
  transition-duration: 120ms; }
.tab:hover { color: var(--fg); }
.tab[aria-pressed="true"] { background: #26262b; color: var(--fg);
  box-shadow: 0 0 0 1px var(--ring-1), 0 1px 2px rgb(0 0 0 / 0.4); }
.toolbar .btn.ghost.sm { color: var(--muted-fg); }
.toolbar .btn.ghost.sm kbd { margin-left: 2px; }
.file { appearance: none; display: inline-flex; align-items: center; gap: 8px;
  height: 28px; max-width: 240px; padding: 0 10px; border: 0; border-radius: var(--r-sm);
  background: none; color: var(--fg-2); cursor: pointer; font: 11.5px var(--mono); }
.file:hover { background: var(--hover); }
.file .ft { overflow: hidden; text-overflow: ellipsis; }
.dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--muted-2); }
.dot.ok { background: var(--ok); box-shadow: 0 0 0 3px rgb(63 191 127 / 0.18); }
.dot.dirty { background: var(--warn); box-shadow: 0 0 0 3px rgb(242 184 75 / 0.18); }
.dot.warn { background: var(--warn); }

/* Menu */
.menu { position: fixed; z-index: 2147483647; display: flex; flex-direction: column;
  min-width: 200px; padding: 4px; border-radius: var(--r-md); background: var(--bg);
  box-shadow: var(--shadow); backdrop-filter: blur(12px); }
.menu button { appearance: none; display: flex; align-items: center; gap: 8px;
  height: 30px; padding: 0 8px; border: 0; border-radius: 4px; background: none;
  text-align: left; cursor: pointer; color: var(--fg-2); }
.menu button:hover, .menu button:focus-visible { background: var(--hover); color: var(--fg);
  box-shadow: none; }
.menu button .i, .menu button span.i { width: 14px; color: var(--muted-fg); }
.menu .hint { margin-left: auto; color: var(--muted-fg); font-size: 11px; }
.mlabel { padding: 6px 8px 4px; color: var(--muted-fg); font-size: 11px; font-weight: 500; }
.msep { height: 1px; margin: 4px -4px; background: var(--ring-1); }

/* Banner and toast */
.banner { position: fixed; z-index: 2147483647; top: 66px; left: 50%; translate: -50% 0;
  display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 12px;
  border-radius: var(--r-lg); background: var(--bg); box-shadow: var(--shadow);
  backdrop-filter: blur(12px); }
.banner .i { color: var(--brand); }
.banner .bt { margin-right: 6px; color: var(--fg-2); }
.toast { position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;
  display: flex; align-items: center; gap: 8px; padding: 10px 14px;
  border-radius: var(--r-lg); background: var(--bg); box-shadow: var(--shadow);
  color: var(--fg-2); }
.toast .i { color: var(--ok); }

/* Inspector popover */
.pop { position: fixed; z-index: 2147483647; width: 360px; max-height: min(78vh, 720px);
  overflow: auto; overscroll-behavior: contain; border-radius: var(--r-lg);
  background: var(--bg); box-shadow: var(--shadow); backdrop-filter: blur(12px);
  scrollbar-width: thin; scrollbar-color: var(--muted-2) transparent; }
.phead { position: sticky; top: 0; z-index: 1; display: flex; align-items: flex-start;
  gap: 8px; padding: 12px 8px 10px 14px; background: var(--bg);
  box-shadow: 0 1px 0 var(--ring-1); }
.ptitle { flex: 1; min-width: 0; }
.ptitle h3 { margin: 0 0 2px; font: 600 12.5px/1.3 var(--mono); color: var(--fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ptitle p { margin: 0; }
.psec { display: flex; flex-direction: column; gap: 4px; padding: 10px 14px; }
.psec + .psec { box-shadow: 0 -1px 0 var(--ring-1); }
.psec.fx { gap: 8px; padding: 10px; }
.psec.fx > .empty, .psec.fx > .btn { margin: 0 4px; }
.pfoot2 { position: sticky; bottom: 0; padding: 10px; background: var(--bg);
  box-shadow: 0 -1px 0 var(--ring-1); }
.addfx { display: flex; gap: 6px; }
.addfx .select { flex: 1; }

/* Effect sections */
.sec { border-radius: var(--r-md); background: var(--surface);
  box-shadow: 0 0 0 1px var(--ring-1); }
.sh { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 6px 0 8px;
  cursor: pointer; list-style: none; border-radius: var(--r-md); user-select: none; }
.sh::-webkit-details-marker { display: none; }
.sh:hover { background: var(--hover); }
.sh > .i-chevronRight { color: var(--muted-fg); transition: rotate 150ms ease-out; }
.sec[open] > .sh > .i-chevronRight { rotate: 90deg; }
.sh .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; min-width: 0; }
.sh .switch { margin-right: 2px; }
.sb { display: flex; flex-direction: column; gap: 4px; padding: 4px 10px 10px; }
.params { display: flex; flex-direction: column; gap: 4px; padding-bottom: 6px;
  box-shadow: 0 1px 0 var(--ring-1); margin-bottom: 4px; }
.params:empty { display: none; }
.prow .btn.icon.xs { color: var(--muted-fg); }
.subhead { display: flex; align-items: center; justify-content: space-between;
  height: 28px; color: var(--muted-fg); font-size: 11px; font-weight: 500;
  text-transform: uppercase; letter-spacing: 0.04em; }
.subhead .btn { text-transform: none; letter-spacing: 0; font-size: 12px; }
.trigs { border-radius: var(--r-sm); box-shadow: 0 0 0 1px var(--ring-1); overflow: hidden; }
.trig + .trig { box-shadow: 0 -1px 0 var(--ring-1); }
.trig > summary { display: flex; align-items: center; gap: 6px; height: 32px;
  padding: 0 8px 0 4px; cursor: pointer; list-style: none; }
.trig > summary::-webkit-details-marker { display: none; }
.trig > summary:hover { background: var(--hover); }
.trig > summary > .i-chevronRight { color: var(--muted-fg); margin-left: auto;
  transition: rotate 150ms ease-out; }
.trig[open] > summary > .i-chevronRight { rotate: 90deg; }
.trig > summary .btn.icon.xs { color: var(--brand); }
.tsum { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 11px var(--mono); color: var(--fg-2); }
.tform { padding: 10px; background: rgb(0 0 0 / 0.18); box-shadow: 0 -1px 0 var(--ring-1); }
.tform .grid { display: grid; grid-template-columns: 72px minmax(0, 1fr);
  align-items: center; gap: 6px 8px; }
.frow { display: contents; }
.frow > .fc .switch { margin: 6px 0; }
.tfoot { display: flex; align-items: center; gap: 6px; margin-top: 10px; }

/* Command palette */
.pal { position: fixed; z-index: 2147483647; top: 16vh; left: 50%; translate: -50% 0;
  width: min(560px, 92vw); border-radius: 14px; background: var(--bg);
  box-shadow: 0 0 0 1px var(--ring-1), 0 24px 64px rgb(0 0 0 / 0.55);
  backdrop-filter: blur(12px); overflow: hidden; }
.psearch { display: flex; align-items: center; gap: 10px; height: 48px; padding: 0 14px;
  box-shadow: 0 1px 0 var(--ring-1); color: var(--muted-fg); }
.psearch input { flex: 1; height: 100%; border: 0; background: none; padding: 0;
  font-size: 14px; color: var(--fg); }
.psearch input::placeholder { color: var(--muted-fg); }
.psearch input:focus-visible { box-shadow: none; }
.pal ul { list-style: none; margin: 0; padding: 6px; max-height: min(52vh, 380px);
  overflow: auto; scrollbar-width: thin; scrollbar-color: var(--muted-2) transparent; }
.pal .ghead { padding: 8px 8px 4px; color: var(--muted-fg); font-size: 11px; font-weight: 500; }
.pal li[role="option"] { display: flex; align-items: center; gap: 10px; height: 36px;
  padding: 0 8px; border-radius: var(--r-md); cursor: pointer; color: var(--fg-2); }
.pal li[role="option"] .i { color: var(--muted-fg); }
.pal li[aria-selected="true"] { background: var(--hover); color: var(--fg); }
.pal li[aria-selected="true"] .i { color: var(--brand); }
.pal .lbl { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pal .chips { display: flex; gap: 4px; margin-left: auto; flex: none; }
.pal .none { padding: 24px 8px; text-align: center; color: var(--muted-fg); }
.pfoot { display: flex; align-items: center; gap: 6px; padding: 8px 14px;
  box-shadow: 0 -1px 0 var(--ring-1); color: var(--muted-fg); font-size: 11px; }
.pfoot span { margin-right: 8px; }

@media (prefers-reduced-motion: reduce) {
  .btn, .tab, .switch, .switch::after, .input, .select, .slider::-webkit-slider-thumb,
  .sh > .i-chevronRight, .trig > summary > .i-chevronRight { transition: none; }
  .btn:active:not([disabled]) { scale: none; }
}
`
