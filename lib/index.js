/**
 * dsh-symlink-passthrough — let the DSH sidebar file tree expand and open
 * symbolic links (including Windows junctions) inside the session workspace,
 * judged by where the link points:
 *   - target inside the workspace          -> allowed
 *   - target outside the workspace         -> only when the workspace is trusted
 *                                             and the target is not on the denied list
 *   - dsh-workspace-trust not installed    -> official behavior (refused)
 * Trust, the denied list and the workspace root all come from dsh-workspace-trust
 * (`ctx.workspaceTrust.findRoot / checkResolved`); this plugin decides nothing itself.
 *
 * Official behavior (@deepseek-ai/dsh-api-workspace-files, dsh-fs-local 0.2.x):
 *   - `list` -> `confine(root, workspaceRoot, path, signal)` refuses a target whose
 *     real path is outside the session cwd (`workspace-file/outside-workspace`).
 *   - `changes` -> `feed.follow(workspaceRoot, path, signal)` re-checks
 *     `fs.contains(root, target)` (synchronous) on every directory change.
 *   - `read` / `readBytes` / `stat` -> `locateFile` refuses a final symlink
 *     component (`workspace-file/not-regular-file`, kind `symlink`).
 * Wrapped here: `confine` and `locateFile` (async: the trust check runs inline),
 * `feed.follow` (async check once, then a pass for this exact root/target pair)
 * and `fs.contains` (sync: original result, or a live pass). Agent reads and
 * writes never go through these methods.
 * Refusals by the trust plugin are thrown as `workspace-file/outside-workspace`
 * carrying its bilingual reason (directory watches too, since the sidebar shows
 * a failed watch's message in place of the listing error).
 *
 * Only paths spelled inside the workspace without `..` segments qualify, so the
 * plugin never widens access to arbitrary absolute paths.
 */
import { isAbsolute, relative, sep } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

export const name = 'symlink-passthrough'
export const inject = ['fs']

const LOG = '[symlink-passthrough]'
const MARKS = {
  contains: Symbol.for('dsh-symlink-passthrough/contains'),
  confine: Symbol.for('dsh-symlink-passthrough/confine'),
  locateFile: Symbol.for('dsh-symlink-passthrough/locateFile'),
  follow: Symbol.for('dsh-symlink-passthrough/follow'),
}
const isWin = process.platform === 'win32'
const keyOf = (p) => (isWin ? String(p).toLowerCase() : String(p))

function hasParentSegment(path) {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(path)
}

