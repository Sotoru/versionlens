// The prompt for "Update with agent": every upgrade Version Lens found, in the order that keeps
// the project working, with the constraints it worked out (linked packages, peer conflicts, CVEs).
import { link, type Item } from './links'
import type { Dep } from './protocol'

// terminal.sendText takes at most 4096 characters.
export const PROMPT_MAX = 4000

const line = (i: Item) => {
  const names = i.members.map((m) => `${m.dep.name} ${m.dep.current} → ${m.to.version}`).join(', ')
  const notes = [
    i.members.length > 1 ? 'update together' : '',
    i.breaks.length ? `breaks ${i.breaks.map((p) => `${p.name} (wants ${p.peer} ${p.range})`).join(', ')}` : '',
    i.needs.length ? `needs ${i.needs.map((p) => `${p.peer} ${p.range}`).join(', ')}` : ''
  ].filter(Boolean)
  return `- ${names}${notes.length ? ` [${notes.join('; ')}]` : ''}`
}

const KIND_ORDER = { patch: 0, minor: 1, major: 2 } as const

/** Groups, sorted so the safe updates come first and the majors last, then the prompt. */
export function updatePrompt(deps: Dep[]): string {
  const items = link(deps, 'all', true).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
  const vulnerable = deps.filter((d) => d.installed && d.vulns[d.installed]?.length)
  const fixed = items.filter((i) => i.members.some((m) => m.dep.installed && m.dep.vulns[m.dep.installed]?.length)).flatMap((i) => i.members.map((m) => m.dep.name))
  const manual = deps.filter((d) => !d.updatable && d.status !== 'latest' && d.status !== 'unknown')
  const groups = (kind: 'patch' | 'minor' | 'major') => items.filter((i) => i.kind === kind).map(line)

  const sections = [
    'Update the dependencies in package.json, as Version Lens (an Orca plugin) found them. Respect semver: keep each range prefix (^ or ~), and never jump a major version without reading its changelog.',
    vulnerable.length
      ? `First, these have known vulnerabilities in the installed version: ${vulnerable.map((d) => `${d.name} ${d.installed} (${d.vulns[d.installed!]!.map((v) => v.id).join(', ')})`).join('; ')}.${fixed.length ? ` Updating ${[...new Set(fixed)].join(', ')} fixes them.` : ''}`
      : '',
    groups('patch').length ? `Patch updates (bug fixes, safe to apply together):\n${groups('patch').join('\n')}` : '',
    groups('minor').length ? `Minor updates (new features, no breaking changes):\n${groups('minor').join('\n')}` : '',
    groups('major').length
      ? `Major updates (may break code): do them one group at a time, read each changelog or migration guide, and adapt the code:\n${groups('major').join('\n')}`
      : '',
    manual.length ? `Leave these ranges as they are and tell me about them; they are not plain versions: ${manual.map((d) => `${d.name} ${d.current}`).join(', ')}.` : '',
    'Packages marked "update together" must move in one step, as their peerDependencies require. Where an update "breaks" another package, skip it unless that package can move too, and say so.',
    'After each step run the package manager install, the type check and the tests. If a step breaks something you cannot fix with a small change, revert that step and go on. At the end, report what you updated, what you skipped and why. Do not commit.'
  ].filter(Boolean)

  const text = sections.join('\n\n')
  if (text.length <= PROMPT_MAX) return text
  // A long list does not fit a terminal message: keep the rules, point at the panel for the list.
  return [
    sections[0],
    `There are ${items.length} updates (${groups('patch').length} patch, ${groups('minor').length} minor, ${groups('major').length} major groups). Run \`npm outdated\` (or your package manager's equivalent) to list them.`,
    ...sections.slice(-2)
  ]
    .join('\n\n')
    .slice(0, PROMPT_MAX)
}
