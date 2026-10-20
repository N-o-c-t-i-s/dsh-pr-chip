/**
 * dsh-pr-chip — host half.
 *
 * Resolves the pull-request state of the repository behind one DSH session and
 * serves it to the browser half, which draws a small chip on the session row.
 *
 * Modelled on the Codex desktop app: the session record stores no PR state.
 * Only the identity is resolved (session → workspace cwd → git branch), and the
 * state is queried from GitHub through the `gh` CLI with a short TTL cache.
 * A session that cannot be resolved simply reports `state: null`.
 *
 * @module dsh-pr-chip
 */

import { execFile } from 'node:child_process'
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompressSync } from 'node:zlib'

/** Route prefix for this plugin's JSON operations. */
export const ROUTE_PREFIX = '/api/dsh-pr-chip'

/** Required services. */
export const inject = ['webServer']

const execFileAsync = promisify(execFile)

/** How long one resolved answer is reused before GitHub is asked again. */
const TTL_MS = 30_000

/** How long a negative answer (no repo / no PR / gh missing) is reused. */
const NEGATIVE_TTL_MS = 60_000

/** Upper bound on cached working directories, so a long-lived host cannot grow forever. */
const CACHE_LIMIT = 200

/** How many git/gh child processes may run at once. */
const MAX_CONCURRENCY = 4

/** cwd → { at, value } — state depends on the directory, not the session. */
const cache = new Map()

/** cwd → pending promise, so parallel session rows share one lookup. */
const inflight = new Map()

/** How long a transcript scan that found no PR is trusted. */
const TRANSCRIPT_MISS_MS = 300_000

/** sessionId → moment a scan found no PR. */
const transcriptMiss = new Map()

/** `ownerRepo::branch` → { at, rows } for re-queries of remembered branches. */
const listCache = new Map()

/** `ownerRepo#number` → { at, value } for single-PR reads. */
const prCache = new Map()

/** Parsed workspace storage plus the moment it was read. */
let workspaceCache = { at: 0, text: undefined }

/** Rolling child-process slots. */
let active = 0
const waiting = []

/**
 * Take one concurrency slot.
 * @returns {Promise<void>} resolves when a slot is free.
 */
function acquire() {
  if (active < MAX_CONCURRENCY) {
    active += 1
    return Promise.resolve()
  }
  return new Promise(resolve => waiting.push(resolve))
}

/** Release one concurrency slot, waking the next waiter. */
function release() {
  const next = waiting.shift()
  if (next !== undefined) next()
  else active -= 1
}

/** DSH home directory. */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Read and parse the workspace storage, reusing the last parse for a moment:
 * every visible session row asks for its cwd, and the file only changes when a
 * workspace is added.
 * @returns {Promise<Record<string, unknown> | undefined>} the parsed store.
 */
async function workspaceStore() {
  const now = Date.now()
  if (workspaceCache.text !== undefined && now - workspaceCache.at < 5_000) return workspaceCache.text
  let raw
  try {
    raw = JSON.parse(await readFile(join(dshHome(), 'storages', 'workspace.json'), 'utf8'))
  } catch {
    workspaceCache = { at: now, text: undefined }
    return undefined
  }
  workspaceCache = { at: now, text: raw }
  return raw
}

/**
 * Resolve the working directory of a session through the workspace storage.
 * Workspaces own their session id lists, so this is a pure file read: no
 * internal service API and no ambiguity in the on-disk session slug.
 *
 * @param {string} sessionId - session id as passed by the browser half.
 * @returns {Promise<string | undefined>} the workspace path, when known.
 */
async function cwdOf(sessionId) {
  const stored = await workspaceStore()
  const workspaces = stored?.tables?.workspaces
  if (workspaces !== null && typeof workspaces === 'object') {
    const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
    for (const workspace of Object.values(workspaces)) {
      const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
      if (!ids.includes(sessionId) && !ids.includes(bare)) continue
      if (typeof workspace?.path === 'string' && workspace.path !== '') return workspace.path
    }
  }
  return cwdFromSessionDir(sessionId)
}