/** Lexical containment of two absolute path strings; any `..` segment refuses. */
export function spelledInside(base, target) {
  if (typeof base !== 'string' || typeof target !== 'string') return false
  if (!isAbsolute(base) || !isAbsolute(target)) return false
  if (hasParentSegment(base) || hasParentSegment(target)) return false
  const rel = relative(base, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const isOutsideRefusal = (error) => error?.code === 'workspace-file/outside-workspace'
const isSymlinkRefusal = (error) => error?.code === 'workspace-file/not-regular-file' && error?.details?.kind === 'symlink'

/** Replace `owner[key]`; returns a restore function. Leaves foreign outer layers alone. */
function wrapMethod(owner, key, mark, build) {
  const original = owner[key]
  const hadOwn = Object.hasOwn(owner, key)
  let active = true
  const wrapper = build(original, () => active)
  owner[key] = wrapper
  owner[mark] = true
  return () => {
    active = false
    if (Object.getOwnPropertyDescriptor(owner, key)?.value === wrapper) {
      if (hadOwn) owner[key] = original
      else delete owner[key]
    }
    delete owner[mark]
  }
}

/**
 * Decision core, independent of DSH wiring (exported for tests).
 * @param getTrust - returns `ctx.workspaceTrust` or undefined.
 */
export function createGate(getTrust) {
  const passes = new Map() // `${rootKey}\0${targetKey}` -> count

  /**
   * @param cwd - session workspace root (header cwd).
   * @param spelled - absolute path as requested (link location).
   * @param real - real path the link resolves to.
   * @returns undefined when allowed, otherwise the refusal message.
   */
  async function check(cwd, spelled, real) {
    const trust = getTrust()
    if (trust === undefined) return null
    let root
    try { root = await trust.findRoot(cwd) } catch { return null }
    if (!spelledInside(root, spelled) && !spelledInside(cwd, spelled)) return null
    const result = await trust.checkResolved(root, real)
    return result.ok ? undefined : result.message
  }

  return {
    check,
    grant(rootKey, targetKey) {
      const key = `${keyOf(rootKey)}\0${keyOf(targetKey)}`
      passes.set(key, (passes.get(key) ?? 0) + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const n = (passes.get(key) ?? 1) - 1
        if (n <= 0) passes.delete(key)
        else passes.set(key, n)
      }
    },
    has(rootKey, targetKey) {
      return passes.has(`${keyOf(rootKey)}\0${keyOf(targetKey)}`)
    },
    clear() { passes.clear() },
    get size() { return passes.size },
  }
}

const OUTSIDE = 'workspace-file/outside-workspace'

/**
 * The trust refusal to throw instead of `error`: `outside-workspace` with the
 * trust plugin's bilingual reason. Sidebar clients show an unrecognized code's
 * message ("Read failed: <message>"), so file links use this code too rather
 * than `not-regular-file`, whose fixed text hides the reason.
 * `message` null/undefined (no trust plugin, or not ours to judge) keeps `error`.
 */
function refusal(error, message, path) {
  if (typeof message !== 'string') return error
  return new RemoteError(OUTSIDE, message, { path }, error === undefined ? undefined : { cause: error })
}

export function apply(ctx, config = {}) {
  const info = (m) => ctx.logger?.info?.(`${LOG} ${m}`)
  const warn = (m) => ctx.logger?.warn?.(`${LOG} ${m}`)
  if (config?.enabled === false) {
    info('disabled by config; nothing patched')
    return
  }
  const gate = createGate(() => ctx.get('workspaceTrust'))
  let fsRef

  ctx.on('workspace-trust/changed', () => { gate.clear() })

  // Synchronous containment used by directory watches: original, or a live pass.
  ctx.inject(['fs'], (scope) => {
    const fs = scope.fs
    fsRef = fs
    if (typeof fs?.contains !== 'function') {
      warn('ctx.fs.contains is missing; directory watches through links stay refused')
      return
    }
    if (fs[MARKS.contains] === true) return
    const processPath = (t) => (typeof fs.processPath === 'function' ? fs.processPath(t) : t?.targetKey)
    return wrapMethod(fs, 'contains', MARKS.contains, (original, isActive) =>
      function contains(parent, child) {
        if (original.call(this, parent, child)) return true
        return isActive() && gate.has(processPath(parent), processPath(child))
      })
  })

  ctx.inject(['workspaceFiles'], (scope) => {
    const wf = scope.workspaceFiles
    const restores = []
    const fsOf = (self) => self?.ctx?.fs ?? fsRef
    const realOf = (fs, target) => (typeof fs.processPath === 'function' ? fs.processPath(target) : target.targetKey)

    // list: directory links.
    if (typeof wf?.confine === 'function' && wf[MARKS.confine] !== true) {
      restores.push(wrapMethod(wf, 'confine', MARKS.confine, (original, isActive) =>
        async function confine(root, workspaceRoot, path, signal) {
          try {
            return await original.call(this, root, workspaceRoot, path, signal)
          } catch (error) {
            if (!isActive() || !isOutsideRefusal(error)) throw error
            const fs = fsOf(this)
            let target
            try { target = await fs.resolve(path, { cwd: workspaceRoot, signal }) } catch (cause) {
              if (signal?.aborted) throw cause
              throw error
            }
            const denied = await gate.check(workspaceRoot, target.displayPath, realOf(fs, target))
            if (denied === undefined) return target
            throw refusal(error, denied, path)
          }
        }))
    } else warn('workspaceFiles.confine is missing; directory links stay refused')

    // read / readBytes / stat: file links.
    if (typeof wf?.locateFile === 'function' && wf[MARKS.locateFile] !== true) {
      restores.push(wrapMethod(wf, 'locateFile', MARKS.locateFile, (original, isActive) =>
        async function locateFile(workspaceFileScope, path, signal) {
          try {
            return await original.call(this, workspaceFileScope, path, signal)
          } catch (error) {
            if (!isActive() || !isSymlinkRefusal(error)) throw error
            const fs = fsOf(this)
            let target, stat
            try {
              target = await fs.resolve(path, { cwd: workspaceFileScope.workspaceRoot, signal })
              stat = await fs.stat(target, signal)
            } catch (cause) {
              if (signal?.aborted) throw cause
              throw error
            }
            if (stat?.type !== 'file') throw error
            const denied = await gate.check(workspaceFileScope.workspaceRoot, target.displayPath, realOf(fs, target))
            if (denied === undefined) return { target, info: stat }
            throw refusal(error, denied, path)
          }
        }))
    } else warn('workspaceFiles.locateFile is missing; file links stay refused')

    // changes: directory watches re-check `fs.contains` on every change.
    const feed = wf?.feed
    if (typeof feed?.follow === 'function' && feed[MARKS.follow] !== true) {
      restores.push(wrapMethod(feed, 'follow', MARKS.follow, (original, isActive) =>
        async function* follow(workspaceRoot, path, signal) {
          let release, denied
          if (isActive()) {
            try {
              const fs = fsOf(scope.workspaceFiles) ?? fsRef
              const root = await fs.resolve(workspaceRoot, { signal })
              const target = await fs.resolve(path, { cwd: workspaceRoot, signal })
              const stat = await fs.stat(target, signal)
              if (stat?.type === 'directory' && !fs.contains(root, target)) {
                denied = await gate.check(workspaceRoot, target.displayPath, realOf(fs, target))
                if (denied === undefined) release = gate.grant(realOf(fs, root), realOf(fs, target))
              }
            } catch { denied = undefined /* the original reports its own errors */ }
          }
          // The sidebar shows a failed watch as "Read failed: <message>", replacing the
          // listing's error; refuse here so it carries the reason, not the official text.
          if (typeof denied === 'string') throw refusal(undefined, denied, path)
          try {
            yield* original.call(this, workspaceRoot, path, signal)
          } finally {
            release?.()
          }
        }))
    } else warn('workspaceFiles.feed.follow is missing; directory watches through links stay refused')

    info('patched: links are allowed by target (inside the workspace, or outside when trusted)')
    return () => { for (const r of restores.reverse()) r() }
  })
}
