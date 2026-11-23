// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  EmptyState,
  Heading,
  IconButton,
  Input,
  plugin,
  read,
  Row,
  Separator,
  set,
  Spinner,
  Stack,
  Tab,
  Tabs,
  Text,
  Textarea,
  update,
  type OrcaNode,
  type PanelContext
} from 'orca'
import { link, targetOf, type Filter, type Item, type Member, type Problem, type Target } from './links'
import type { Dep, Report, Update, Vuln } from './protocol'

const report = atom<Report | null>(null)
const busy = atom(false)
const notice = atom<string | null>(null)
const query = atom('')
const filter = atom<Filter>('filter', 'all', { persist: 'plugin' })
const opening = atom<Record<string, boolean>>({})
const expanded = atom<Record<string, boolean>>({})
/** An error or a warning the person dismisses; `notice` is the success message. */
const failure = atom<{ text: string; tone: 'danger' | 'warning' } | null>(null)
/** Rows whose warning icon was pressed, so the full text shows under them. */
const pinned = atom<Record<string, boolean>>({})

const FILTERS: Filter[] = ['all', 'major', 'minor', 'patch']
const LABEL: Record<Filter, string> = { all: 'All', major: 'Major', minor: 'Minor', patch: 'Patch' }
const SECTION_LABEL: Record<string, string> = {
  dependencies: 'Dependencies',
  devDependencies: 'Dev dependencies',
  peerDependencies: 'Peer dependencies',
  optionalDependencies: 'Optional dependencies'
}

const bare = (spec: string) => spec.replace(/^[\^~]/, '')

async function call(work: () => Promise<Report>, done?: string): Promise<void> {
  set(busy, true)
  set(notice, null)
  try {
    const r = await work()
    set(report, r)
    if (done && !r.error) set(notice, done)
  } catch (e) {
    set(report, { path: null, deps: [], error: (e as Error).message })
  } finally {
    set(busy, false)
  }
}

const refresh = (fresh = false) => call(() => plugin.request('deps.check', { fresh }, { timeoutMs: 120000 }))

/** "Update with agent": first press asks, the second starts it. */
const confirmingAgent = atom(false)
/** The prompt on screen for "Copy prompt"; null when hidden. */
const shownPrompt = atom<string | null>(null)

async function askAgent(): Promise<void> {
  set(confirmingAgent, false)
  set(failure, null)
  set(notice, 'Starting an agent to update the dependencies…')
  try {
    // The worker waits for the agent to be ready before it types the prompt: allow it a minute.
    const { focused, sent } = await plugin.request('deps.askAgent', undefined, { timeoutMs: 90000 })
    const where = focused ? 'in the terminal tab Orca just opened' : 'in a new terminal tab of this workspace'
    if (sent) set(notice, `An agent is updating the dependencies ${where}: patches first, linked packages together, majors last with their changelogs. Review its changes before you commit them.`)
    else {
      set(notice, null)
      set(failure, { text: `The agent opened ${where}, but it did not get ready for the prompt within a minute (a login or trust screen?). Answer it, then press the button again.`, tone: 'warning' })
    }
  } catch (e) {
    set(notice, null)
    set(failure, { text: `Could not start an agent: ${(e as Error).message}`, tone: 'danger' })
  }
}

async function showPrompt(): Promise<void> {
  set(confirmingAgent, false)
  try {
    set(shownPrompt, (await plugin.request('deps.agentPrompt', undefined, { timeoutMs: 60000 })).prompt)
  } catch (e) {
    set(failure, { text: (e as Error).message, tone: 'warning' })
  }
}

function apply(updates: Update[]): Promise<void> {
  if (updates.length === 0) return Promise.resolve()
  const what = updates.length === 1 ? `${updates[0].name} → ${updates[0].version}` : `${updates.length} packages`
  return call(
    () => plugin.request('deps.update', { updates }, { timeoutMs: 120000 }),
    `Updated ${what} in package.json. Run your package manager's install to apply it.`
  )
}