/**
 * Recover a session's working directory from its on-disk session directory.
 *
 * A session's cwd is not always its workspace path (a workspace can host a
 * session opened on a subdirectory, and older sessions outlive the workspace
 * row). The directory name encodes it: `--Users-me-proj--` is
 * `/Users/me/proj`, with `~XXXX` standing in for characters that must not
 * appear literally. Hyphens are ambiguous against path separators, so the
 * decode walks cut positions and keeps the first interpretation that exists.
 *
 * @param {string} sessionId - session id.
 * @returns {Promise<string | undefined>} the decoded path, when found.
 */
async function cwdFromSessionDir(sessionId) {
  const root = join(dshHome(), 'sessions')
  let slugs
  try {
    slugs = await readdir(root)
  } catch {
    return undefined
  }
  const ids = sessionId.startsWith('session-') ? [sessionId] : [sessionId, `session-${sessionId}`]
  for (const slug of slugs) {
    for (const id of ids) {
      if (!await exists(join(root, slug, id))) continue
      return decodeSlug(slug)
    }
  }
  return undefined
}

/**
 * Decode one session directory name into an absolute path.
 * @param {string} slug - the directory name, e.g. `--Users-me-proj--`.
 * @returns {Promise<string | undefined>} the path when it exists on disk.
 */
async function decodeSlug(slug) {
  let body = slug
  if (body.startsWith('--')) body = body.slice(2)
  if (body.endsWith('--')) body = body.slice(0, -2)
  body = body.replace(/~([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
  if (body === '') return undefined
  const parts = body.split('-')

  /** Walk one interpretation: cut points become path separators. */
  const walk = async (index, current) => {
    if (current.length > 4096) return undefined
    if (index === parts.length) return await exists(current) ? current : undefined
    let segment = ''
    for (let cursor = index; cursor < parts.length; cursor += 1) {
      segment = segment === '' ? parts[cursor] : `${segment}-${parts[cursor]}`
      const next = join(current, segment)
      if (!await exists(next)) continue
      const found = await walk(cursor + 1, next)
      if (found !== undefined) return found
    }
    return undefined
  }

  return walk(0, '/')
}

/**
 * Run one command and return stdout, or undefined when it fails.
 * @param {string} file - executable.
 * @param {string[]} args - argument vector, never shell-interpolated.
 * @param {string} cwd - working directory.
 * @returns {Promise<string | undefined>} trimmed stdout on success.
 */
async function run(file, args, cwd) {
  await acquire()
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    return stdout.trim()
  } catch {
    return undefined
  } finally {
    release()
  }
}

/**
 * The checked-out branch of one workspace.
 * @param {string} cwd - workspace directory.
 * @returns {Promise<string | undefined>} branch name, undefined when the
 * directory is not a git worktree or is in detached HEAD.
 */
async function branchOf(cwd) {
  const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], cwd)
  if (inside !== 'true') return undefined
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  if (branch === undefined || branch === '') return undefined
  if (branch === 'HEAD') return undefined
  return branch
}

/**
 * Pick the PR that represents a branch, preferring the live one.
 * Mirrors Codex's precedence: an open PR wins over a merged one, a merged one
 * over a closed one.
 * @param {Array<Record<string, unknown>>} rows - `gh pr list` JSON rows.
 * @returns {Record<string, unknown> | undefined} the chosen row.
 */
function pickPr(rows) {
  const byState = state => rows.filter(row => row?.state === state)
  const mergedAt = row => (typeof row?.mergedAt === 'string' ? Date.parse(row.mergedAt) : 0)
  const open = byState('OPEN').sort((a, b) => Number(a.number) - Number(b.number))
  const merged = byState('MERGED').sort((a, b) => mergedAt(b) - mergedAt(a))
  const closed = byState('CLOSED').sort((a, b) => Number(b.number) - Number(a.number))
  return open[0] ?? merged[0] ?? closed[0]
}

