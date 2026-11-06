// The look shared by the library's tools (the editor, the devtools, the
// recording viewer; docs/EDITOR.md): a dark, neutral palette with one
// accent, 28 px controls on a 4 px grid, 6 / 8 / 12 px radii, and depth
// from layered shadows with a 1 px ring rather than hard borders. Each
// tool puts UI_TOKENS on its shadow root's top element and UI_BASE first
// in its stylesheet; tool-specific rules follow.

/** Declarations for a tool's root element: colours, radii, shadows,
 * type. */
export const UI_TOKENS = `
  --bg: rgb(17 17 19 / 0.97);
  --surface: rgb(255 255 255 / 0.025);
  --muted: rgb(255 255 255 / 0.06);
  --muted-2: rgb(255 255 255 / 0.1);
  --hover: rgb(255 255 255 / 0.06);
  --ring-1: rgb(255 255 255 / 0.08);
  --input: rgb(255 255 255 / 0.1);
  --fg: #ededef;
  --fg-2: #c9c9cf;
  --muted-fg: #8b8b94;
  --primary: #ededef;
  --primary-fg: #121214;
  --brand: #8b7cf6;
  --brand-soft: rgb(139 124 246 / 0.16);
  --focus: rgb(139 124 246 / 0.55);
  --ok: #3fbf7f;
  --warn: #f2b84b;
  --danger: #f2555a;
  --r-sm: 6px;
  --r-md: 8px;
  --r-lg: 12px;
  --shadow: 0 0 0 1px var(--ring-1), 0 2px 6px rgb(0 0 0 / 0.25),
    0 12px 32px rgb(0 0 0 / 0.35);
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font: 400 12px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont,
    'Inter', 'Segoe UI', system-ui, sans-serif;
  color: var(--fg);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
`

