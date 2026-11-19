import { assert, test } from 'orca/testing'
import { link } from './links'
import type { Dep } from './protocol'

const dep = (name: string, installed: string, suggestions: Dep['suggestions'], peers: Dep['peers'] = {}): Dep => ({
  name,
  section: 'devDependencies',
  current: `^${installed}`,
  latest: null,
  suggestions,
  status: suggestions.major ? 'major' : suggestions.minor ? 'minor' : suggestions.patch ? 'patch' : 'latest',
  updatable: true,
  installed,
  peers,
  vulns: {}
})

// Shapes taken from a real SvelteKit project.
const deps = [
  dep('storybook', '10.6.3', { patch: '10.6.7' }),
  dep('@storybook/addon-a11y', '10.6.3', { patch: '10.6.7' }, { '10.6.7': { storybook: '^10.6.7' } }),
  dep('@storybook/sveltekit', '10.6.3', { patch: '10.6.7' }, { '10.6.7': { storybook: '^10.6.7', svelte: '^5.0.0' } }),
  dep('@storybook/addon-svelte-csf', '5.1.5', { patch: '5.1.6' }, { '5.1.6': { storybook: '^10.0.0-0' } }),
  dep('svelte', '5.58.0', {}),
  dep('typescript', '6.0.3', { major: '7.0.2' }),
  dep('svelte-check', '4.7.7', { patch: '4.7.8' }, { '4.7.7': { typescript: '^5.0.0 || ^6.0.0' }, '4.7.8': { typescript: '^5.0.0 || ^6.0.0' } }),
  dep('@sveltejs/kit', '3.3.1', { minor: '3.4.0' }, { '3.3.1': { typescript: '^6.0.0' }, '3.4.0': { typescript: '^6.0.0' } }),
  dep('@sveltejs/adapter-vercel', '7.0.4', { patch: '7.0.5' }, { '7.0.5': { '@sveltejs/kit': '^3.0.0-next.0' } }),
  dep('vite-plugin', '1.0.0', { major: '2.0.0' }, { '2.0.0': { svelte: '^6.0.0' } })
]

test('groups packages that need each other, around the one they ask for', () => {
  const items = link(deps, 'all')
  const sb = items.find((i) => i.hub.dep.name === 'storybook')!
  assert.deepEqual(sb.members.map((m) => m.dep.name), ['storybook', '@storybook/addon-a11y', '@storybook/sveltekit'])
  assert.deepEqual(sb.needs, [])
  // csf accepts the storybook already installed, so it stays its own row; so does adapter-vercel.
  assert.ok(items.some((i) => i.hub.dep.name === '@storybook/addon-svelte-csf' && i.members.length === 1))
  assert.ok(items.some((i) => i.hub.dep.name === '@sveltejs/adapter-vercel' && i.members.length === 1))
})

test('flags what an update breaks and what it needs that nothing provides', () => {
  const items = link(deps, 'all')
  const ts = items.find((i) => i.hub.dep.name === 'typescript')!
  assert.deepEqual(ts.breaks, [
    { name: 'svelte-check', peer: 'typescript', range: '^5.0.0 || ^6.0.0' },
    { name: '@sveltejs/kit', peer: 'typescript', range: '^6.0.0' }
  ])
  const plugin = items.find((i) => i.hub.dep.name === 'vite-plugin')!
  assert.deepEqual(plugin.needs, [{ name: 'vite-plugin', peer: 'svelte', range: '^6.0.0' }])
})

test('a filter that leaves a peer behind turns the link into a need', () => {
  const minorOnly = [dep('lib', '1.0.0', { minor: '1.1.0' }, { '1.1.0': { core: '^2.0.0' } }), dep('core', '1.0.0', { major: '2.0.0' })]
  assert.equal(link(minorOnly, 'all').length, 1)
  const [lib] = link(minorOnly, 'minor')
  assert.deepEqual(lib.needs, [{ name: 'lib', peer: 'core', range: '^2.0.0' }])
})

test('by name joins any family moving to one version, only when asked', () => {
  const v = (name: string, from: string, to: string) => dep(name, from, { minor: to })
  const deps = [
    v('@pandacss/dev', '2.3.0', '2.6.0'),
    v('@pandacss/preset-base', '2.3.0', '2.6.0'),
    v('@pandacss/preset-panda', '2.3.0', '2.6.0'),
    v('@storybook/addon-docs', '10.6.3', '10.7.0'),
    v('storybook', '10.6.3', '10.7.0'),
    v('@sveltejs/kit', '3.3.1', '3.4.0'),
    v('@sveltejs/adapter-vercel', '7.0.4', '7.1.0'),
    v('@types/node', '24.1.0', '24.2.0'),
    v('@types/react', '24.1.0', '24.2.0')
  ]
  assert.equal(link(deps, 'all').length, 9)
  const items = link(deps, 'all', true)
  const of = (n: string) => items.find((i) => i.members.some((m) => m.dep.name === n))!
  assert.equal(of('@pandacss/dev').members.length, 3)
  assert.equal(of('@pandacss/dev').family, 'pandacss')
  assert.deepEqual(of('storybook').members.map((m) => m.dep.name).sort(), ['@storybook/addon-docs', 'storybook'])
  assert.equal(of('storybook').family, 'storybook')
  assert.equal(of('@sveltejs/kit').members.length, 1)
  assert.equal(of('@types/node').members.length, 1)
  assert.equal(items.length, 6)
})

test('groups by the range package.json declares, even when node_modules is ahead', () => {
  // package.json says ^10.6.3 but 10.6.7 is installed: a fresh install could still pick 10.6.3.
  const ahead = [
    { ...dep('storybook', '10.6.7', { patch: '10.6.7' }), current: '^10.6.3' },
    { ...dep('addon', '10.6.7', { patch: '10.6.7' }, { '10.6.7': { storybook: '^10.6.7' } }), current: '^10.6.3' }
  ]
  assert.equal(link(ahead, 'all').length, 1)
})

test('does not blame an update for a peer that was already unmet', () => {
  const unmet = [
    dep('host', '1.7.0', {}, { '1.7.0': { tool: '5.1.0' } }),
    dep('tool', '5.1.0', { patch: '5.1.1' }),
    dep('lib', '1.0.0', { patch: '1.0.1' }, { '1.0.0': { host: '^0.2.0' }, '1.0.1': { host: '^0.2.0' } })
  ]
  const items = link(unmet, 'all')
  assert.deepEqual(items.find((i) => i.hub.dep.name === 'lib')!.needs, [])
  // tool 5.1.1 does leave the exact range host pins today: that one is real.
  assert.deepEqual(items.find((i) => i.hub.dep.name === 'tool')!.breaks, [{ name: 'host', peer: 'tool', range: '5.1.0' }])
})