/**
 * Normalize a `gh` row into the four display states the chip renders.
 * @param {Record<string, unknown> | undefined} pr - chosen PR row.
 * @returns {'open' | 'draft' | 'merged' | 'closed' | null} display state.
 */
function displayState(pr) {
  if (pr === undefined) return null
  if (pr.state === 'MERGED') return 'merged'
  if (pr.state === 'CLOSED') return 'closed'
  if (pr.isDraft === true) return 'draft'
  return 'open'
}

/**
 * The `owner/repo` behind a checkout's `origin` remote.
 * @param {string} cwd - workspace directory.
 * @returns {Promise<string | undefined>} the repository slug.
 */
async function remoteOf(cwd) {
  const url = await run('git', ['remote', 'get-url', 'origin'], cwd)
  if (url === undefined) return undefined
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
  if (match === null) return undefined
  return `${match[1]}/${match[2]}`
}

/**
 * Resolve the current PR of one working directory.
 * @param {string} cwd - workspace directory.
 * @returns {Promise<Record<string, unknown>>} the payload served to the chip.
 */
async function resolve(cwd) {
  const branch = await branchOf(cwd)
  if (branch === undefined) return { state: null, reason: 'no-branch', cwd }
  const ownerRepo = await remoteOf(cwd)
  const out = await run(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '10',
      '--json', 'number,state,isDraft,url,title,mergedAt'],
    cwd,
  )
  if (out === undefined) return { state: null, reason: 'gh-failed', cwd, branch, ownerRepo }
  let rows
  try {
    rows = JSON.parse(out)
  } catch {
    return { state: null, reason: 'gh-unparsable', cwd, branch, ownerRepo }
  }
  const pr = pickPr(Array.isArray(rows) ? rows : [])
  const state = displayState(pr)
  if (state === null) return { state: null, reason: 'no-pull-request', cwd, branch, ownerRepo }
  return {
    state,
    cwd,
    branch,
    ownerRepo,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    isDraft: pr.isDraft === true,
    mergedAt: pr.mergedAt ?? null,
  }
}

/**
 * Cached, de-duplicated resolution for one working directory.
 * @param {string} cwd - workspace directory.
 * @returns {Promise<Record<string, unknown>>} the payload.
 */
async function resolveCwd(cwd) {
  const now = Date.now()
  const hit = cache.get(cwd)
  if (hit !== undefined) {
    const ttl = hit.value.state === null ? NEGATIVE_TTL_MS : TTL_MS
    if (now - hit.at < ttl) return hit.value
  }
  const pending = inflight.get(cwd)
  if (pending !== undefined) return pending
  const task = resolve(cwd)
    .then(value => {
      if (cache.size >= CACHE_LIMIT) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (oldest !== undefined) cache.delete(oldest[0])
      }
      cache.set(cwd, { at: Date.now(), value })
      return value
    })
    .finally(() => inflight.delete(cwd))
  inflight.set(cwd, task)
  return task
}

/** How many session → PR links are retained. */
const LINK_LIMIT = 500

/** Parsed link store, plus the serialized writer that persists it. */
let linksCache
let writeChain = Promise.resolve()

/** Path of the link store. */
function linksPath() {
  return join(dshHome(), 'pr-chip', 'links.json')
}

/**
 * Whether a path still resolves on disk.
 * @param {string} path - absolute path.
 * @returns {Promise<boolean>} true when it exists.
 */
async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Split a GitHub pull request URL into the identity a later query needs.
 * @param {unknown} url - the PR's web URL.
 * @returns {{ ownerRepo: string, number: number } | undefined} identity.
 */
function identityOf(url) {
  if (typeof url !== 'string') return undefined
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url)
  if (match === null) return undefined
  return { ownerRepo: `${match[1]}/${match[2]}`, number: Number(match[3]) }
}

/**
 * Read the link store, keeping one parse for the process lifetime.
 * @returns {Promise<Record<string, Record<string, unknown>>>} session → link.
 */
