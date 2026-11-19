import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { type Info, apply, changelogPath, ownSections, check, githubRepo, pickReleases, rewrite, sectionsInRange, suggest, toMarkdown } from './worker'

test('cuts CHANGELOG.md to the versions in (from, to]', () => {
  const md = '# Changelog\n\n## [2.1.0] - 2026-01-02\n- new\n### Fixed\n- bug 2.0.9 mention\n\n## 2.0.0\n- old\n\n## v1.9.0\n- older\n'
  assert.equal(sectionsInRange(md, '1.9.0', '2.1.0'), '## [2.1.0] - 2026-01-02\n- new\n### Fixed\n- bug 2.0.9 mention\n\n## 2.0.0\n- old')
  assert.equal(sectionsInRange(md, '2.1.0', '2.1.0'), '')
})

test('drops the history a release body repeats', () => {
  const rel = (version: string, text: string) => ({ version, url: version, publishedAt: null, body: text })
  const full = '# pkg\n\n## [2.1.0]\n- c\n\n## [2.0.1]\n- b\n\n## [2.0.0]\n- a\n'
  const fromOld = full.slice(full.indexOf('## [2.0.1]'))
  const out = ownSections([rel('2.1.0', full), rel('2.0.1', fromOld), rel('2.0.0', 'plain notes')], '1.9.0')
  assert.deepEqual(out.map((r) => r.body), ['- c', '- b', 'plain notes'])
})

test('writes one readable document under node_modules/.cache', () => {
  assert.equal(changelogPath('@ark-ui/svelte', '5.24.3', '5.25.1'), 'node_modules/.cache/versionlens/ark-ui__svelte-5.24.3-5.25.1.md')
  const md = toMarkdown('x', '1.0.0', '1.1.0', {
    repo: 'https://github.com/o/x',
    releases: [{ version: '1.1.0', url: 'https://u', body: '- fix', publishedAt: Date.UTC(2026, 0, 2) }]
  })
  assert.match(md, /^# x: 1\.0\.0 → 1\.1\.0/)
  assert.match(md, /## \[1\.1\.0\]\(https:\/\/u\) · 2026-01-02\n\n- fix/)
})

test('finds the GitHub repo in every npm form', () => {
  assert.equal(githubRepo({ url: 'git+https://github.com/vitejs/vite.git', directory: 'packages/vite' }), 'vitejs/vite')
  assert.equal(githubRepo('github:sindresorhus/ky'), 'sindresorhus/ky')
  assert.equal(githubRepo('git@github.com:o/r.git'), 'o/r')
  assert.equal(githubRepo('https://gitlab.com/o/r'), null)
  assert.equal(githubRepo(undefined), null)
})

test('keeps releases in (from, to], prefers a monorepo package tag', () => {
  const rel = (tag_name: string, prerelease = false) => ({ tag_name, html_url: tag_name, body: null, published_at: null, draft: false, prerelease })
  const picked = (name: string, list: ReturnType<typeof rel>[]) => pickReleases(name, '1.0.0', '1.2.0', list).map((r) => r.version)
  assert.deepEqual(picked('x', [rel('v1.0.0'), rel('v1.1.0'), rel('v1.2.0'), rel('v1.3.0'), rel('v1.1.5-beta.1', true)]), ['1.2.0', '1.1.0'])
  assert.deepEqual(picked('@s/a', [rel('@s/a@1.1.0'), rel('@s/b@1.1.0'), rel('v1.2.0')]), ['1.1.0'])
})

const noOsv = async () => ({ ok: false, json: async () => ({}) })
const versions = ['1.2.3', '1.2.9', '1.4.0', '1.5.0-beta.1', '2.0.0', '3.0.0', '3.1.0', '4.0.0-rc.1']

test('suggests the newest stable patch, minor and major', () => {
  assert.deepEqual(suggest('^1.2.3', { latest: '3.1.0', versions, peers: {} }), {
    suggestions: { patch: '1.2.9', minor: '1.4.0', major: '3.1.0' },
    status: 'major'
  })
  assert.deepEqual(suggest('~3.1.0', { latest: '3.1.0', versions, peers: {} }), { suggestions: {}, status: 'latest' })
  assert.deepEqual(suggest('latest', { latest: '3.1.0', versions, peers: {} }), { suggestions: {}, status: 'unknown' })
  // Never suggests past dist-tags.latest (a 4.0.0 published but not tagged latest).
  assert.deepEqual(suggest('3.0.0', { latest: '3.0.0', versions: ['3.0.0', '4.0.0'], peers: {} }).status, 'latest')
})

test('keeps the range prefix', () => {
  assert.equal(rewrite('^1.2.3', '2.0.0'), '^2.0.0')
  assert.equal(rewrite('~1.2.3', '1.2.9'), '~1.2.9')
  assert.equal(rewrite('1.2.3', '1.2.9'), '1.2.9')
})

test('reads the installed version and keeps only peers this package.json has', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vl-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ devDependencies: { addon: '^1.0.0', core: '^1.0.0' } }))
  await mkdir(join(dir, 'node_modules', 'addon'), { recursive: true })
  await writeFile(join(dir, 'node_modules', 'addon', 'package.json'), '{"version":"1.0.4"}')
  const info: Record<string, Info> = {
    addon: { latest: '1.1.0', versions: ['1.0.4', '1.1.0'], peers: { '1.1.0': { core: '^1.1.0', react: '*' } } },
    core: { latest: '1.1.0', versions: ['1.0.0', '1.1.0'], peers: {} }
  }
  const r = await check(dir, new AbortController().signal, async (n) => info[n] ?? null, noOsv)
  const [addon, core] = r.deps
  assert.equal(addon.installed, '1.0.4')
  assert.equal(core.installed, '1.0.0')
  assert.deepEqual(addon.peers, { '1.1.0': { core: '^1.1.0' } })
})

