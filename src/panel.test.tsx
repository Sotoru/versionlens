import { assert, mockHost, mount, test } from 'orca/testing'
import type { Dep, Update } from './protocol'
import * as panel from './panel'

const react: Dep = {
  name: 'react',
  section: 'dependencies',
  current: '^18.2.0',
  latest: '19.0.0',
  suggestions: { patch: '18.2.1', minor: '18.3.1', major: '19.0.0' },
  status: 'major',
  updatable: true,
  installed: '18.2.0',
  peers: {},
  vulns: {}
}
const zod: Dep = { ...react, name: 'zod', current: '^3.22.0', latest: '3.22.0', suggestions: {}, status: 'latest' }
const vite: Dep = { ...react, name: 'vite', section: 'devDependencies', current: '^5.0.0', suggestions: { patch: '5.0.1' }, status: 'patch' }

function host(sent: Update[][] = [], asked: unknown[] = []) {
  return mockHost({
    requests: {
      'deps.check': { path: '/repo/app', deps: [react, zod, vite] },
      'deps.update': ({ updates }) => (sent.push(updates), { path: '/repo/app', deps: [zod] }),
      'deps.openChangelog': (input) => (asked.push(input), { path: 'node_modules/.cache/versionlens/react.md' })
    }
  })
}

const card = (view: Awaited<ReturnType<typeof mount>>, name: string) =>
  view.find({ type: 'Box', text: new RegExp(`^${name}\\b`) })

