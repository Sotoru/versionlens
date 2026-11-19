import { assert, test } from 'orca/testing'
import { PROMPT_MAX, updatePrompt } from './agent'
import type { Dep } from './protocol'

const dep = (name: string, installed: string, suggestions: Dep['suggestions'], extra: Partial<Dep> = {}): Dep => ({
  name,
  section: 'devDependencies',
  current: `^${installed}`,
  latest: null,
  suggestions,
  status: suggestions.major ? 'major' : suggestions.minor ? 'minor' : suggestions.patch ? 'patch' : 'latest',
  updatable: true,
  installed,
  peers: {},
  vulns: {},
  ...extra
})

// The real shapes from a SvelteKit project.
const deps = [
  dep('storybook', '10.6.3', { patch: '10.6.7' }),
  dep('@storybook/addon-a11y', '10.6.3', { patch: '10.6.7' }, { peers: { '10.6.7': { storybook: '^10.6.7' } } }),
  dep('typescript', '6.0.3', { major: '7.0.2' }),
  dep('svelte-check', '4.7.7', {}, { peers: { '4.7.7': { typescript: '^5.0.0 || ^6.0.0' } } }),
  dep('@sveltejs/kit', '3.3.1', { minor: '3.4.0' }),
  dep('sanitize-html', '2.7.0', { patch: '2.7.3' }, { section: 'dependencies', vulns: { '2.7.0': [{ id: 'CVE-2022-25887', summary: 'ReDoS', severity: 'high', url: '' }] } }),
  dep('design-tokens', '12.4.0', { major: '13.0.0' }, { current: '^12.4.0-beta.3', updatable: false })
]

test('the update prompt orders the work as a careful person would', () => {
  const p = updatePrompt(deps)
  assert.ok(p.length <= PROMPT_MAX)
  const at = (s: string) => p.indexOf(s)
  assert.ok(at('known vulnerabilities') < at('Patch updates'), 'vulnerabilities first')
  assert.ok(at('Patch updates') < at('Minor updates') && at('Minor updates') < at('Major updates'), 'then patch, minor, major')
  assert.match(p, /sanitize-html 2\.7\.0 \(CVE-2022-25887\)\. Updating sanitize-html fixes them\./)
  assert.match(p, /- storybook \^10\.6\.3 → 10\.6\.7, @storybook\/addon-a11y \^10\.6\.3 → 10\.6\.7 \[update together\]/)
  assert.match(p, /- typescript \^6\.0\.3 → 7\.0\.2 \[breaks svelte-check \(wants typescript \^5\.0\.0 \|\| \^6\.0\.0\)\]/)
  assert.match(p, /keep each range prefix \(\^ or ~\)/)
  assert.match(p, /not plain versions: design-tokens \^12\.4\.0-beta\.3/)
  assert.match(p, /Do not commit\.$/)
})

test('a list too long for a terminal message keeps the rules and points at npm outdated', () => {
  const many = Array.from({ length: 300 }, (_, i) => dep(`pkg-with-a-long-name-${i}`, '1.0.0', { minor: '1.1.0' }))
  const p = updatePrompt(many)
  assert.ok(p.length <= PROMPT_MAX)
  assert.match(p, /There are 300 updates/)
  assert.match(p, /npm outdated/)
  assert.match(p, /Do not commit\.$/)
})
