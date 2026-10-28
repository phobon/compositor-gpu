// The devtools panel's styles (in its shadow root).
export const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  --bg: rgba(17,17,20,0.96); --line: rgba(255,255,255,0.12);
  --fg: #e5e7eb; --dim: #9ca3af; --accent: #38bdf8; --bad: #f87171;
  font: 12px/1.35 ui-sans-serif, system-ui, -apple-system, sans-serif;
  color: var(--fg);
}
button { font: inherit; color: inherit; }
button:focus-visible, select:focus-visible, input:focus-visible,
canvas:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 1px;
}
.fab {
  position: fixed; z-index: 2147483646; display: flex; align-items: center;
  gap: 6px; height: 28px; padding: 0 10px; border-radius: 14px;
  border: 1px solid var(--line); background: var(--bg); cursor: pointer;
  font-weight: 600; letter-spacing: 0.04em; backdrop-filter: blur(8px);
}
.fab:hover { background: rgba(38,38,44,0.96); }
.fab.top { top: 12px; } .fab.bottom { bottom: 12px; }
.fab.left { left: 12px; } .fab.right { right: 12px; }
.fab[hidden] { display: none; }
.dot { width: 7px; height: 7px; border-radius: 4px; background: #4b5563; }
.dot.on { background: #34d399; }
.dot.jank { background: var(--bad); box-shadow: 0 0 0 3px rgba(248,113,113,0.25); }
.badge { color: var(--bad); font-variant-numeric: tabular-nums; }

.panel {
  position: fixed; z-index: 2147483647; display: flex; flex-direction: column;
  background: var(--bg); border: 1px solid var(--line);
  box-shadow: 0 -8px 32px rgba(0,0,0,0.35); backdrop-filter: blur(10px);
}
.panel[hidden] { display: none; }
.panel.bottom { left: 0; right: 0; bottom: 0; border-width: 1px 0 0; }
.panel.right { top: 0; right: 0; bottom: 0; border-width: 0 0 0 1px; }
.grip { position: absolute; z-index: 1; }
.panel.bottom .grip { left: 0; right: 0; top: -4px; height: 8px; cursor: ns-resize; }
.panel.right .grip { top: 0; bottom: 0; left: -4px; width: 8px; cursor: ew-resize; }

.bar {
  display: flex; align-items: center; gap: 4px; padding: 4px 6px;
  border-bottom: 1px solid var(--line); flex-wrap: wrap;
}
.tabs { display: flex; gap: 2px; margin-right: 6px; }
.tab, .btn, select {
  appearance: none; border: 1px solid transparent; background: none;
  height: 24px; padding: 0 8px; border-radius: 6px; cursor: pointer;
  white-space: nowrap;
}
.tab { color: var(--dim); }
.tab[aria-selected="true"] { color: var(--fg); background: rgba(255,255,255,0.08); }
.btn { border-color: var(--line); }
.btn:hover, .tab:hover { background: rgba(255,255,255,0.06); }
.btn.primary { border-color: rgba(56,189,248,0.5); color: #bae6fd; }
.btn.rec { color: var(--bad); border-color: rgba(248,113,113,0.5); }
.btn[disabled] { opacity: 0.4; cursor: default; }
select { border-color: var(--line); max-width: 260px; background: #18181b; color: var(--fg); }
.spacer { flex: 1; }
.status { color: var(--dim); padding: 0 6px; min-height: 16px; font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.body { flex: 1; overflow: auto; padding: 8px 10px 12px; min-height: 0; }
.body[data-drop] { outline: 2px dashed var(--accent); outline-offset: -6px; }
.view[hidden] { display: none; }
.timeline { display: block; width: 100%; cursor: crosshair; touch-action: none; }
.empty { color: var(--dim); padding: 16px 0; }
.dim { color: var(--dim); }
h3 { font-size: 12px; margin: 14px 0 6px; color: var(--fg); }
section:first-of-type h3 { margin-top: 8px; }

.framehead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  margin-top: 8px; }
.navs { margin-left: auto; display: flex; gap: 2px; }
.nav { appearance: none; border: 1px solid var(--line); background: none;
  border-radius: 6px; height: 22px; padding: 0 7px; cursor: pointer; }
.nav[disabled] { opacity: 0.35; cursor: default; }

.factors { display: flex; flex-direction: column; gap: 6px; }
.factor { padding: 6px 8px; border-radius: 6px; background: rgba(255,255,255,0.04); }
.fhead { display: flex; align-items: center; gap: 8px; }
.kind { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,0.08); }
.fms { font-variant-numeric: tabular-nums; min-width: 64px; text-align: right; }
.ftrack { flex: 1; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.05); }
.fbar { display: block; height: 100%; border-radius: 3px; }
.ftext { margin-top: 3px; }
.src { margin-top: 2px; color: var(--dim); font-size: 11px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.chips { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.chip { appearance: none; border: 1px solid rgba(56,189,248,0.35);
  background: rgba(56,189,248,0.08); color: #bae6fd; border-radius: 4px;
  padding: 0 5px; height: 20px; cursor: pointer; max-width: 420px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 11px/18px ui-monospace, SFMono-Regular, Menlo, monospace; }
.chip.dead { border-color: var(--line); background: none; color: var(--dim); cursor: default; }

.did { display: flex; flex-direction: column; gap: 5px; }
.kv { display: grid; grid-template-columns: 120px 1fr; gap: 8px; align-items: start; }
.kv .k { color: var(--dim); }
.phases { display: inline-flex; width: 160px; height: 8px; border-radius: 4px;
  overflow: hidden; vertical-align: middle; margin-right: 8px;
  background: rgba(255,255,255,0.05); }
.events { display: flex; flex-direction: column; gap: 3px; }
.event { display: flex; gap: 6px; align-items: center; }
.event .chips, .event .chip { margin: 0; }
.ek { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }

table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 3px 8px 3px 0; border-bottom: 1px solid rgba(255,255,255,0.06);
  vertical-align: top; }
th { color: var(--dim); font-weight: 500; }

.cards { display: flex; gap: 8px; flex-wrap: wrap; margin: 4px 0 8px; }
.card { padding: 6px 10px; border-radius: 8px; background: rgba(255,255,255,0.05); min-width: 120px; }
.card .v { font-size: 15px; font-variant-numeric: tabular-nums; }
.card .k { color: var(--dim); font-size: 11px; }
.card.bad .v { color: var(--bad); }
.live { display: block; width: 100%; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--dim);
  font-size: 11px; margin-top: 6px; }
.legend span { display: inline-flex; align-items: center; gap: 4px; }
.legend i { width: 8px; height: 8px; border-radius: 2px; border: 1.5px solid transparent; }

.settings { display: flex; flex-direction: column; gap: 2px; max-width: 520px; }
.setting { display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 6px 8px; border-radius: 6px; }
.setting:hover { background: rgba(255,255,255,0.04); }
.setting.off { opacity: 0.45; }
.setting .hint { color: var(--dim); font-size: 11px; }
input[type="checkbox"] { appearance: none; margin: 0; width: 28px; height: 16px;
  flex: none; border-radius: 8px; background: #374151; position: relative;
  cursor: pointer; transition: background 120ms; }
input[type="checkbox"]::after { content: ''; position: absolute; top: 2px; left: 2px;
  width: 12px; height: 12px; border-radius: 6px; background: #e5e7eb;
  transition: transform 120ms; }
input[type="checkbox"]:checked { background: #0ea5e9; }
input[type="checkbox"]:checked::after { transform: translateX(12px); }
input[type="number"] { width: 56px; height: 22px; background: #18181b;
  color: inherit; border: 1px solid var(--line); border-radius: 5px; padding: 0 4px; font: inherit; }
.note { color: var(--bad); padding: 6px 8px; }

td.better { color: #34d399; } td.worse { color: var(--bad); }
.shots { display: flex; gap: 10px; flex-wrap: wrap; }
.shots figure { margin: 0; }
.shots img { display: block; width: 240px; height: auto; border-radius: 4px;
  border: 1px solid var(--line); image-rendering: auto; }
.shots figcaption { color: var(--dim); font-size: 11px; margin-top: 2px; }
.outline { position: fixed; z-index: 2147483645; pointer-events: none;
  border: 2px solid var(--accent); background: rgba(56,189,248,0.12);
  border-radius: 2px; }
.outline[hidden] { display: none; }
.outline span { position: absolute; left: -2px; top: -20px; white-space: nowrap;
  background: #0c4a6e; color: #e0f2fe; padding: 1px 5px; border-radius: 3px;
  font: 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; }
.outline.flash { animation: flash 1.2s ease-out; }
@keyframes flash { 0%, 40% { background: rgba(56,189,248,0.4); } }
@media (prefers-reduced-motion: reduce) {
  input[type="checkbox"], input[type="checkbox"]::after { transition: none; }
  .outline.flash { animation: none; }
}
`