test('filters by kind; All offers the biggest update', async () => {
  const view = await mount(panel, { host: host() })
  for (const label of ['All (2)', 'Major (1)', 'Minor (1)', 'Patch (2)']) assert.ok(view.find({ type: 'Tab', label }), label)
  assert.match(card(view, 'react')?.text ?? '', /19\.0\.0\s+·\s+major/)
  assert.ok(card(view, 'vite'))

  await view.select({ label: 'Filter' }, 'minor')
  assert.match(card(view, 'react')?.text ?? '', /18\.3\.1\s+·\s+minor/)
  assert.equal(card(view, 'vite'), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('search narrows the list and the counts', async () => {
  const view = await mount(panel, { host: host() })
  await view.type({ label: 'Search packages' }, 'vit')
  assert.ok(view.find({ type: 'Tab', label: 'All (1)' }))
  assert.equal(card(view, 'react'), null)
  await view.unmount()
})

test('row buttons update the package and open its changelog', async () => {
  const sent: Update[][] = []
  const asked: unknown[] = []
  const view = await mount(panel, { host: host(sent, asked) })
  await view.select({ label: 'Filter' }, 'minor')
  await view.press({ label: 'Changelog for react 18.2.0 → 18.3.1' })
  assert.deepEqual(asked, [{ name: 'react', from: '18.2.0', to: '18.3.1' }])
  await view.press({ label: 'Update react to 18.3.1' })
  assert.deepEqual(sent, [[{ section: 'dependencies', name: 'react', version: '18.3.1' }]])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('there is no update-all button: updates go row by row', async () => {
  const view = await mount(panel, { host: host() })
  assert.equal(view.find({ type: 'Button', text: /^Update / }), null)
  assert.ok(view.find({ text: '2 updates' }))
  await view.unmount()
})

test('linked packages become one row that updates them together', async () => {
  const sb: Dep = { ...react, name: 'storybook', section: 'devDependencies', current: '^10.6.3', installed: '10.6.3', suggestions: { patch: '10.6.7' }, status: 'patch', peers: {} }
  const addon: Dep = { ...sb, name: '@storybook/addon-a11y', peers: { '10.6.7': { storybook: '^10.6.7' } } }
  const ts: Dep = { ...sb, name: 'typescript', current: '^6.0.3', installed: '6.0.3', suggestions: { major: '7.0.2' }, status: 'major' }
  const check: Dep = { ...sb, name: 'svelte-check', current: '^4.7.7', installed: '4.7.7', suggestions: {}, status: 'latest', peers: { '4.7.7': { typescript: '^5.0.0 || ^6.0.0' } } }
  const sent: Update[][] = []
  const view = await mount(panel, {
    host: mockHost({
      requests: {
        'deps.check': { path: '/repo/app', deps: [addon, sb, ts, check] },
        'deps.update': ({ updates }) => (sent.push(updates), { path: '/repo/app', deps: [] })
      }
    })
  })
  assert.ok(view.find({ text: 'Storybook' }))
  const warn = 'Breaks svelte-check (wants ^5.0.0 || ^6.0.0). Press for details.'
  const icon = view.find({ type: 'IconButton', label: warn })
  assert.equal(icon?.props.icon, 'warning')
  assert.equal(icon?.props.variant, 'ghost')
  assert.equal(icon?.props.tone, undefined)
  assert.equal(icon?.props.tooltip, warn)
  assert.equal(view.find({ text: '⚠ Breaks svelte-check (wants ^5.0.0 || ^6.0.0)' }), null)
  await view.press({ label: warn })
  assert.ok(view.find({ text: '⚠ Breaks svelte-check (wants ^5.0.0 || ^6.0.0)' }))
  assert.equal(view.find({ text: 'storybook' }), null)
  await view.press({ label: 'Show the 2 Storybook packages' })
  assert.ok(view.find({ text: 'storybook' }))
  assert.ok(view.find({ label: 'Update @storybook/addon-a11y to 10.6.7' }))
  await view.press({ label: 'Update all 2 Storybook packages' })
  assert.deepEqual(sent[0].map((u) => u.name).sort(), ['@storybook/addon-a11y', 'storybook'])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('families group by name on their own, with no options to set', async () => {
  const panda = (name: string): Dep => ({ ...react, name, section: 'devDependencies', current: '^2.3.0', installed: '2.3.0', suggestions: { minor: '2.6.0' }, status: 'minor', peers: {} })
  const sent: Update[][] = []
  const view = await mount(panel, {
    host: mockHost({
      requests: {
        'deps.check': { path: '/repo/app', deps: [panda('@pandacss/dev'), panda('@pandacss/preset-base')] },
        'deps.update': ({ updates }) => (sent.push(updates), { path: '/repo/app', deps: [] })
      }
    })
  })
  assert.equal(view.find({ label: 'Options' }), null)
  assert.ok(view.find({ text: 'Pandacss' }))
  await view.press({ label: 'Update all 2 Pandacss packages' })
  assert.equal(sent[0].length, 2)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('marks known vulnerabilities, what an update fixes, and stays under Orca label limits', async () => {
  const vuln = (n: number) => ({ id: `CVE-2026-${n}`, summary: 'A long advisory title about prototype pollution through _.unset, _.omit and _.pullAt', severity: n === 1 ? 'high' : 'moderate', url: 'https://osv.dev/x' })
  const html: Dep = { ...react, name: 'sanitize-html', installed: '2.7.0', current: '^2.7.0', suggestions: { patch: '2.7.3' }, status: 'patch', vulns: { '2.7.0': [vuln(1)] } }
  const lodash: Dep = { ...react, name: 'lodash', installed: '4.17.15', current: '4.17.15', suggestions: { patch: '4.17.23' }, status: 'patch', vulns: { '4.17.23': Array.from({ length: 10 }, (_, i) => vuln(i + 1)) } }
  const stuck: Dep = { ...react, name: 'old-lib', installed: '1.0.0', current: '^1.0.0', suggestions: {}, status: 'latest', vulns: { '1.0.0': [vuln(1)] } }
  const view = await mount(panel, { host: mockHost({ requests: { 'deps.check': { path: '/repo/app', deps: [html, lodash, stuck] } } }) })
  assert.ok(view.find({ text: 'fixes 1 vulnerability' }))
  assert.ok(view.find({ text: '10 vulnerabilities' }))
  const bugs = view.findAll({ type: 'IconButton' }).filter((b) => b.props.icon === 'bug')
  assert.equal(bugs.length, 3)
  for (const b of bugs) assert.ok(new TextEncoder().encode(String(b.label)).length < 1024, String(b.label))
  const many = bugs.find((b) => /^10 known/.test(String(b.label)))!
  assert.match(String(many.label), /^10 known vulnerabilities \(up to high\): CVE-2026-1, CVE-2026-2 \+8 more/)
  await view.press({ label: String(many.label) })
  assert.equal(view.findAll({ text: /^⚠ / }).length, 10)
  assert.ok(bugs.some((b) => /old-lib 1\.0\.0, no fix released/.test(String(b.label))))
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('a range it cannot rewrite explains itself on press instead of a silent disabled button', async () => {
  const beta: Dep = { ...react, name: 'design-tokens', current: '^12.4.0-beta.3', updatable: false, suggestions: { major: '13.0.0' } }
  const sent: Update[][] = []
  const view = await mount(panel, {
    host: mockHost({ requests: { 'deps.check': { path: '/a/b/c', deps: [beta] }, 'deps.update': ({ updates }) => (sent.push(updates), { path: '/a/b/c', deps: [] }) } })
  })
  assert.ok(view.find({ text: 'b/c · package.json' }))
  const btn = view.find({ label: '^12.4.0-beta.3 cannot be rewritten here; edit package.json by hand' })
  assert.equal(btn?.disabled, false)
  await view.press({ label: String(btn!.label) })
  assert.deepEqual(sent, [])
  assert.ok(view.find({ text: /is not a plain version range/ }))
  await view.press({ label: 'Dismiss' })
  assert.equal(view.find({ text: /is not a plain version range/ }), null)
  await view.unmount()
})

test('shows the worker error', async () => {
  const view = await mount(panel, {
    host: mockHost({ requests: { 'deps.check': { path: null, deps: [], error: 'No workspace is focused.' } } })
  })
  assert.ok(view.find({ text: 'No workspace is focused.' }))
  await view.unmount()
})

test('Update with agent sits beside refresh, asks first, and offers the prompt for a chat', async () => {
  let started = 0
  const host = mockHost({
    requests: {
      'deps.check': { path: '/repo/app', deps: [react] },
      'deps.askAgent': () => (started++, { started: true, focused: true, sent: true }),
      'deps.agentPrompt': { prompt: 'Update the dependencies in package.json…' }
    }
  })
  const view = await mount(panel, { host })
  const btn = view.find({ label: 'Update with agent' })
  assert.equal(btn?.props.icon, 'agent')
  assert.equal(btn?.props.tooltip, 'Update every library with an agent, respecting semver')
  await view.press({ label: 'Update with agent' })
  assert.equal(started, 0, 'the first press only asks')
  assert.ok(view.find({ label: 'Update 1 library with one agent?' }))
  await view.press({ text: 'Copy prompt for a chat' })
  assert.equal(view.valueOf({ label: 'Prompt' }), 'Update the dependencies in package.json…')
  await view.press({ text: 'Close' })
  await view.press({ label: 'Update with agent' })
  await view.press({ text: 'Start agent' })
  assert.equal(started, 1)
  assert.ok(view.find({ text: /^An agent is updating the dependencies in the terminal tab Orca just opened/ }))
  assert.deepEqual(view.refusals, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})
