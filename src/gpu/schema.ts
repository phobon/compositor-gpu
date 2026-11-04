import tgpu from 'typegpu'
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