async function readLinks() {
  if (linksCache !== undefined) return linksCache
  try {
    const parsed = JSON.parse(await readFile(linksPath(), 'utf8'))
    linksCache = parsed?.links !== null && typeof parsed?.links === 'object' ? parsed.links : {}
  } catch {
    linksCache = {}
  }
  return linksCache
}

/** Persist the link store atomically. */
async function writeLinks() {
  const dir = join(dshHome(), 'pr-chip')
  await mkdir(dir, { recursive: true })
  const temporary = join(dir, 'links.json.tmp')
  await writeFile(temporary, JSON.stringify({ version: 1, links: linksCache ?? {} }), 'utf8')
  await rename(temporary, linksPath())
}

/**
 * Remember which repository and branch a session was working on.
 *
 * The identity recorded here is `(ownerRepo, branch)` — never the PR state,
 * and not even necessarily a PR number: a session that has not opened a PR yet
 * still gets an identity, so a later PR is picked up by the same query. This is
 * the part that has to survive the checkout, since Codex-style per-task
 * worktrees get archived or cleaned up.
 *
 * @param {string} sessionId - session id.
 * @param {string} cwd - the checkout it was resolved from.
 * @param {Record<string, unknown>} value - the resolved payload.
 */
async function rememberLink(sessionId, cwd, value) {
  if (typeof value.ownerRepo !== 'string') return
  // A branch is optional: a PR recovered from the transcript has an identity
  // but no checkout of its own to take one from.
  const branch = typeof value.branch === 'string' && value.branch !== '' ? value.branch : undefined
  const links = await readLinks()
  const prior = links[sessionId]
  if (prior !== undefined
    && prior.cwd === cwd
    && prior.ownerRepo === value.ownerRepo
    && (branch === undefined || prior.branch === branch)) {
    // A failed lookup must not erase the last state we actually observed:
    // going offline should dim nothing and hide nothing.
    if (typeof value.state === 'string' && value.state !== '') prior.state = value.state
    prior.at = Date.now()
    if (branch !== undefined) prior.branch = branch
    if (typeof value.number === 'number') {
      prior.number = value.number
      prior.url = value.url
      prior.title = value.title
    }
    return
  }
  const ordered = Object.entries(links).sort((a, b) => Number(a[1]?.at ?? 0) - Number(b[1]?.at ?? 0))
  if (ordered.length >= LINK_LIMIT) {
    for (const [key] of ordered.slice(0, ordered.length - LINK_LIMIT + 1)) delete links[key]
  }
  links[sessionId] = {
    cwd,
    ownerRepo: value.ownerRepo,
    branch,
    number: typeof value.number === 'number' ? value.number : undefined,
    url: value.url,
    title: value.title,
    state: value.state,
    at: Date.now(),
  }
  writeChain = writeChain.then(writeLinks, writeLinks)
  await writeChain.catch(() => {})
}

/**
 * Re-query a remembered identity, for sessions whose checkout is gone.
 *
 * The branch is the primary key, exactly as on the live path; the remembered
 * PR number is only a fallback, for a branch that has since been deleted
 * upstream.
 *
 * @param {string} sessionId - session id.
 * @param {string} [onlyCwd] - when set, the link must belong to this checkout.
 * @returns {Promise<Record<string, unknown> | undefined>} the payload.
 */
async function resolveByLink(sessionId, onlyCwd) {
  const links = await readLinks()
  const link = links[sessionId]
  if (link === undefined || typeof link.ownerRepo !== 'string') return undefined
  if (onlyCwd !== undefined && typeof link.cwd === 'string' && link.cwd !== onlyCwd) return undefined

  const fields = 'number,state,isDraft,url,title,mergedAt'
  let pr
  let via = 'branch'

  if (typeof link.branch === 'string' && link.branch !== '') {
    const rows = await listPrs(link.ownerRepo, link.branch)
    if (rows !== undefined) pr = pickPr(rows)
  }

  if (pr === undefined && typeof link.number === 'number') {
    const viewed = await viewPr({ ownerRepo: link.ownerRepo, number: link.number })
    if (viewed === undefined) return undefined
    link.state = viewed.state
    return { ...viewed, cwd: link.cwd, branch: link.branch, via: 'link' }
  }

  const state = displayState(pr)
  if (state === null) return undefined
  link.state = state
  if (typeof pr.number === 'number') {
    link.number = pr.number
    link.url = pr.url
    link.title = pr.title
  }
  return {
    state,
    cwd: link.cwd,
    branch: link.branch,
    ownerRepo: link.ownerRepo,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    isDraft: pr.isDraft === true,
    mergedAt: pr.mergedAt ?? null,
    via,
  }
}

