// Which updates belong together, worked out from the peerDependencies of the versions on offer.
import type { Bump, Dep } from './protocol'
import { satisfies } from './semver'

export type Filter = 'all' | Bump
export type Target = { version: string; kind: Bump }
export type Member = { dep: Dep; to: Target }
/** `name` asks for `peer` in `range`. */
export type Problem = { name: string; peer: string; range: string }

/** One row of the panel: a package, or packages that must move together (hub first). */
export type Item = {
  key: string
  hub: Member
  members: Member[]
  kind: Bump
  /** Peers these versions want that no update on offer here provides. */
  needs: Problem[]
  /** Packages whose peer range these versions leave. */
  breaks: Problem[]
  /** The family name (`storybook`, `pandacss`) when it is what joins the members. */
  family: string | null
}

const KINDS: Bump[] = ['patch', 'minor', 'major']

/** What a row offers under `filter`: that kind's suggestion, or under All the biggest one. */
export function targetOf(d: Dep, filter: Filter): Target | null {
  for (const k of filter === 'all' ? [...KINDS].reverse() : [filter]) {
    const version = d.suggestions[k]
    if (version) return { version, kind: k }
  }
  return null
}

const peersAt = (d: Dep | undefined, version: string | null) => (d && version && d.peers[version]) || {}
const fails = (version: string | null | undefined, range: string) => !!version && satisfies(version, range) === false
/** The lowest version package.json allows: what a fresh install may pick, so what peers must accept. */
const floor = (d: Dep | undefined) => (d ? /^[\^~]?(\d+\.\d+\.\d+)$/.exec(d.current)?.[1] ?? d.installed : null)

function addOnce(list: Problem[], p: Problem): void {
  if (!list.some((x) => x.name === p.name && x.peer === p.peer)) list.push(p)
}

const scopeOf = (name: string) => (name.startsWith('@') ? name.split('/')[0] : null)
/** `@storybook/addon-a11y` and `storybook` are both family `storybook`; `@types/*` is no family. */
const familyOf = (name: string) => {
  const scope = scopeOf(name)
  if (scope === '@types') return null
  return scope ? scope.slice(1) : name
}

/**
 * `families` also joins packages of one family: the same npm scope (`@storybook/*`) plus the bare
 * package that names it (`storybook`). Only those whose updates land on one version join, so
 * `@sveltejs/kit` and `@sveltejs/adapter-vercel`, released apart, stay apart. `@types/*` never
 * joins: it mirrors other projects' versions.
 */
export function link(deps: Dep[], filter: Filter, families = false): Item[] {
  const byName = new Map(deps.map((d) => [d.name, d]))
  const members = new Map<string, Member>()
  for (const dep of deps) {
    const to = targetOf(dep, filter)
    if (to) members.set(dep.name, { dep, to })
  }

  // Join a package to each peer whose declared range it outgrows, when that peer's update catches up.
  const parent = new Map([...members.keys()].map((n) => [n, n]))
  const root = (n: string): string => (parent.get(n) === n ? n : root(parent.get(n)!))
  for (const m of members.values()) {
    for (const [peer, range] of Object.entries(peersAt(m.dep, m.to.version))) {
      const other = members.get(peer)
      if (other && fails(floor(other.dep), range) && !fails(other.to.version, range)) {
        parent.set(root(m.dep.name), root(peer))
      }
    }
  }

  if (families) {
    const first = new Map<string, string>()
    for (const m of members.values()) {
      const family = familyOf(m.dep.name)
      if (!family) continue
      const key = `${family}@${m.to.version}`
      const seen = first.get(key)
      if (seen) parent.set(root(m.dep.name), root(seen))
      else first.set(key, m.dep.name)
    }
  }

  const groups = new Map<string, Member[]>()
  for (const [name, m] of members) groups.set(root(name), [...(groups.get(root(name)) ?? []), m])

  return [...groups.values()].map((list) => {
    const names = new Set(list.map((m) => m.dep.name))
    const after = (n: string) => (names.has(n) ? members.get(n)!.to.version : byName.get(n)?.installed ?? null)

    // Only what this update causes: a peer range already unmet today is not its doing.
    const needs: Problem[] = []
    for (const m of list) {
      const before = peersAt(m.dep, m.dep.installed)
      for (const [peer, range] of Object.entries(peersAt(m.dep, m.to.version))) {
        const already = before[peer] && fails(byName.get(peer)?.installed, before[peer])
        if (fails(after(peer), range) && !already) addOnce(needs, { name: m.dep.name, peer, range })
      }
    }
    const breaks: Problem[] = []
    for (const d of deps) {
      if (names.has(d.name)) continue
      for (const [peer, range] of Object.entries(peersAt(d, d.installed))) {
        if (names.has(peer) && fails(after(peer), range) && !fails(byName.get(peer)!.installed, range)) {
          addOnce(breaks, { name: d.name, peer, range })
        }
      }
    }

    // The hub is the package the others ask for, like `storybook` for its addons.
    const asked = (n: string) => list.filter((m) => n in peersAt(m.dep, m.to.version)).length
    const hub = [...list].sort((a, b) => asked(b.dep.name) - asked(a.dep.name))[0]
    const kind = KINDS[Math.max(...list.map((m) => KINDS.indexOf(m.to.kind)))]
    const families = new Set(list.map((m) => familyOf(m.dep.name)))
    const family = list.length > 1 && families.size === 1 ? [...families][0] : null
    return {
      key: `${hub.dep.section}:${hub.dep.name}`,
      hub,
      members: [hub, ...list.filter((m) => m !== hub)],
      kind,
      needs,
      breaks,
      family
    }
  })
}
