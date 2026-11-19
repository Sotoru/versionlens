// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export type Bump = 'major' | 'minor' | 'patch'
export type Status = Bump | 'latest' | 'unknown'

export type Dep = {
  name: string
  section: string
  current: string
  latest: string | null
  /** Newest stable version per kind of bump, only when it is newer than `current`. */
  suggestions: Partial<Record<Bump, string>>
  status: Status
  /** Exact, ^ or ~ ranges: the only ones the panel rewrites. */
  updatable: boolean
  /** The version in node_modules, or the range's floor when nothing is installed. */
  installed: string | null
  /** peerDependencies by version (installed and each suggestion), only on packages in this package.json. */
  peers: Record<string, Record<string, string>>
  /** Known vulnerabilities by version (installed and each suggestion), from OSV.dev. */
  vulns: Record<string, Vuln[]>
}

export type Vuln = { id: string; summary: string; severity: string | null; url: string }

export type Report = { path: string | null; deps: Dep[]; error?: string }

export type Update = { section: string; name: string; version: string }

export type Release = { version: string; publishedAt: number | null; url: string; body: string }

export type Changelog = {
  /** Repository page, when the package names one. */
  repo: string | null
  /** GitHub releases newer than `from` up to `to`, newest first. */
  releases: Release[]
  /** The matching CHANGELOG.md sections, when there are no release notes. */
  changelog?: string
  /** Why there is nothing to show, when there is nothing. */
  note?: string
}

declare module 'orca' {
  interface PluginRequests {
    /** Reads the focused workspace's package.json and looks up each dependency on npm. */
    'deps.check': { input: { fresh?: boolean }; output: Report }
    /** Rewrites the given dependencies in package.json, keeping each range's ^ or ~. */
    'deps.update': { input: { updates: Update[] }; output: Report }
    /** Writes the changelog between two versions to a Markdown file and opens it in an editor tab. */
    'deps.openChangelog': { input: { name: string; from: string; to: string }; output: { path: string } }
    /** Starts one agent to update every outdated dependency, linked ones together, majors last. */
    'deps.askAgent': { output: { started: boolean; focused: boolean; sent: boolean } }
    /** The same prompt, to paste into a chat: plugins can only open agents in a terminal. */
    'deps.agentPrompt': { output: { prompt: string } }
  }
}