/**
 * Read one session's transcript, decoding every appended zstd frame.
 *
 * The log is written as one zstd frame per appended chunk, so a whole-file
 * decode stops after the first frame; the frames are split on their magic
 * number instead. Oversized transcripts are skipped rather than loaded.
 *
 * @param {string} sessionId - session id.
 * @returns {Promise<string | undefined>} the transcript text, when readable.
 */
async function readTranscript(sessionId) {
  const root = join(dshHome(), 'sessions')
  const ids = sessionId.startsWith('session-') ? [sessionId] : [sessionId, `session-${sessionId}`]
  let slugs
  try {
    slugs = await readdir(root)
  } catch {
    return undefined
  }
  for (const slug of slugs) {
    for (const id of ids) {
      for (const name of ['session.v4.jsonl.zstd', 'session.jsonl.zstd', 'session.jsonl']) {
        const path = join(root, slug, id, name)
        if (!await exists(path)) continue
        let bytes
        try {
          bytes = await readFile(path)
        } catch {
          continue
        }
        if (bytes.length > 64 * 1024 * 1024) return undefined
        if (!name.endsWith('.zstd')) return bytes.toString('utf8')
        const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
        const starts = []
        let cursor = 0
        while ((cursor = bytes.indexOf(magic, cursor)) !== -1) {
          starts.push(cursor)
          cursor += magic.length
        }
        const chunks = []
        let total = 0
        for (let index = 0; index < starts.length; index += 1) {
          const frame = bytes.subarray(starts[index], index + 1 < starts.length ? starts[index + 1] : bytes.length)
          try {
            const decoded = zstdDecompressSync(frame)
            total += decoded.length
            if (total > 64 * 1024 * 1024) break
            chunks.push(decoded)
          } catch {
            // A truncated final frame is expected while the session is live.
          }
        }
        return Buffer.concat(chunks).toString('utf8')
      }
    }
  }
  return undefined
}

/** A pull request URL, captured once. */
const PR_URL = /https:\/\/github\.com\/([^/\s"\\,]+)\/([^/\s"\\,]+)\/pull\/(\d+)/

/** A workflow that opens a pull request. */
const PR_CREATE = /\bgh\s+pr\s+create\b/

/**
 * The exact shape of `gh pr create` output: one bare URL and nothing else.
 * Anchoring matters — a debug command that merely *prints* a PR URL, or prose
 * that quotes one, must not look like a pull request being opened.
 */
const PR_OUTPUT = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/

/**
 * Recover the PR a session itself opened, from its transcript.
 *
 * This covers the case the filesystem cannot: the agent cloned a repository
 * into a temporary directory, ran `gh pr create`, and that checkout is gone by
 * the time the sidebar renders. The transcript is parsed as events, so only a
 * real bash invocation of `gh pr create` counts and the URL is read from that
 * call's own result — a PR merely mentioned in prose, or a documentation
 * example, cannot match.
 *
 * @param {string} sessionId - session id.
 * @returns {Promise<{ ownerRepo: string, number: number } | undefined>} identity.
 */
