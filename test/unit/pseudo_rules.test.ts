// Which elements can have a ::before / ::after / ::marker
// (src/dom/pseudo_rules.ts): host selectors and the rule scan.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostSelector, nestSelector, scanRules } from '../../src/dom/pseudo_rules'

test('the host of a pseudo-element selector', () => {
  assert.deepEqual(hostSelector('.a:hover::before'), {
    name: '::before',
    host: '.a:hover'
  })
  assert.deepEqual(hostSelector('li:after'), { name: '::after', host: 'li' })
  assert.deepEqual(hostSelector('::marker'), { name: '::marker', host: '*' })
  assert.deepEqual(hostSelector('ul > ::before'), {
    name: '::before',
    host: 'ul > *'
  })
  assert.deepEqual(hostSelector('.a::before:hover'), {
    name: '::before',
    host: '.a'
  })
  assert.equal(hostSelector('.a .b'), null)
  assert.equal(hostSelector('.a::before .b'), null)
})

const rule = (selectorText: string, content: string, position = ''): CSSRule =>
  ({
    selectorText,
    style: {
      getPropertyValue: (p: string) =>
        p === 'content' ? content : p === 'position' ? position : ''
    }
  }) as unknown as CSSRule

test('only rules giving a pseudo-element content count', () => {
  const found = scanRules([
    rule('*, ::before, ::after', ''),
    rule('.tag::before, .x', '"#"'),
    rule('.q:after', 'close-quote'),
    rule('.plain', '"x"')
  ])
  // `q` from the browser's own sheet.
  assert.deepEqual(found, {
    '::before': ['q', '.tag'],
    '::after': ['q', '.q'],
    '::marker': [],
    fixed: []
  })
})

test('grouping rules are walked; what it cannot model gives up', () => {
  const media = { cssRules: [rule('.m::after', '""')] } as unknown as CSSRule
  assert.deepEqual(scanRules([media])?.['::after'], ['q', '.m'])
  // A pseudo followed by more than pseudo-classes.
  assert.equal(scanRules([rule('.a::before .b', '""')]), null)
  // A rule nested under a pseudo-element.
  const under = {
    ...rule('.p::before', '""'),
    cssRules: [rule('& .x', '')]
  } as unknown as CSSRule
  assert.equal(scanRules([under]), null)
})

test('nested rules resolve against their parent', () => {
  assert.equal(nestSelector('& [data-theme="dark"]', ':root'), ':is(:root) [data-theme="dark"]')
  assert.equal(nestSelector('.b, &:hover', '.a, .c'), ':is(.a, .c) .b, :is(.a, .c):hover')
  const declarations = {
    selectorText: undefined,
    style: rule('', '', 'fixed').style
  } as unknown as CSSRule
  const media = { cssRules: [rule('& .m', '', 'fixed')] } as unknown as CSSRule
  const nested = {
    ...rule('.n', ''),
    cssRules: [rule('&::before', '""'), rule('.k', '', 'fixed'), media, declarations]
  } as unknown as CSSRule
  const found = scanRules([nested, { ...rule(':root', ''), cssRules: [rule('& [data-theme]', '')] } as unknown as CSSRule])
  assert.deepEqual(found?.['::before'], ['q', ':is(.n)'])
  assert.deepEqual(found?.fixed, [':is(.n) .k', ':is(.n) .m', '.n'])
})

test('rules making an element fixed are collected, pseudo hosts included', () => {
  const found = scanRules([
    rule('.nav, .toast::after', '', 'fixed'),
    rule('.sticky', '', 'sticky')
  ])
  assert.deepEqual(found?.fixed, ['.nav', '.toast'])
})