test('checks every section and rewrites only plain ranges', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vl-'))
  const text = '{\n    "dependencies": {\n        "a": "^1.2.3",\n        "b": "file:../b",\n        "c": ">=1 <2"\n    }\n}\n'
  await writeFile(join(dir, 'package.json'), text)
  const r = await check(dir, new AbortController().signal, async () => ({ latest: '3.1.0', versions, peers: {} }), noOsv)
  assert.deepEqual(
    r.deps.map((d) => [d.name, d.status, d.updatable]),
    [['a', 'major', true], ['b', 'unknown', false], ['c', 'major', false]]
  )
  await apply(dir, [
    { section: 'dependencies', name: 'a', version: '1.4.0' },
    { section: 'dependencies', name: 'c', version: '3.1.0' }
  ])
  assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), text.replace('^1.2.3', '^1.4.0'))
})

test('Update with agent: nothing starts when every library is up to date', async () => {
  const { mockHost, mountWorker } = await import('orca/testing')
  const main = await import('./worker')
  const dir = await mkdtemp(join(tmpdir(), 'vl-agent-'))
  // A file: range is never looked up on npm, so the check is offline and finds nothing to update.
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { local: 'file:../local' } }))
  const calls: string[] = []
  const host = mockHost({
    results: {
      'workspace.readContext': { workspaceId: 'w1', branch: 'main', displayName: 'app', terminals: [] },
      'workspace.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'app', path: dir, branch: 'main', hostId: 'local' }], truncated: false },
      'agent.launch': () => (calls.push('launch'), { terminalId: 't1' })
    }
  })
  const worker = await mountWorker(main, { host })
  await assert.rejects(() => worker.request('deps.askAgent'), /up to date/)
  await assert.rejects(() => worker.request('deps.agentPrompt'), /up to date/)
  await worker.deactivate()
  assert.deepEqual(calls, [])
})

test('types the prompt only once the agent is ready, never into a trust screen', async () => {
  const { agentReady, deliverPrompt } = await import('./worker')
  const READY = ['  Claude Code v2.1.328', '❯ Try "write a test"']
  assert.equal(agentReady(['', '']), false)
  assert.equal(agentReady(READY), true)
  assert.equal(agentReady(['Do you trust the files in this folder?', '❯ 1. Yes, proceed']), false)
  const screens = [[''], ['']]
  const sent: string[] = []
  assert.equal(await deliverPrompt(async () => screens.shift() ?? READY, async (t) => (sent.push(t), true), 'go', { everyMs: 1, wait: async () => {} }), true)
  assert.deepEqual([sent, screens], [['go'], []])
})
