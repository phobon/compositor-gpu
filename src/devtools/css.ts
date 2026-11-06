import { UI_BASE, UI_TOKENS } from '../util/ui_css'

// The devtools panel's styles (in its shadow root), on the tools' shared
// look (util/ui_css.ts). The recording viewer (viewer.ts) uses them too.
export const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
${UI_TOKENS}
  --line: var(--ring-1); --dim: var(--muted-fg); --accent: var(--brand);
  --bad: var(--danger);
}
${UI_BASE}
.dim { color: var(--muted-fg); }

/* The closed panel's button */
.fab { position: fixed; z-index: 2147483646; display: flex; align-items: center;
  gap: 8px; height: 32px; padding: 0 12px; border: 0; border-radius: var(--r-lg);
  background: var(--bg); box-shadow: var(--shadow); backdrop-filter: blur(12px);
  cursor: pointer; font-weight: 600; letter-spacing: 0.02em; color: var(--fg);
  transition-property: background-color, scale; transition-duration: 120ms; }
.fab:hover { background: rgb(28 28 31 / 0.97); }
.fab:active { scale: 0.96; }
.fab.top { top: 12px; } .fab.bottom { bottom: 12px; }
.fab.left { left: 12px; } .fab.right { right: 12px; }
.dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--muted-2); }
.dot.on { background: var(--ok); box-shadow: 0 0 0 3px rgb(63 191 127 / 0.18); }
.dot.jank { background: var(--danger); box-shadow: 0 0 0 3px rgb(242 85 90 / 0.22); }
.fab .badge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
  background: rgb(242 85 90 / 0.16); color: var(--danger); font-size: 11px;
  font-variant-numeric: tabular-nums; display: inline-flex; align-items: center;
  justify-content: center; }
.fab .badge:empty { display: none; }

/* Panel */
.panel { position: fixed; z-index: 2147483647; display: flex; flex-direction: column;
  background: var(--bg); backdrop-filter: blur(12px); }
.panel.bottom { left: 0; right: 0; bottom: 0;
  box-shadow: 0 -1px 0 var(--ring-1), 0 -12px 32px rgb(0 0 0 / 0.35); }
.panel.right { top: 0; right: 0; bottom: 0;
  box-shadow: -1px 0 0 var(--ring-1), -12px 0 32px rgb(0 0 0 / 0.35); }
.grip { position: absolute; z-index: 1; }
.panel.bottom .grip { left: 0; right: 0; top: -4px; height: 8px; cursor: ns-resize; }
.panel.right .grip { top: 0; bottom: 0; left: -4px; width: 8px; cursor: ew-resize; }
.grip::after { content: ''; position: absolute; border-radius: 2px;
  background: var(--muted-2); opacity: 0; transition: opacity 120ms; }
.panel.bottom .grip::after { left: 50%; top: 2px; width: 36px; height: 4px; translate: -50% 0; }
.panel.right .grip::after { top: 50%; left: 2px; width: 4px; height: 36px; translate: 0 -50%; }
.grip:hover::after { opacity: 1; }

.bar { display: flex; align-items: center; gap: 6px; min-height: 48px; padding: 8px 10px;
  box-shadow: 0 1px 0 var(--ring-1); flex-wrap: wrap; }
.bar select { width: auto; max-width: 260px; }
.bar .btn:not(.primary):not(.ghost) { background: var(--muted); color: var(--fg); }
.bar .btn:not(.primary):not(.ghost):hover:not([disabled]) { background: var(--muted-2); }
.btn.rec { background: rgb(242 85 90 / 0.14) !important; color: var(--danger) !important; }
.tabs { display: inline-flex; gap: 2px; padding: 2px; margin-right: 6px;
  border-radius: var(--r-md); background: var(--muted); }
.tab { appearance: none; display: inline-flex; align-items: center; height: 28px;
  padding: 0 12px; border: 0; border-radius: var(--r-sm); background: none;
  color: var(--muted-fg); font-weight: 500; cursor: pointer;
  transition-property: background-color, color, box-shadow; transition-duration: 120ms; }
.tab:hover { color: var(--fg); }
.tab[aria-selected="true"] { background: #26262b; color: var(--fg);
  box-shadow: 0 0 0 1px var(--ring-1), 0 1px 2px rgb(0 0 0 / 0.4); }
.status { min-height: 28px; padding: 6px 14px; color: var(--muted-fg);
  font: 11px/16px var(--mono); white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; box-shadow: 0 1px 0 var(--ring-1); }
.status:empty { display: none; }

.body { flex: 1; min-height: 0; overflow: auto; padding: 12px 16px 20px;
  scrollbar-width: thin; scrollbar-color: var(--muted-2) transparent; }
.body[data-drop] { box-shadow: inset 0 0 0 2px var(--brand); }
.view > .bar { padding: 0 0 12px; min-height: 0; box-shadow: none; }
.timeline { display: block; width: 100%; cursor: crosshair; touch-action: none;
  border-radius: var(--r-md); }
.empty { color: var(--muted-fg); padding: 24px 0; text-align: center; margin: 0; }
h3 { margin: 20px 0 8px; font-size: 13px; font-weight: 600; color: var(--fg); }
section:first-of-type h3, .view > h3:first-child { margin-top: 4px; }
p { margin: 4px 0; }

/* Selected frame */
.frame { margin-top: 12px; }
.framehead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding-bottom: 10px; box-shadow: 0 1px 0 var(--ring-1); }
.framehead strong, .framehead b { font-size: 13px; }
.navs { margin-left: auto; display: flex; gap: 4px; }
.nav { appearance: none; display: inline-flex; align-items: center; justify-content: center;
  height: 26px; min-width: 26px; padding: 0 8px; border: 0; border-radius: var(--r-sm);
  background: var(--muted); color: var(--fg-2); cursor: pointer; font-weight: 500;
  transition-property: background-color, scale; transition-duration: 120ms; }
