import { assert, test } from 'orca/testing'
import { addVulnerabilities } from './osv'
import type { Dep } from './protocol'

const dep = (name: string, installed: string, suggestions: Dep['suggestions']): Dep => ({
  name,
  section: 'dependencies',
  current: `^${installed}`,
  latest: null,
  suggestions,
  status: 'patch',
  updatable: true,
  installed,
  peers: {},
  vulns: {}
})

test('asks OSV for every version a row compares and keeps the CVE and severity', async () => {
  const calls: string[] = []
  const deps = [dep('sanitize-html', '2.7.0', { patch: '2.7.3' }), dep('ok', '1.0.0', {})]
  await addVulnerabilities(deps, new AbortController().signal, async (url, init) => {
    calls.push(url)
    if (url.endsWith('/querybatch')) {
      const { queries } = JSON.parse(init!.body!)
      assert.deepEqual(queries.map((q: { version: string }) => q.version), ['2.7.0', '2.7.3', '1.0.0'])
      return { ok: true, json: async () => ({ results: [{ vulns: [{ id: 'GHSA-cgfm' }] }, {}, {}] }) }
    }
    return {
      ok: true,
      json: async () => ({ id: 'GHSA-cgfm', summary: 'ReDoS', aliases: ['CVE-2022-25887'], database_specific: { severity: 'HIGH' } })
    }
  })
  assert.deepEqual(deps[0].vulns, {
    '2.7.0': [{ id: 'CVE-2022-25887', summary: 'ReDoS', severity: 'high', url: 'https://osv.dev/vulnerability/GHSA-cgfm' }]
  })
  assert.deepEqual(deps[1].vulns, {})
  assert.equal(calls.length, 2)
})

test('leaves vulns empty when OSV is down', async () => {
  const deps = [dep('x', '1.0.0', {})]
  await addVulnerabilities(deps, new AbortController().signal, async () => ({ ok: false, json: async () => ({}) }))
  assert.deepEqual(deps[0].vulns, {})
})