async function openChangelog(d: Dep, to: string): Promise<void> {
  const k = `${d.name}@${to}`
  update(opening, (o) => ({ ...o, [k]: true }))
  set(notice, null)
  try {
    await plugin.request('deps.openChangelog', { name: d.name, from: bare(d.current), to }, { timeoutMs: 60000 })
  } catch (e) {
    set(notice, null)
    set(failure, { text: `Changelog for ${d.name}: ${(e as Error).message}`, tone: 'danger' })
  } finally {
    update(opening, (o) => ({ ...o, [k]: false }))
  }
}

export function setup(ctx: PanelContext): void {
  void refresh()
  // The worker checks by itself when package.json changes, focus moves, or every hour.
  ctx.subscriptions.push(
    plugin.on('deps.updated', (r) => {
      if (read(busy)) return
      if (r.path !== read(report)?.path) set(pinned, {})
      set(report, r)
    })
  )
}

const toUpdate = (members: Member[]): Update[] =>
  members.filter((m) => m.dep.updatable).map((m) => ({ section: m.dep.section, name: m.dep.name, version: m.to.version }))

const peerList = (ps: Problem[]) => ps.map((p) => `${p.peer} ${p.range}`).join(', ')
const userList = (ps: Problem[]) => ps.map((p) => `${p.name} (wants ${p.range})`).join(', ')

/** A row's flag: its vulnerabilities and the peers its update breaks or needs. */
type Flag = { key: string; item?: Item; vulns: Vuln[] }

const SEVERITY = ['critical', 'high', 'moderate', 'low']
const capital = (w: string) => w[0].toUpperCase() + w.slice(1)
const vulnLine = (v: Vuln) => `${v.severity ? `${capital(v.severity)}: ` : ''}${v.id} ${v.summary}`
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function peerLines(item?: Item): string[] {
  if (!item) return []
  return [
    item.breaks.length ? `Breaks ${userList(item.breaks)}` : null,
    item.needs.length ? `Needs ${peerList(item.needs)}` : null
  ].filter((x): x is string => !!x)
}

// Orca drops a label past 1 KiB and draws a placeholder; 300 characters stays under it in any script.
const MAX_TIP = 300

/** The tooltip: short enough for Orca's label limit; the press shows everything. */
function flagTip({ item, vulns }: Flag): string {
  const worst = SEVERITY.find((s) => vulns.some((v) => v.severity === s))
  const vulnPart =
    vulns.length <= 2
      ? vulns.map(vulnLine)
      : [`${vulns.length} known vulnerabilities${worst ? ` (up to ${worst})` : ''}: ${vulns.slice(0, 2).map((v) => v.id).join(', ')} +${vulns.length - 2} more`]
  const text = `${[...vulnPart, ...peerLines(item)].join('. ')}. Press for details.`
  return text.length > MAX_TIP ? `${text.slice(0, MAX_TIP - 1)}…` : text
}

const hasFlag = (f: Flag) => f.vulns.length > 0 || peerLines(f.item).length > 0

// An empty box the size of an icon-sm button, so every row's icons line up in the same columns.
const slot = () => <Box width={32} height={32} shrink={false} />

// Orca colours an IconButton only for tone "danger", and then as a filled chip; any other tone
// draws a bare glyph like the changelog's, so the icon shape is what marks the warning.
function FlagButton(f: Flag) {
  if (!hasFlag(f)) return slot()
  const text = flagTip(f)
  return (
    <IconButton
      icon={f.vulns.length ? 'bug' : 'warning'}
      label={text}
      tooltip={text}
      variant={read(pinned)[f.key] ? 'solid' : 'ghost'}
      size="sm"
      onPress={() => update(pinned, (p) => ({ ...p, [f.key]: !p[f.key] }))}
    />
  )
}

const MAX_LINES = 12

/** Everything the tooltip shortened, under the row, once its icon is pressed. */
function FlagDetail(f: Flag) {
  if (!read(pinned)[f.key] || !hasFlag(f)) return null
  const lines = [...f.vulns.map(vulnLine), ...peerLines(f.item)]
  return (
    <Stack gap="xs">
      {lines.slice(0, MAX_LINES).map((l) => (
        <Text size="xs" tone="warning">
          {`⚠ ${l}`}
        </Text>
      ))}
      {lines.length > MAX_LINES ? (
        <Text size="xs" muted>
          {`+${lines.length - MAX_LINES} more`}
        </Text>
      ) : null}
    </Stack>
  )
}