async function prFromTranscript(sessionId) {
  await loadScanned()
  if (scanned.has(sessionId)) return undefined
  const missed = transcriptMiss.get(sessionId)
  if (missed !== undefined && Date.now() - missed < TRANSCRIPT_MISS_MS) return undefined

  const text = await readTranscript(sessionId)
  if (text === undefined) return undefined

  /** callId → seq of the `gh pr create` call still waiting for its result. */
  const pending = new Map()
  let chosen
  let chosenSeq = -1

  for (const line of text.split('\n')) {
    if (line === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type === 'tool/call') {
      const callId = event.data?.callId
      const raw = typeof event.data?.arguments === 'string' ? event.data.arguments : ''
      if (typeof callId !== 'string' || raw === '') continue
      let command = raw
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed?.command === 'string') command = parsed.command
        else command = JSON.stringify(parsed)
      } catch {
        command = raw
      }
      if (PR_CREATE.test(command)) pending.set(callId, Number(event.seq ?? 0))
      continue
    }
    if (event?.type !== 'tool/result') continue
    const message = event.data?.message
    const callId = message?.toolCallId
    if (typeof callId !== 'string' || !pending.has(callId)) continue
    const body = (Array.isArray(message?.content) ? message.content : [])
      .map(part => (typeof part?.text === 'string' ? part.text : ''))
      .join('\n')
      .trim()
    const seq = pending.get(callId)
    pending.delete(callId)
    // Only the create call's own output counts, and only in gh's exact shape.
    if (!PR_OUTPUT.test(body)) continue
    const match = PR_URL.exec(body)
    if (match === null) continue
    if (seq > chosenSeq) {
      chosenSeq = seq
      chosen = { ownerRepo: `${match[1]}/${match[2]}`, number: Number(match[3]) }
    }
  }

  if (chosen === undefined) {
    await markScanned(sessionId)
    if (transcriptMiss.size > CACHE_LIMIT) transcriptMiss.clear()
    transcriptMiss.set(sessionId, Date.now())
  }
  return chosen
}

/**
 * Cached `gh pr list --head <branch>` rows for one repository.
 * @param {string} ownerRepo - repository slug.
 * @param {string} branch - head branch name.
 * @returns {Promise<Array<Record<string, unknown>> | undefined>} the rows.
 */
async function listPrs(ownerRepo, branch) {
  const key = `${ownerRepo}::${branch}`
  const hit = listCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < TTL_MS) return hit.rows
  const out = await run(
    'gh',
    ['pr', 'list', '--repo', ownerRepo, '--head', branch,
      '--state', 'all', '--limit', '10',
      '--json', 'number,state,isDraft,url,title,mergedAt'],
    dshHome(),
  )
  if (out === undefined) return undefined
  let rows
  try {
    rows = JSON.parse(out)
  } catch {
    return undefined
  }
  if (!Array.isArray(rows)) return undefined
  if (listCache.size > CACHE_LIMIT) listCache.clear()
  listCache.set(key, { at: Date.now(), rows })
  return rows
}

/**
 * Query one PR by identity.
 * @param {{ ownerRepo: string, number: number }} identity - PR identity.
 * @returns {Promise<Record<string, unknown> | undefined>} the payload.
 */
async function viewPr({ ownerRepo, number }) {
  const key = `${ownerRepo}#${number}`
  const hit = prCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < TTL_MS) return hit.value
  const out = await run(
    'gh',
    ['pr', 'view', String(number), '--repo', ownerRepo,
      '--json', 'number,state,isDraft,url,title,mergedAt'],
    dshHome(),
  )
  if (out === undefined) return undefined
  let pr
  try {
    pr = JSON.parse(out)
  } catch {
    return undefined
  }
  const state = displayState(pr)
  if (state === null) return undefined
  const value = {
    state,
    ownerRepo,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    isDraft: pr.isDraft === true,
    mergedAt: pr.mergedAt ?? null,
  }
  if (prCache.size > CACHE_LIMIT) prCache.clear()
  prCache.set(key, { at: Date.now(), value })
  return value
}

/**
 * The last state this session was known to have.
 *
 * Codex keeps more than an identity in its thread attachment payload — it keeps
 * the observed state, so a dropped connection changes nothing on screen. This
 * is that same fallback: the identity gets us the PR, the stored state gets us
 * through a network outage.
 *
 * @param {string} sessionId - session id.
 * @returns {Promise<Record<string, unknown> | undefined>} a stale payload.
 */