/** Buttons, fields, sliders, swatches, switches, kbd and focus rings. */
export const UI_BASE = `
[hidden] { display: none !important; }
button, select, input { font: inherit; color: inherit; margin: 0; }
.i { flex: none; display: block; }
.muted { color: var(--muted-fg); }
.small { font-size: 11px; }
.spacer { flex: 1; }
:focus { outline: none; }
:focus-visible { box-shadow: 0 0 0 2px var(--focus); }

/* Buttons */
.btn { appearance: none; display: inline-flex; align-items: center;
  justify-content: center; gap: 6px; height: 28px; padding: 0 10px;
  border: 0; border-radius: var(--r-sm); background: none; cursor: pointer;
  font-weight: 500; white-space: nowrap; color: var(--fg-2);
  transition-property: background-color, color, box-shadow, scale;
  transition-duration: 120ms; transition-timing-function: ease-out; }
.btn:active:not([disabled]) { scale: 0.96; }
.btn[disabled] { opacity: 0.4; cursor: default; }
.btn.primary { background: var(--primary); color: var(--primary-fg); }
.btn.primary:hover { background: #fff; }
.btn.secondary { background: var(--muted); color: var(--fg); }
.btn.secondary:hover { background: var(--muted-2); }
.btn.ghost:hover:not([disabled]) { background: var(--hover); color: var(--fg); }
.btn.danger { color: var(--danger); }
.btn.danger:hover { background: rgb(242 85 90 / 0.12); color: var(--danger); }
.btn.sm { height: 26px; padding: 0 8px; }
.btn.icon { width: 28px; padding: 0; }
.btn.icon.sm { width: 26px; height: 26px; }
.btn.icon.xs { width: 20px; height: 20px; border-radius: 4px; }
kbd { display: inline-flex; align-items: center; height: 18px; padding: 0 5px;
  border-radius: 4px; background: var(--muted); box-shadow: 0 0 0 1px var(--ring-1);
  font: 500 10.5px var(--mono); color: var(--muted-fg); }

/* Fields */
.input, .select, select, input[type="number"], input[type="text"] { appearance: none; height: 28px; width: 100%; min-width: 0;
  padding: 0 8px; border-radius: var(--r-sm); background: rgb(0 0 0 / 0.2);
  border: 0; box-shadow: inset 0 0 0 1px var(--input); color: var(--fg);
  font-variant-numeric: tabular-nums;
  transition: box-shadow 120ms ease-out; }
.input::placeholder { color: rgb(139 139 148 / 0.7); }
.input:hover, .select:hover, select:hover, input[type="number"]:hover { box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.16); }
.input:focus-visible, .select:focus-visible, select:focus-visible,
input[type="number"]:focus-visible, input[type="text"]:focus-visible {
  box-shadow: inset 0 0 0 1px var(--brand), 0 0 0 3px var(--brand-soft); }
.input.mono { font: 11.5px var(--mono); }
.input.hex { width: 84px; flex: none; }
.input.bad { box-shadow: inset 0 0 0 1px var(--danger); }
.input.num { width: 60px; flex: none; text-align: right; padding: 0 6px; }
input[type="number"]::-webkit-inner-spin-button { display: none; }
.select, select { padding-right: 26px; cursor: pointer; background-repeat: no-repeat;
  background-position: right 8px center; background-size: 12px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238b8b94' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E"); }
.select option, select option { background: #18181b; }
.ig { position: relative; display: inline-flex; flex: 1; min-width: 0; }
.ig .input { width: 100%; }
.ig .pre, .ig .post { position: absolute; top: 0; bottom: 0; display: flex;
  align-items: center; color: var(--muted-fg); font-size: 11px;
  pointer-events: none; }
.ig .pre { left: 8px; }
.ig .pre + .input { padding-left: 20px; }
.ig .post { right: 8px; }
.ig .input.num:has(+ .post) { padding-right: 18px; }
.ig:has(.post) { flex: none; }

.slider { appearance: none; flex: 1; min-width: 40px; height: 16px; margin: 0;
  background: transparent; cursor: pointer; --p: 0%; }
.slider::-webkit-slider-runnable-track { height: 4px; border-radius: 2px;
  background: linear-gradient(to right, var(--brand) var(--p), var(--muted-2) var(--p)); }
.slider::-moz-range-track { height: 4px; border-radius: 2px; background: var(--muted-2); }
.slider::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--brand); }
.slider::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px;
  margin-top: -5px; border-radius: 50%; background: #fff;
  box-shadow: 0 0 0 1px rgb(0 0 0 / 0.25), 0 1px 3px rgb(0 0 0 / 0.4);
  transition: box-shadow 120ms ease-out; }
.slider::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgb(0 0 0 / 0.4); }
.slider:focus-visible { box-shadow: none; }
.slider:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 1px rgb(0 0 0 / 0.25), 0 0 0 4px var(--brand-soft); }

.swatch { appearance: none; flex: none; width: 28px; height: 28px; padding: 3px;
  border: 0; border-radius: var(--r-sm); background: rgb(0 0 0 / 0.2);
  box-shadow: inset 0 0 0 1px var(--input); cursor: pointer; }
.swatch::-webkit-color-swatch-wrapper { padding: 0; }
.swatch::-webkit-color-swatch { border: 0; border-radius: 3px;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.1); }
.swatch::-moz-color-swatch { border: 0; border-radius: 3px; }

.switch, input[type="checkbox"] { appearance: none; flex: none; position: relative; width: 28px; height: 16px;
  margin: 0; border-radius: 8px; background: var(--muted-2); cursor: pointer;
  transition: background-color 150ms ease-out; }
.switch::after, input[type="checkbox"]::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px;
  height: 12px; border-radius: 50%; background: #fff;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.35); transition: translate 150ms ease-out; }
.switch:checked, input[type="checkbox"]:checked { background: var(--brand); }
.switch:checked::after, input[type="checkbox"]:checked::after { translate: 12px 0; }


@media (prefers-reduced-motion: reduce) {
  .btn, .tab, .switch, .switch::after, input[type="checkbox"],
  input[type="checkbox"]::after, .input, .select, select,
  .slider::-webkit-slider-thumb { transition: none; }
  .btn:active:not([disabled]) { scale: none; }
}
`
