// Just enough of npm's semver to check peerDependencies ranges, without a bundled dependency.
// Prerelease tags are ignored (`10.6.0-0` reads as 10.6.0), which only loosens a check.

type V = [number, number, number]
type Test = (v: V) => boolean

const cmp = (a: V, b: V) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** `1.2.3`, `1.2`, `1.x`, `*`: the numbers given, and how many there are. */
function partial(s: string): { v: V; n: number } | null {
  if (s === '' || s === '*' || s === 'x' || s === 'X') return { v: [0, 0, 0], n: 0 }
  const m = /^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(s)
  if (!m) return null
  const parts = [m[1], m[2], m[3]]
  const n = parts.findIndex((p) => p === undefined || /[xX*]/.test(p))
  const count = n === -1 ? 3 : n
  return { v: parts.map((p, i) => (i < count ? Number(p) : 0)) as V, n: count }
}

const bump = (v: V, i: number): V => (i === 0 ? [v[0] + 1, 0, 0] : i === 1 ? [v[0], v[1] + 1, 0] : [v[0], v[1], v[2] + 1])
const between = (lo: V, hi: V | null): Test => (v) => cmp(v, lo) >= 0 && (!hi || cmp(v, hi) < 0)

function comparator(c: string): Test | null {
  const m = /^(\^|~>?|>=|<=|>|<|=)?\s*(.*)$/.exec(c)!
  const op = m[1] ?? ''
  const p = partial(m[2])
  if (!p) return null
  const { v, n } = p
  if (n === 0) return op === '<' || op === '>' ? () => false : () => true
  switch (op) {
    case '^': {
      // ^1.2.3 < 2.0.0, ^0.2.3 < 0.3.0, ^0.0.3 < 0.0.4; a partial bumps its last given part.
      const first = v.findIndex((x, i) => x !== 0 || i === n - 1)
      return between(v, bump(v, Math.min(first, n - 1)))
    }
    case '~':
    case '~>':
      return between(v, bump(v, n === 1 ? 0 : 1))
    case '>=':
      return (x) => cmp(x, v) >= 0
    case '>':
      return n === 3 ? (x) => cmp(x, v) > 0 : (x) => cmp(x, bump(v, n - 1)) >= 0
    case '<=':
      return n === 3 ? (x) => cmp(x, v) <= 0 : (x) => cmp(x, bump(v, n - 1)) < 0
    case '<':
      return (x) => cmp(x, v) < 0
    default:
      return n === 3 ? (x) => cmp(x, v) === 0 : between(v, bump(v, n - 1))
  }
}

function conjunction(set: string): Test | null {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set)
  if (hyphen) {
    const lo = partial(hyphen[1])
    const hi = partial(hyphen[2])
    if (!lo || !hi) return null
    return (v) => cmp(v, lo.v) >= 0 && (hi.n === 3 ? cmp(v, hi.v) <= 0 : cmp(v, bump(hi.v, hi.n - 1)) < 0)
  }
  // `>= 4` and `>=4` are the same comparator: glue an operator to the version after it.
  const parts = set.replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean)
  const tests = parts.map(comparator)
  if (tests.some((t) => !t)) return null
  return (v) => tests.every((t) => t!(v))
}

/** Whether `version` is in `range`; null when either is not one this reads (a tag, URL, alias). */
export function satisfies(version: string, range: string): boolean | null {
  const p = partial(version.trim())
  if (!p || p.n < 3) return null
  const sets = range.trim().split('||').map((s) => conjunction(s.trim()))
  if (sets.some((t) => !t)) return null
  return sets.some((t) => t!(p.v))
}
