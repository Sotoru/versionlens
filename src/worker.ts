import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { addVulnerabilities } from './osv'
import type { Bump, Changelog, Dep, Release, Report, Status, Update } from './protocol'

const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const REGISTRY = 'https://registry.npmjs.org/'
const UPDATABLE = /^[\^~]?\d+(\.\d+){0,2}$/

export type Info = { latest: string | null; versions: string[]; peers: Record<string, Record<string, string>> }
export type Lookup = (name: string, signal: AbortSignal) => Promise<Info | null>

/** First x.y.z in a range such as `^1.2.3` or `>=1.2`; null for tags, git, file: and the like. */
export function baseVersion(spec: string): number[] | null {
  const m = /^[\^~>=<v\s]*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(spec)
  return m ? [m[1], m[2], m[3]].map((n) => Number(n ?? 0)) : null
}

const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** Newest stable version for each bump kind that is newer than the range base, like versionlens. */
export function suggest(spec: string, info: Info | null): Pick<Dep, 'suggestions' | 'status'> {
  const from = baseVersion(spec)
  if (!from || !info) return { suggestions: {}, status: 'unknown' }
  const best: Partial<Record<Bump, [number[], string]>> = {}
  const latest = info.latest && !info.latest.includes('-') ? baseVersion(info.latest) : null
  for (const v of info.versions) {
    if (v.includes('-')) continue
    const to = baseVersion(v)
    if (!to || cmp(to, from) <= 0 || (latest && cmp(to, latest) > 0)) continue
    const kind: Bump = to[0] > from[0] ? 'major' : to[1] > from[1] ? 'minor' : 'patch'
    if (!best[kind] || cmp(to, best[kind]![0]) > 0) best[kind] = [to, v]
  }
  const suggestions: Partial<Record<Bump, string>> = {}
  for (const k of ['patch', 'minor', 'major'] as const) if (best[k]) suggestions[k] = best[k]![1]
  const status: Status = suggestions.major ? 'major' : suggestions.minor ? 'minor' : suggestions.patch ? 'patch' : 'latest'
  return { suggestions, status }
}

/** `^1.2.3` + `2.0.0` → `^2.0.0`. */
export function rewrite(spec: string, version: string): string {
  return (/^[\^~]?/.exec(spec)?.[0] ?? '') + version
}

