// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh host.
import { defineCheck } from 'orca/testing'
import type { Dep, Report, Vuln } from './protocol'

const dep = (name: string, current: string, suggestions: Dep['suggestions'], peers: Dep['peers'] = {}, vulns: Dep['vulns'] = {}): Dep => ({
  name,
  section: 'devDependencies',
  current,
  latest: null,
  suggestions,
  status: suggestions.major ? 'major' : suggestions.minor ? 'minor' : suggestions.patch ? 'patch' : 'latest',
  updatable: true,
  installed: current.replace(/^[\^~]/, ''),
  peers,
  vulns
})

// Shapes taken from a real SvelteKit project: one warning, one group, one plain row.
const warnings: Report = {
  path: '/home/dev/projects/my-app',
  deps: [
    dep('typescript', '^6.0.3', { major: '7.0.2' }),
    dep('svelte-check', '^4.7.7', {}, { '4.7.7': { typescript: '^5.0.0 || ^6.0.0' } }),
    dep('@sveltejs/kit', '^3.3.1', { minor: '3.4.0' }, { '3.3.1': { typescript: '^6.0.0' }, '3.4.0': { typescript: '^6.0.0' } }),
    dep('vitest', '5.1.0', { patch: '5.1.1' }, { '5.1.1': { '@vitest/coverage-v8': '5.1.1' } }),
    dep('@vitest/coverage-v8', '5.1.0', { patch: '5.1.1' }, { '5.1.1': { vitest: '5.1.1' } }),
    dep('lib', '^1.0.0', { minor: '1.1.0' }, { '1.1.0': { svelte: '^6.0.0' } }),
    dep('svelte', '^5.58.0', {})
  ]
}

// Real worst cases: lodash 4.17.15 has five advisories with long titles; a monorepo name runs long.
const advisory = (n: number): Vuln => ({
  id: `CVE-2026-${10000 + n}`,
  summary: 'ApostropheCMS: Incomplete fix for meta http-equiv=refresh content still ships javascript: and data: URLs through the allowedTags policy',
  severity: n % 2 ? 'high' : 'moderate',
  url: 'https://osv.dev/x'
})
const worst: Report = {
  path: '/home/dev/clients/northwind-industries-holdings/apps/customer-onboarding-dashboard',
  deps: [
    dep('lodash', '4.17.15', { patch: '4.17.23', minor: '4.18.1' }, {}, { '4.17.15': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(advisory), '4.18.1': [advisory(11)] }),
    dep('@northwind-industries/customer-onboarding-dashboard-design-tokens', '^12.4.0-beta.3', { major: '13.0.0' }),
    ...Array.from({ length: 300 }, (_, i) => dep(`pkg-${i}`, '^1.0.0', { patch: '1.0.1' }))
  ]
}

export default defineCheck({
  noWorkspace: { results: { 'workspace.readContext': null } },
  warnings: { requests: { 'deps.check': warnings } },
  worst: { requests: { 'deps.check': worst } }
})