const tabLabel = (label: string, n: number) => `${label} (${n})`

/** `Storybook`, `Pandacss`; else the package the others ask for. */
const title = (item: Item) => (item.family ? capital(item.family) : item.hub.dep.name)

/** Major in the warning tone: it is what someone scanning the list looks for. */
const kindNode = (kind: Target["kind"]) => (kind === "major" ? <Text size="xs" tone="warning">major</Text> : kind)

/** Every row, single or group, has this one shape so they all stand the same height. */
function RowShell({ name, detail, flag, actions }: { name: string; detail: OrcaNode[]; flag: Flag; actions: OrcaNode[] }) {
  return (
    <Box direction="column" gap="xs" paddingX="sm" paddingY="sm">
      <Box direction="row" gap="xs" align="center">
        <Box grow minWidth={0} gap="xs">
          <Text weight="medium" truncate>
            {name}
          </Text>
          <Text size="xs" muted truncate>
            {detail}
          </Text>
        </Box>
        {FlagButton(flag)}
        {actions}
      </Box>
      {FlagDetail(flag)}
    </Box>
  )
}

/** What an update fixes and what it still carries, from the vulnerabilities of both versions. */
function security(dep: Dep, to: string): { now: Vuln[]; after: Vuln[] } {
  const now = (dep.installed && dep.vulns[dep.installed]) || []
  return { now, after: dep.vulns[to] ?? [] }
}

/** `· fixes 2 vulnerabilities` in green, or `· 3 vulnerabilities` in amber. */
function vulnNode(dep: Dep, to: string) {
  const { now, after } = security(dep, to)
  const left = new Set(after.map((v) => v.id))
  const fixed = now.filter((v) => !left.has(v.id)).length
  const all = new Set([...now, ...after].map((v) => v.id)).size
  if (fixed) return ['  ·  ', <Text size="xs" tone="success">{`fixes ${plural(fixed, 'vulnerability', 'vulnerabilities')}`}</Text>]
  if (all) return ['  ·  ', <Text size="xs" tone="warning">{plural(all, 'vulnerability', 'vulnerabilities')}</Text>]
  return null
}

function DepCard({ dep, to, disabled, loading, item }: { dep: Dep; to: Target; disabled: boolean; loading: boolean; item?: Item }) {
  const { now, after } = security(dep, to.version)
  const vulns = [
    ...now.map((v) => ({ ...v, summary: `${v.summary} (in ${dep.installed})` })),
    ...after.filter((v) => !now.some((n) => n.id === v.id)).map((v) => ({ ...v, summary: `${v.summary} (in ${to.version})` }))
  ]
  return RowShell({
    name: dep.name,
    detail: [`${dep.current}  →  ${to.version}  ·  `, kindNode(to.kind), vulnNode(dep, to.version)],
    flag: { key: `${dep.section}:${dep.name}`, item, vulns },
    actions: [
      <IconButton
        icon="file-text"
        label={`Changelog for ${dep.name} ${bare(dep.current)} → ${to.version}`}
        variant="ghost"
        size="sm"
        disabled={loading}
        onPress={() => openChangelog(dep, to.version)}
      />,
      // Never disabled: a disabled button shows no tooltip, so the press explains instead.
      <IconButton
        icon="upload"
        label={dep.updatable ? `Update ${dep.name} to ${to.version}` : `${dep.current} cannot be rewritten here; edit package.json by hand`}
        variant="solid"
        tone="accent"
        size="sm"
        disabled={disabled}
        onPress={() =>
          dep.updatable
            ? apply([{ section: dep.section, name: dep.name, version: to.version }])
            : set(failure, { text: `${dep.name}: ${dep.current} is not a plain version range, so Version Lens leaves it alone. Edit package.json by hand.`, tone: 'warning' })
        }
      />
    ]
  })
}

