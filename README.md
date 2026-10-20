# dsh-pr-chip

Pull request state on every DSH session row — a small icon that tells you whether the
work behind a chat is still `open`, sitting as a `draft`, already `merged`, or `closed`.

A DeepSeek Harness (DSH) plugin: host half resolves the state, browser half draws the
chip in the sidebar's session row. Glyph shapes follow the badge the Codex desktop app
uses; colours are GitHub's.

> 中文文档见下方「中文」一节。

## How it works

The session record never stores PR state. It stores an identity, and the state is
always queried:

```
sessionId ──resolve cwd──> (ownerRepo, branch) ──gh pr list --head──> state
```

`cwd` is resolved in two steps: the workspace owning the session in
`storages/workspace.json`, and — when that misses — the session's own on-disk directory
name (`--Users-me-proj--`, with `~XXXX` escapes and hyphens split by walking cut points
that exist on disk). The second path is real: a session's cwd is not always its
workspace path, and old sessions outlive their workspace row.

State is cached in memory only (30s for an answer, 60s for "no PR"), keyed by **cwd**, so
sessions sharing a workspace share one lookup. Lookups are de-duplicated in flight and
capped at four concurrent child processes.

### Where the identity comes from, in order

1. **Live worktree** — session cwd → git branch → `gh pr list --head`
2. **Remembered identity** (`links.json`) — the checkout was archived or deleted
3. **Live events** — a `gh pr create` seen on the session event bus, paired with the
   output of that same call id
4. **One-shot backfill** — for sessions predating the install, the transcript is scanned
   once; the result is recorded and never rescanned

Both 3 and 4 accept only `gh pr create`'s own output shape — one bare PR URL — so a
command that merely prints a URL, or prose that quotes one, cannot match.

## Install

```sh
# from a local checkout
dsh plugin --profile <profile> add link:/path/to/dsh-pr-chip

# from git
dsh plugin --profile <profile> add github:OWNER/dsh-pr-chip
```

Restart the host afterwards: the bundle list is composed at startup.

> On the DSH desktop app the profile is managed by the application and `dsh plugin`
> refuses it; add the dependency and the `dsh.profile.bundles` entry by hand, plus the
> `node_modules` symlink.

## Requirements

- DSH ≥ 0.2.1 (the `sidebar.session.row.leading` seat passes `{ sessionId }`)
- `git` and `gh` on `PATH`, with `gh auth status` healthy

## When nothing is drawn

- the directory is not a git worktree (a temporary path is fine — only a worktree matters)
- the branch is a detached HEAD
- the branch has no PR and no remembered identity
- `gh` is missing or unauthenticated

The endpoint answers `state: null` with a `reason`
(`no-branch`, `no-pull-request`, `workspace-missing`, `gh-failed`) and the row renders
exactly as before.

## Files it writes

Everything lives under `$DSH_HOME/pr-chip/`:

| file | contents |
| --- | --- |
| `links.json` | session → `(ownerRepo, branch, number)` identity, atomically written, 500 entries max |
| `scanned.json` | sessions whose transcript was already backfilled once |
| `host-loaded.jsonl` | one line per host start (diagnostics) |

## Offline

The chip keeps the last state it observed. When `gh` cannot reach GitHub the endpoint
answers with the stored state marked `stale: true` instead of `null`, so a dropped
connection hides nothing — and a failed lookup never overwrites the good state that is
already on disk. The first successful query after reconnect replaces it.

A session that never resolved a PR has nothing stored, so nothing is invented: it stays
without a chip.

## Where it shows

`sidebar.session.row.leading` — the 16px cell before the session title. DSH renders that
cell only while the row is idle, and never for archived or blank rows.

DSH has no "always visible after the title" seat: `sidebar.session.row.hover` lives inside
the hover card, and `sidebar.workspaces.session.row.action` appears only while hovering.
The leading cell is the only permanent slot, so the chip lives there.

## 中文

会话行上的 PR 状态图标：`open` / `draft` / `merged` / `closed` 四态，颜色沿用 GitHub
配色（`#1f883d` / `#6e7781` / `#8250df` / `#cf222e`）。

- **状态从不落盘**，只记身份；每次查询，带缓存。
- **三条兜底**：落盘的身份、会话事件里的 `gh pr create`、一次性日志回溯。
- **只认真实输出**：必须是 `gh pr create` 自己返回的裸 URL，正文里提到的 URL 不算。

安装后重启宿主生效。没有 PR 的会话行外观完全不变。

## License

MIT — see [LICENSE](./LICENSE).