async function lastKnown(sessionId) {
  const links = await readLinks()
  const link = links[sessionId]
  if (link === undefined) return undefined
  const state = link.state
  if (typeof state !== 'string' || state === '') return undefined
  return {
    state,
    cwd: link.cwd,
    branch: link.branch,
    ownerRepo: link.ownerRepo,
    number: link.number,
    url: link.url,
    title: link.title,
    observedAt: link.at ?? null,
    via: 'cache',
    stale: true,
  }
}

/**
 * Resolve the current PR of one session.
 *
 * Three sources, in order: the live checkout, the identity remembered from an
 * earlier live checkout, and finally the session's own transcript (for work an
 * agent did in a temporary clone). Codex keeps the same split — identity
 * recorded, state always queried.
 *
 * @param {string} sessionId - session id.
 * @returns {Promise<Record<string, unknown>>} the payload served to the chip.
 */
async function resolveSession(sessionId) {
  const cwd = await cwdOf(sessionId)
  const cwdPresent = cwd !== undefined && await exists(cwd)
  if (cwd !== undefined && cwdPresent) {
    const value = await resolveCwd(cwd)
    // Record the identity even when no PR is open yet, so the chip can still
    // appear after this checkout is archived or cleaned up.
    await rememberLink(sessionId, cwd, value)
    if (value.state !== null) return value
    const linked = await resolveByLink(sessionId, cwd)
    if (linked !== undefined) return linked
    const discovered = await prFromTranscript(sessionId)
    if (discovered !== undefined) {
      const viewed = await viewPr(discovered)
      if (viewed !== undefined) {
        await rememberLink(sessionId, cwd, viewed)
        await markScanned(sessionId)
        return { ...viewed, cwd, via: 'transcript' }
      }
    }
    return (await lastKnown(sessionId)) ?? value
  }
  const linked = await resolveByLink(sessionId)
  if (linked !== undefined) return linked
  const discovered = await prFromTranscript(sessionId)
  if (discovered !== undefined) {
    const viewed = await viewPr(discovered)
    if (viewed !== undefined) return { ...viewed, cwd, via: 'transcript' }
  }
  const cached = await lastKnown(sessionId)
  if (cached !== undefined) return cached
  return { state: null, reason: cwd === undefined ? 'no-workspace' : 'workspace-missing', cwd }
}

/**
 * Append one diagnostic line, so a running host can be inspected without a
 * browser session. Best effort: a probe must never break a response.
 * @param {string} name - file name inside the plugin's store directory.
 * @param {Record<string, unknown>} entry - the record to append.
 */