.nav:hover:not([disabled]) { background: var(--muted-2); color: var(--fg); }
.nav:active:not([disabled]) { scale: 0.96; }
.nav[disabled] { opacity: 0.35; cursor: default; }

.factors { display: flex; flex-direction: column; gap: 8px; }
.factor { padding: 10px 12px; border-radius: var(--r-md); background: var(--surface);
  box-shadow: 0 0 0 1px var(--ring-1); }
.fhead { display: flex; align-items: center; gap: 10px; }
.kind { display: inline-flex; align-items: center; height: 20px; padding: 0 6px;
  border-radius: var(--r-sm); background: var(--muted); color: var(--fg-2);
  font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.fms { min-width: 64px; text-align: right; font-weight: 600;
  font-variant-numeric: tabular-nums; }
.ftrack { flex: 1; height: 6px; border-radius: 3px; background: var(--muted); overflow: hidden; }
.fbar { display: block; height: 100%; border-radius: 3px; }
.ftext { margin-top: 6px; color: var(--fg-2); }
.src { margin-top: 4px; color: var(--muted-fg); font: 11px var(--mono);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chips { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.chip { appearance: none; display: inline-flex; align-items: center; height: 22px;
  max-width: 420px; padding: 0 7px; border: 0; border-radius: var(--r-sm);
  background: var(--brand-soft); color: #cfc7ff; cursor: pointer;
  font: 11px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: background-color 120ms; }
.chip:hover { background: rgb(139 124 246 / 0.28); }
.chip.dead { background: var(--muted); color: var(--muted-fg); cursor: default; }

.did { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.kv { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 12px;
  align-items: start; }
.kv .k { color: var(--muted-fg); }
.phases { display: inline-flex; width: 160px; height: 8px; border-radius: 4px;
  overflow: hidden; vertical-align: middle; margin-right: 8px; background: var(--muted); }
.events { display: flex; flex-direction: column; gap: 4px; }
.event { display: flex; gap: 8px; align-items: center; }
.event .chips, .event .chip { margin: 0; }
.ek { font: 11px var(--mono); color: var(--fg-2); }

/* Tables */
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 8px 12px 8px 0; text-align: left; vertical-align: top;
  box-shadow: inset 0 -1px 0 var(--ring-1); }
th { height: 36px; color: var(--muted-fg); font-size: 11px; font-weight: 500;
  vertical-align: middle; }
tbody tr { transition: background-color 120ms; }
tbody tr:hover { background: rgb(255 255 255 / 0.025); }
td.better { color: var(--ok); } td.worse { color: var(--danger); }

/* Number cards */
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px; margin: 4px 0 12px; }
.card { padding: 10px 12px; border-radius: var(--r-md); background: var(--surface);
  box-shadow: 0 0 0 1px var(--ring-1); }
.card .v { font-size: 18px; font-weight: 600; line-height: 1.2;
  font-variant-numeric: tabular-nums; }
.card .k { margin-top: 2px; color: var(--muted-fg); font-size: 11px; }
.card.bad { box-shadow: 0 0 0 1px rgb(242 85 90 / 0.35); }
.card.bad .v { color: var(--danger); }
.live { display: block; width: 100%; border-radius: var(--r-md); }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 10px;
  color: var(--muted-fg); font-size: 11px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 8px; height: 8px; border-radius: 2px; border: 1.5px solid transparent; }

/* Settings */
.settings { display: flex; flex-direction: column; max-width: 560px;
  border-radius: var(--r-md); box-shadow: 0 0 0 1px var(--ring-1); overflow: hidden; }
.setting { display: flex; align-items: center; justify-content: space-between;
  gap: 16px; min-height: 52px; padding: 8px 14px; background: var(--surface); }
.setting + .setting { box-shadow: 0 -1px 0 var(--ring-1); }
.setting:hover { background: rgb(255 255 255 / 0.04); }
.setting.off { opacity: 0.45; }
.setting .hint { margin-top: 2px; color: var(--muted-fg); font-size: 11px; }
.setting input[type="number"] { width: 72px; text-align: right; }
.setting select { width: auto; }
.note { margin: 8px 0; padding: 8px 12px; border-radius: var(--r-md);
  background: rgb(242 85 90 / 0.1); color: var(--danger); }

.shots { display: flex; gap: 12px; flex-wrap: wrap; }
.shots figure { margin: 0; }
.shots img { display: block; width: 240px; height: auto; border-radius: var(--r-sm);
  outline: 1px solid rgb(255 255 255 / 0.1); outline-offset: -1px; }
.shots figcaption { margin-top: 4px; color: var(--muted-fg); font-size: 11px; }

/* Outlining an element on the page */
.outline { position: fixed; z-index: 2147483646; pointer-events: none;
  border-radius: 4px; box-shadow: inset 0 0 0 1.5px var(--brand);
  background: rgb(139 124 246 / 0.08); }
.outline span { position: absolute; left: -1px; top: -21px; white-space: nowrap;
  padding: 2px 6px; border-radius: 4px; background: var(--brand); color: #fff;
  font: 500 11px/14px var(--mono); }
.outline.flash { animation: flash 1.2s ease-out; }
@keyframes flash { 0%, 40% { background: rgb(139 124 246 / 0.32); } }
@media (prefers-reduced-motion: reduce) {
  .fab, .nav, .chip, .tab, tbody tr { transition: none; }
  .outline.flash { animation: none; }
}
`
