import tgpu, { type TgpuBindGroupLayout, type TgpuRoot } from 'typegpu'
import * as d from 'typegpu/data'
import type { Externals } from './frame'
import { bindingExternals } from './frame'

// Packing a `d.struct` schema's elements from JS (docs/TYPEGPU.md): the
// schema is the one definition of the WGSL struct, the stride and the
// offsets the packing code writes.

/** Floats one element of `schema` takes in an array (its stride). */
export const floatsOf = (schema: d.AnyWgslData): number => d.sizeOf(schema) / 4

/** Float offset of each field of `schema` within one element. */
export function floatOffsets<T extends Record<string, d.AnyWgslData>>(
  schema: d.WgslStruct<T>
): { readonly [K in keyof T]: number } {
  return Object.fromEntries(
    Object.keys(schema.propTypes).map((k) => [
      k,
      d.memoryLayoutOf(schema, (s) => (s as Record<string, unknown>)[k])
        .offset / 4
    ])
  ) as { readonly [K in keyof T]: number }
}

/** A pass's externals for resolveShader: its named items, plus `layout`'s
 * bindings under their own names. */
export function passExternals(
  layout: Parameters<typeof bindingExternals>[0],
  items: Externals
): Externals {
  return Object.defineProperties(
    { ...items },
    Object.getOwnPropertyDescriptors(bindingExternals(layout))
  )
}

/** WGSL declaring `schemas` (structs, in dependency order), for modules
 * still assembled as text. */
export const structWgsl = (...schemas: d.AnyWgslData[]): string =>
  tgpu.resolve(schemas)

/** `layout`'s GPU layout, made by TypeGPU from the schema (memoized on
 * the root, so passes sharing a layout share the GPUBindGroupLayout). */
export const gpuLayout = (
  root: TgpuRoot,
  layout: TgpuBindGroupLayout
): GPUBindGroupLayout => root.unwrap(layout)

/** Bind group entries for `layout`, by binding name: each resource lands
 * at its entry's binding number. */
export function bindEntries<L extends TgpuBindGroupLayout>(
  layout: L,
  resources: { readonly [K in keyof L['entries']]: GPUBindingResource }
): GPUBindGroupEntry[] {
  const out: GPUBindGroupEntry[] = []
  let binding = 0
  for (const [key, entry] of Object.entries(layout.entries)) {
    if (entry !== null) {
      out.push({
        binding,
        resource: resources[key as keyof L['entries']]
      })
    }
    binding++
  }
  return out
}