async function probe(name, entry) {
  try {
    const dir = join(dshHome(), 'pr-chip')
    await mkdir(dir, { recursive: true })
    const path = join(dir, name)
    let prior = ''
    try {
      const text = await readFile(path, 'utf8')
      prior = text.length > 64 * 1024 ? text.slice(-32 * 1024) : text
    } catch {
      prior = ''
    }
    await writeFile(path, `${prior}${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // Diagnostics are optional.
  }
}

/** Session ids whose log has already been backfilled once. */
const scanned = new Set()
let scannedLoaded = false

/** Path of the backfill ledger. */
function scannedPath() {
  return join(dshHome(), 'pr-chip', 'scanned.json')
}

/**
 * Load the backfill ledger once, so a scan runs at most once per session for
 * the lifetime of the install rather than once per poll interval.
 * @returns {Promise<void>} resolves when the ledger is in memory.
 */
async function loadScanned() {
  if (scannedLoaded) return
  scannedLoaded = true
  try {
    const parsed = JSON.parse(await readFile(scannedPath(), 'utf8'))
    if (Array.isArray(parsed?.sessions)) for (const id of parsed.sessions) scanned.add(id)
  } catch {
    // No ledger yet.
  }
}

/**
 * Record that a session's log has been backfilled.
 * @param {string} sessionId - session id.
 */
async function markScanned(sessionId) {
  scanned.add(sessionId)
  if (scanned.size > 5000) return
  try {
    const dir = join(dshHome(), 'pr-chip')
    await mkdir(dir, { recursive: true })
    const temporary = join(dir, 'scanned.json.tmp')
    await writeFile(temporary, JSON.stringify({ sessions: [...scanned] }), 'utf8')
    await rename(temporary, scannedPath())
  } catch {
    // The ledger is an optimization; losing it only costs one rescan.
  }
}

/** `sessionId\u0000callId` of a live `gh pr create` call whose result is due. */
const liveCreates = new Map()

/**
 * Watch live session events for `gh pr create` and record the PR it returns.
 *
 * This is the event-driven half: the identity is captured when the call
 * happens, exactly as Codex attaches a pull request to its thread at creation
 * time. `tool/call` tells us the command, `tool/result` carries the output of
 * that same call id — so the pairing is structural, never a text guess.
 *
 * @param {{ id: string }} session - the emitting session.
 * @param {{ type: string, data?: any }} event - one session event.
 */
function onSessionEvent(session, event) {
  const sessionId = session?.id
  if (typeof sessionId !== 'string') return
  if (event?.type === 'tool/call') {
    const callId = event.data?.callId
    const raw = typeof event.data?.arguments === 'string' ? event.data.arguments : ''
    if (typeof callId !== 'string' || raw === '') return
    let command = raw
    try {
      const parsed = JSON.parse(raw)
      command = typeof parsed?.command === 'string' ? parsed.command : JSON.stringify(parsed)
    } catch {
      command = raw
    }
    if (PR_CREATE.test(command)) liveCreates.set(`${sessionId}\u0000${callId}`, Date.now())
    return
  }
  if (event?.type !== 'tool/result') return
  const callId = event.data?.message?.toolCallId
  if (typeof callId !== 'string') return
  const key = `${sessionId}\u0000${callId}`
  if (!liveCreates.has(key)) return
  liveCreates.delete(key)
  const body = (Array.isArray(event.data?.message?.content) ? event.data.message.content : [])
    .map(part => (typeof part?.text === 'string' ? part.text : ''))
    .join('\n')
    .trim()
  if (!PR_OUTPUT.test(body)) return
  const match = PR_URL.exec(body)
  if (match === null) return
  const identity = { ownerRepo: `${match[1]}/${match[2]}`, number: Number(match[3]) }
  void (async () => {
    // cwd is a convenience, not a requirement: the identity is what matters,
    // and it stays usable after that checkout is long gone.
    const cwd = await cwdOf(sessionId)
    await rememberLink(sessionId, cwd, { ...identity, url: body, state: 'open' })
  })()
}

/**
 * Serve `GET <prefix>/status?sessionId=…`.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handler(req, res) {
  const send = (status, payload) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method !== 'GET' || !url.pathname.endsWith('/status')) {
    send(405, { ok: false, error: 'unsupported route' })
    return
  }
  const sessionId = url.searchParams.get('sessionId') ?? ''
  if (sessionId === '') {
    send(400, { ok: false, error: 'expected ?sessionId=' })
    return
  }
  try {
    const value = await resolveSession(sessionId)
    send(200, { ok: true, ...value, fetchedAt: Date.now() })
  } catch (error) {
    send(500, { ok: false, error: String(error?.message ?? error) })
  }
}

/** Internals exposed for local verification only. */
export const __test = { cwdOf, cwdFromSessionDir, decodeSlug, readTranscript, prFromTranscript, resolveSession, lastKnown,
  branchOf, pickPr, displayState, resolve, resolveCwd, resolveSession, identityOf, rememberLink, resolveByLink, readLinks, handler }

/**
 * Plugin entry: register the route family.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 */
export function apply(ctx) {
  void probe('host-loaded.jsonl', { at: Date.now(), route: ROUTE_PREFIX, version: '0.0.1' })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    'pr-chip: routes',
  )
  ctx.effect(() => ctx.on('session/event', onSessionEvent, { global: true }), 'pr-chip: session events')
}