/** `git+https://github.com/o/r.git` (or `github:o/r`, `o/r`) → `o/r`; null when not on GitHub. */
export function githubRepo(repository: unknown): string | null {
  const url = typeof repository === 'string' ? repository : (repository as { url?: string } | null)?.url
  if (!url) return null
  const m = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:[/#].*)?$/.exec(url) ?? /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(url)
  return m ? `${m[1]}/${m[2]}` : null
}

type GhRelease = { tag_name: string; html_url: string; body: string | null; published_at: string | null; draft: boolean; prerelease: boolean }

/** Releases with from < version <= to; in a monorepo only the tags naming this package. */
export function pickReleases(name: string, from: string, to: string, all: GhRelease[]): Release[] {
  const lo = baseVersion(from)
  const hi = baseVersion(to)
  if (!lo || !hi) return []
  const own = all.filter((r) => r.tag_name.startsWith(`${name}@`))
  return (own.length ? own : all)
    .filter((r) => !r.draft && !r.prerelease)
    .flatMap((r) => {
      const version = /(\d+\.\d+\.\d+)$/.exec(r.tag_name)?.[1]
      const v = version ? baseVersion(version) : null
      if (!v || cmp(v, lo) <= 0 || cmp(v, hi) > 0) return []
      return [{ version: version!, url: r.html_url, body: (r.body ?? '').trim(), publishedAt: r.published_at ? Date.parse(r.published_at) : null, v }]
    })
    .sort((a, b) => cmp(b.v, a.v))
    .map(({ v: _v, ...r }) => r)
}

const MAX_RELEASES = 50

/** The CHANGELOG.md sections whose heading names a version in (from, to], newest first as written. */
export function sectionsInRange(md: string, from: string, to: string): string {
  const lo = baseVersion(from)
  const hi = baseVersion(to)
  if (!lo || !hi) return ''
  const out: string[] = []
  let keep = false
  let level = 0
  for (const line of md.split('\n')) {
    const h = /^(#{1,4})\s.*?v?(\d+\.\d+\.\d+)(?![\d-])/.exec(line)
    if (h && (!level || h[1].length <= level)) {
      const v = baseVersion(h[2])!
      level = h[1].length
      keep = cmp(v, lo) > 0 && cmp(v, hi) <= 0
    }
    if (keep) out.push(line)
  }
  return out.join('\n').trim()
}

/**
 * Some projects paste their whole CHANGELOG.md into every release: keep in each release only the
 * versions after the next older release (or `from`), so nothing repeats. Bodies without version
 * headings stay as they are.
 */
export function ownSections(releases: Release[], from: string): Release[] {
  return releases.map((r, i) => {
    const own = sectionsInRange(r.body, releases[i + 1]?.version ?? from, r.version)
    // The heading our document adds already names the version: drop the body's own.
    return own ? { ...r, body: own.replace(/^#{1,4}\s.*\n+/, '') } : r
  })
}

// shortcut: unauthenticated GitHub API (60 requests/hour) and only the newest 100 releases; add a token setting if that runs out.
export async function changelog(name: string, from: string, to: string, signal: AbortSignal): Promise<Changelog> {
  const meta = await fetch(`${REGISTRY}${name.replace('/', '%2f')}/latest`, { signal })
  const repository = meta.ok ? ((await meta.json()) as { repository?: unknown }).repository : null
  const repo = githubRepo(repository)
  if (!repo) return { repo: null, releases: [], note: 'This package does not link a GitHub repository.' }
  const page = `https://github.com/${repo}`
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
    headers: { accept: 'application/vnd.github+json' },
    signal
  })
  const releases = res.ok ? ownSections(pickReleases(name, from, to, (await res.json()) as GhRelease[]).slice(0, MAX_RELEASES), from) : []
  if (releases.some((r) => r.body)) return { repo: page, releases }

  // No release notes: many packages keep them only in CHANGELOG.md (in a monorepo, beside the package).
  const dir = (repository as { directory?: string } | null)?.directory
  const raw = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${dir ? `${dir}/` : ''}CHANGELOG.md`, { signal })
  const sections = raw.ok ? sectionsInRange(await raw.text(), from, to) : ''
  if (sections) return { repo: page, releases: [], changelog: sections }
  const limited = res.status === 403 || res.status === 429
  return {
    repo: page,
    releases,
    note: limited ? 'GitHub rate limit reached; try again later.' : 'No release notes or CHANGELOG.md entries for these versions.'
  }
}

/** The changelog as one Markdown document to read in an editor tab. */
export function toMarkdown(name: string, from: string, to: string, log: Changelog): string {
  const links = [`[npm](https://www.npmjs.com/package/${name})`, log.repo ? `[repository](${log.repo})` : null].filter(Boolean)
  const parts = [`# ${name}: ${from} → ${to}`, links.join(' · ')]
  for (const r of log.releases) {
    const date = r.publishedAt ? ` · ${new Date(r.publishedAt).toISOString().slice(0, 10)}` : ''
    parts.push(`---\n\n## [${r.version}](${r.url})${date}\n\n${r.body || '_No release notes._'}`)
  }
  if (log.changelog) parts.push(`---\n\n_From CHANGELOG.md_\n\n${log.changelog}`)
  if (log.note) parts.push(`> ${log.note}`)
  return parts.join('\n\n') + '\n'
}

/** Workspace-relative path for a changelog: node_modules/.cache is ignored by Git and by most tools. */
export function changelogPath(name: string, from: string, to: string): string {
  return `node_modules/.cache/versionlens/${name.replace(/^@/, '').replace(/\//g, '__')}-${from}-${to}.md`
}

// shortcut: always asks the public npm registry, ignoring .npmrc scopes and auth; read .npmrc when private packages matter.
async function npmLookup(name: string, signal: AbortSignal): Promise<Info | null> {
  const res = await fetch(REGISTRY + name.replace('/', '%2f'), {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal
  })
  if (!res.ok) return null
  const body = (await res.json()) as {
    'dist-tags'?: { latest?: string }
    versions?: Record<string, { peerDependencies?: Record<string, string> }>
  }
  const versions = body.versions ?? {}
  const peers = Object.fromEntries(Object.entries(versions).map(([v, m]) => [v, m.peerDependencies ?? {}]))
  return { latest: body['dist-tags']?.latest ?? null, versions: Object.keys(versions), peers }
}

/** The version npm installed, or null when the package is not in node_modules. */
async function installedVersion(dir: string, name: string): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(join(dir, 'node_modules', name, 'package.json'), 'utf8')) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

async function readPkg(dir: string): Promise<{ text: string; pkg: Record<string, any> }> {
  const text = await readFile(join(dir, 'package.json'), 'utf8')
  return { text, pkg: JSON.parse(text) }
}

export async function check(dir: string, signal: AbortSignal, lookup: Lookup, osv?: Parameters<typeof addVulnerabilities>[2]): Promise<Report> {
  const { pkg } = await readPkg(dir)
  const deps: Dep[] = SECTIONS.flatMap((section) =>
    Object.entries((pkg[section] ?? {}) as Record<string, string>).map(([name, current]) => ({
      name,
      section,
      current,
      latest: null,
      suggestions: {},
      status: 'unknown' as Status,
      updatable: UPDATABLE.test(current),
      installed: null,
      peers: {},
      vulns: {}
    }))
  )
  const names = new Set(deps.map((d) => d.name))
  let next = 0
  const workers = Array.from({ length: 8 }, async () => {
    while (next < deps.length) {
      const dep = deps[next++]
      const floor = baseVersion(dep.current)
      dep.installed = (await installedVersion(dir, dep.name)) ?? (floor && UPDATABLE.test(dep.current) ? floor.join('.') : null)
      if (!floor) continue
      const info = await lookup(dep.name, signal).catch(() => null)
      dep.latest = info?.latest ?? null
      Object.assign(dep, suggest(dep.current, info))
      // Only the versions the panel compares, and only peers this package.json has: keeps answers small.
      for (const v of [dep.installed, ...Object.values(dep.suggestions)]) {
        const p = v ? info?.peers[v] : undefined
        const own = p ? Object.fromEntries(Object.entries(p).filter(([n]) => names.has(n))) : {}
        if (v && Object.keys(own).length) dep.peers[v] = own
      }
    }
  })
  await Promise.all(workers)
  await addVulnerabilities(deps, signal, osv).catch(() => {})
  return { path: dir, deps }
}

/** Rewrites package.json keeping its indent and trailing newline; skips ranges it cannot rewrite. */
export async function apply(dir: string, updates: Update[]): Promise<void> {
  const { text, pkg } = await readPkg(dir)
  for (const u of updates) {
    const spec = pkg[u.section]?.[u.name]
    if (typeof spec !== 'string' || !UPDATABLE.test(spec) || !baseVersion(u.version)) continue
    pkg[u.section][u.name] = rewrite(spec, u.version)
  }
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? 2
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, indent) + (text.endsWith('\n') ? '\n' : ''))
}

