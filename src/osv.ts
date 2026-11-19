// Known vulnerabilities from OSV.dev, the database versionlens for VS Code reads too.
import type { Dep, Vuln } from './protocol'

const OSV = 'https://api.osv.dev/v1'
const MAX_DETAILS = 60

type Fetch = (url: string, init?: { method?: string; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>
type OsvVuln = {
  id: string
  summary?: string
  details?: string
  aliases?: string[]
  database_specific?: { severity?: string }
}

/** The versions a row compares: what is installed and each update on offer. */
const versionsOf = (d: Dep) => [...new Set([d.installed, ...Object.values(d.suggestions)].filter((v): v is string => !!v && /^\d+\.\d+\.\d+/.test(v)))]

/** Fills `vulns` on each dependency; leaves them empty when OSV cannot be reached. */
export async function addVulnerabilities(deps: Dep[], signal: AbortSignal, get: Fetch = fetch as unknown as Fetch): Promise<void> {
  const queries = deps.flatMap((d) => versionsOf(d).map((version) => ({ dep: d, version })))
  if (!queries.length) return
  const res = await get(`${OSV}/querybatch`, {
    method: 'POST',
    body: JSON.stringify({ queries: queries.map((q) => ({ package: { name: q.dep.name, ecosystem: 'npm' }, version: q.version })) }),
    signal
  })
  if (!res.ok) return
  const { results } = (await res.json()) as { results: { vulns?: { id: string }[] }[] }
  const ids = [...new Set(results.flatMap((r) => r.vulns?.map((v) => v.id) ?? []))]

  // The batch answers ids only; summaries and severity need one call per vulnerability.
  // shortcut: details for the first 60 ids only; past that, rows show the id alone.
  const details = new Map<string, OsvVuln>()
  await Promise.all(
    ids.slice(0, MAX_DETAILS).map(async (id) => {
      const r = await get(`${OSV}/vulns/${encodeURIComponent(id)}`, { signal }).catch(() => null)
      if (r?.ok) details.set(id, (await r.json()) as OsvVuln)
    })
  )

  results.forEach((r, i) => {
    if (!r.vulns?.length) return
    const { dep, version } = queries[i]
    dep.vulns[version] = r.vulns.map(({ id }) => {
      const v = details.get(id)
      const cve = v?.aliases?.find((a) => a.startsWith('CVE-'))
      return {
        id: cve ?? id,
        summary: v?.summary ?? v?.details?.split('\n')[0] ?? 'Known vulnerability',
        severity: v?.database_specific?.severity?.toLowerCase() ?? null,
        url: `https://osv.dev/vulnerability/${id}`
      }
    })
  })
}
