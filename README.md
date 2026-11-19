# Version Lens for Orca

A sidebar panel for [Orca](https://www.onorca.dev) that reads the `package.json` of the focused
workspace and shows which dependencies have newer versions on npm, inspired by
[Version Lens for VS Code](https://marketplace.visualstudio.com/items?itemName=pflannery.vscode-versionlens).

- **All, Major, Minor and Patch** tabs, and a search.
- **Update in place**: one press rewrites the version in `package.json`, keeping `^` or `~`.
  Run your package manager's install afterwards.
- **Changelog**: opens the GitHub release notes (or the matching `CHANGELOG.md` sections)
  between your version and the new one, in an editor tab.
- **Linked packages**: packages that must move together (from their `peerDependencies`, or one
  family such as `@storybook/*` and `storybook`) share one row and update together.
- **Compatibility warnings**: an icon when a new version breaks another package's peer range,
  or needs a peer nothing here provides.
- **Known vulnerabilities** from [OSV.dev](https://osv.dev), in the installed and in the new
  version.

## Install

```sh
orca plugin install Sotoru/versionlens
```

Orca asks you to approve it first. It needs:

- **Its own Node.js process** (`trusted-worker`): to read and write `package.json` and to call
  npm, GitHub and OSV.dev.
- **`workspace:read`**: to find the focused workspace's folder.
- **`workspace:write`**: only to open a changelog file in an editor tab.

## What it sends where

Package names and versions go to `registry.npmjs.org`, `api.github.com`,
`raw.githubusercontent.com` and `api.osv.dev`. Nothing else leaves your machine.

## Limits

- Public npm registry only: `.npmrc` scopes and private registries are not read.
- Local workspaces only: a workspace on an SSH host is not read.
- The `package.json` at the workspace root only, not monorepo packages below it.
- GitHub allows 60 unauthenticated requests an hour; each changelog opened uses up to two.
- Changelog files are written read-only to `node_modules/.cache/versionlens/`.

## Develop

```sh
orca plugin dev watch . --check --json   # load this folder; asks for approval
orca plugin test . --json
orca plugin check . --json
```