export default function activate(orca: OrcaWorkerApi): void {
  // Cached for the worker's life so an update does not ask npm again; Refresh clears it.
  const cache = new Map<string, Promise<Info | null>>()
  const cached: Lookup = (name, signal) => {
    if (!cache.has(name)) cache.set(name, npmLookup(name, signal).catch(() => (cache.delete(name), null)))
    return cache.get(name)!
  }

  async function workspace(): Promise<{ id: string; path: string } | Report> {
    const ctx = await orca.host.call('workspace.readContext')
    if (!ctx?.workspaceId) return { path: null, deps: [], error: 'No workspace is focused.' }
    const { workspaces } = await orca.host.call('workspace.list')
    const ws = workspaces.find((w) => w.id === ctx.workspaceId)
    // shortcut: reads the path on the Orca host, so SSH workspaces fail; use terminal.create + cat for remote hosts.
    return ws ? { id: ws.id, path: ws.path } : { path: null, deps: [], error: 'Workspace not found.' }
  }

  async function run(signal: AbortSignal, before?: (dir: string) => Promise<void>): Promise<Report> {
    const ws = await workspace()
    if (!('id' in ws)) return ws
    try {
      await before?.(ws.path)
      return await check(ws.path, signal, cached)
    } catch (e) {
      return { path: ws.path, deps: [], error: `package.json: ${(e as Error).message}` }
    }
  }

  orca.panels.handle('deps.check', async (input, { signal }) => {
    if (input?.fresh) cache.clear()
    return run(signal)
  })
  orca.panels.handle('deps.update', async ({ updates }, { signal }) => run(signal, (dir) => apply(dir, updates)))
  orca.panels.handle('deps.openChangelog', async ({ name, from, to }, { signal }) => {
    const ws = await workspace()
    if (!('id' in ws)) throw Object.assign(new Error(ws.error), { code: 'unavailable' })
    const rel = changelogPath(name, from, to)
    const file = join(ws.path, rel)
    await mkdir(dirname(file), { recursive: true })
    // shortcut: editor.open has no read-only flag, so the file is read-only on disk (0444) and a save fails; switch to the flag if Orca adds one.
    await rm(file, { force: true })
    await writeFile(file, toMarkdown(name, from, to, await changelog(name, from, to, signal)), { mode: 0o444 })
    await orca.host.call('editor.open', { workspaceId: ws.id, path: rel })
    return { path: rel }
  })
}