function GroupCard({ item, disabled, loadingLogs, isOpen }: { item: Item; disabled: boolean; loadingLogs: Record<string, boolean>; isOpen: boolean }) {
  const { hub, members } = item
  const updates = toUpdate(members)
  return (
    <Box direction="column">
      {RowShell({
        name: title(item),
        detail: [`${hub.dep.current}  →  ${hub.to.version}  ·  `, kindNode(item.kind), `  ·  ${members.length} packages`],
        flag: {
          key: item.key,
          item,
          vulns: members.flatMap((m) => security(m.dep, m.to.version).now.map((v) => ({ ...v, summary: `${v.summary} (${m.dep.name} ${m.dep.installed})` })))
        },
        actions: [
          <IconButton
            icon={isOpen ? 'collapse' : 'expand'}
            label={`${isOpen ? 'Hide' : 'Show'} the ${members.length} ${title(item)} packages`}
            variant={isOpen ? 'solid' : 'ghost'}
            size="sm"
            onPress={() => update(expanded, (e) => ({ ...e, [item.key]: !isOpen }))}
          />,
          <IconButton
            icon="upload"
            label={`Update all ${members.length} ${title(item)} packages`}
            variant="solid"
            tone="accent"
            size="sm"
            disabled={disabled || updates.length === 0}
            onPress={() => apply(updates)}
          />
        ]
      })}
      {isOpen ? (
        <Box background="muted" direction="column">
          {members.flatMap((m) => [
            <Separator />,
            DepCard({ dep: m.dep, to: m.to, disabled, loading: !!loadingLogs[`${m.dep.name}@${m.to.version}`] })
          ])}
        </Box>
      ) : null}
    </Box>
  )
}

