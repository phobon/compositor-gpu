// Which elements can have a ::before / ::after / ::marker
// (src/dom/pseudo_rules.ts): host selectors and the rule scan.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostSelector, scanRules } from '../../src/dom/pseudo_rules'

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
  // Nested style rules.
  const nested = {
    ...rule('.n', ''),
    cssRules: [rule('&::before', '""')]
  } as unknown as CSSRule
  assert.equal(scanRules([nested]), null)
})

test('rules making an element fixed are collected, pseudo hosts included', () => {
  const found = scanRules([
    rule('.nav, .toast::after', '', 'fixed'),
    rule('.sticky', '', 'sticky')
  ])
  assert.deepEqual(found?.fixed, ['.nav', '.toast'])
})