export default function Panel() {
  const r = read(report)
  const working = read(busy)
  const current = read(filter)
  const q = read(query).trim().toLowerCase()
  const msg = read(notice)
  const loadingLogs = read(opening)
  const failed = read(failure)
  const deps = (r?.deps ?? []).filter((d) => !q || d.name.toLowerCase().includes(q))

  const open = read(expanded)
  const counts = Object.fromEntries(FILTERS.map((f) => [f, deps.filter((d) => targetOf(d, f)).length])) as Record<Filter, number>
  // Links are worked out on every package, so a search still groups and warns as without it.
  const items = link(r?.deps ?? [], current, true).filter((i) => i.members.some((m) => deps.includes(m.dep)))
  const rows = items.flatMap((i) => i.members)
  const sections = Object.keys(SECTION_LABEL).filter((s) => items.some((i) => i.hub.dep.section === s))
  const upToDate = (r?.deps ?? []).filter((d) => d.status === 'latest').length
  // No update to offer, yet the version in use is affected: say so where "up to date" is.
  const stuck = (r?.deps ?? []).filter((d) => !targetOf(d, 'all') && d.installed && d.vulns[d.installed]?.length)
  const stuckFlag: Flag = {
    key: 'up-to-date',
    vulns: stuck.flatMap((d) => d.vulns[d.installed!].map((v) => ({ ...v, summary: `${v.summary} (${d.name} ${d.installed}, no fix released)` })))
  }

  const list = (
    <Stack gap="sm">
      {rows.length === 0 ? (
        <EmptyState icon="check" title={q ? 'No matching packages' : current === 'all' ? 'All up to date' : `No ${current} updates`} />
      ) : (
        sections.map((s) => (
          <Stack gap="sm">
            <Row gap="xs">
              <Text size="xs" muted weight="medium">
                {SECTION_LABEL[s]}
              </Text>
              <Badge>{String(items.filter((i) => i.hub.dep.section === s).length)}</Badge>
            </Row>
            <Box border radius="md" direction="column">
              {items
                .filter((i) => i.hub.dep.section === s)
                .flatMap((i, n) => [
                  n > 0 ? <Separator /> : null,
                  i.members.length > 1
                    ? GroupCard({ item: i, disabled: working, loadingLogs, isOpen: !!open[i.key] })
                    : DepCard({ dep: i.hub.dep, to: i.hub.to, disabled: working, loading: !!loadingLogs[`${i.hub.dep.name}@${i.hub.to.version}`], item: i })
                ])}
            </Box>
          </Stack>
        ))
      )}
    </Stack>
  )

  return (
    <Stack gap="md">
      <Row justify="between" align="start">
        <Stack gap="none">
          <Heading>Versions</Heading>
          <Text muted size="sm" truncate>
            {r?.path ? `${r.path.split('/').slice(-2).join('/')} · package.json` : 'package.json'}
          </Text>
        </Stack>
        <Row gap="none">
          {r && !r.error && rows.length ? (
            <IconButton
              icon="agent"
              label="Update with agent"
              tooltip="Update every library with an agent, respecting semver"
              variant={read(confirmingAgent) ? 'solid' : 'ghost'}
              disabled={working}
              onPress={() => update(confirmingAgent, (v) => !v)}
            />
          ) : null}
          <IconButton icon="refresh" label="Refresh" tooltip="Check npm again" variant="ghost" disabled={working} onPress={() => refresh(true)} />
        </Row>
      </Row>
      {read(confirmingAgent) ? (
        <Callout tone="accent" icon="agent" title={`Update ${plural(rows.length, 'library', 'libraries')} with one agent?`}>
          <Stack gap="sm">
            <Text size="xs">
              It fixes known vulnerabilities first, then applies patches, then minors, then majors one group at a time after reading their changelogs. Linked packages move together, ranges keep their ^ or ~, and it runs install, the type check and the tests after each step. Nothing is committed.
            </Text>
            <Row gap="xs" wrap>
              <Button icon="agent" tone="accent" variant="solid" size="sm" onPress={askAgent}>
                Start agent
              </Button>
              <Button icon="copy" variant="ghost" size="sm" onPress={showPrompt}>
                Copy prompt for a chat
              </Button>
              <Button variant="ghost" size="sm" onPress={() => set(confirmingAgent, false)}>
                Cancel
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      {read(shownPrompt) !== null ? (
        <Callout tone="neutral" icon="copy" title="Prompt for a chat">
          <Stack gap="sm">
            <Text size="xs" muted>
              Plugins can open agents only in a terminal. To use a chat, select this text, copy it with ⌘C and paste it there.
            </Text>
            <Textarea label="Prompt" labelHidden rows={8} value={read(shownPrompt)!} onChange={() => {}} />
            <Row>
              <Button variant="ghost" size="sm" onPress={() => set(shownPrompt, null)}>
                Close
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      {r && !r.error ? (
        <Tabs
          label="Filter"
          value={current}
          onChange={(v) => {
            set(filter, v as Filter)
                    }}
        >
          {FILTERS.map((f) => (
            <Tab value={f} label={tabLabel(LABEL[f], counts[f])}>
              {null}
            </Tab>
          ))}
        </Tabs>
      ) : null}
      <Input label="Search packages" labelHidden type="search" placeholder="Search packages…" value={read(query)} onChange={(v) => set(query, v)} />
      {r?.error ? <Callout tone="warning">{r.error}</Callout> : null}
      {failed ? (
        <Callout tone={failed.tone} icon={failed.tone === 'danger' ? 'error' : 'warning'}>
          <Row justify="between" gap="xs">
            <Text size="sm">{failed.text}</Text>
            <IconButton icon="close" label="Dismiss" variant="ghost" size="xs" onPress={() => set(failure, null)} />
          </Row>
        </Callout>
      ) : null}
      {msg ? (
        <Callout tone="success" icon="check">
          <Row justify="between" gap="xs">
            <Text size="sm">{msg}</Text>
            <IconButton icon="close" label="Dismiss" variant="ghost" size="xs" onPress={() => set(notice, null)} />
          </Row>
        </Callout>
      ) : null}
      {working && !r ? <Spinner label="Checking npm" /> : null}
      {r && !r.error ? (
        <Stack gap="sm">
          <Row justify="between">
            <Text weight="semibold">{plural(rows.length, 'update', 'updates')}</Text>
            <Row gap="xs">
              {stuck.length ? FlagButton(stuckFlag) : null}
              <Text muted size="xs">
                {working ? 'Checking npm…' : `✓ ${upToDate} up to date`}
              </Text>
            </Row>
          </Row>
          {FlagDetail(stuckFlag)}
          {list}
        </Stack>
      ) : null}
    </Stack>
  )
}
