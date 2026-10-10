// Self-test for dsh-symlink-passthrough against the official classes on real links.
//   DSH_PACKAGES=<DSH install node_modules> TRUST_PLUGIN=<dsh-workspace-trust dir> node test/selftest.mjs
// - LocalFileSystem (dsh-fs-local) and WorkspaceFiles (dsh-api-workspace-files) are
//   the real implementations, built with Object.create so no Cordis tree is needed.
// - The trust service is the real dsh-workspace-trust `createWorkspaceTrust`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const PACKAGES = process.env.DSH_PACKAGES;
const TRUST = process.env.TRUST_PLUGIN;
if (!PACKAGES || !fs.existsSync(PACKAGES) || !TRUST || !fs.existsSync(TRUST)) {
  console.log('set DSH_PACKAGES (DSH install node_modules) and TRUST_PLUGIN (dsh-workspace-trust checkout)');
  process.exit(2);
}
const anchor = pathToFileURL(path.join(PACKAGES, '__anchor__.js')).href;
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); } catch (error) {
      if (/^[@a-z]/i.test(specifier) && !specifier.startsWith('node:')) return next(specifier, { ...context, parentURL: anchor });
      throw error;
    }
  },
});

const plugin = await import('../lib/index.js');
const { LocalFileSystem } = await import('@deepseek-ai/dsh-fs-local');
const { WorkspaceFiles } = await import('@deepseek-ai/dsh-api-workspace-files');
const { createWorkspaceTrust } = await import(pathToFileURL(path.join(TRUST, 'lib', 'index.js')).href);

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else failures.push(`${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}
const outcome = async (fn) => { try { return await fn(); } catch (e) { return e; } };

// ---------------------------------------------------------------- fixtures
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'symlink-')));
const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (p, s = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };
const link = (target, at, type) => { try { fs.symlinkSync(target, at, type); return true; } catch { return false; } };

const repo = mk('repo'); mk('repo', '.git');
const cwd = mk('repo', 'app');                 // session cwd, below the git root
const sibling = mk('repo', 'shared'); write(path.join(sibling, 'lib.txt'), 'shared');
const outside = mk('outside'); write(path.join(outside, 'doc.txt'), 'outside');
const secret = mk('secret'); write(path.join(secret, 'key.txt'), 'key');
write(path.join(cwd, 'real.txt'), 'real');
link(outside, path.join(cwd, 'out-dir'), 'junction');
link(sibling, path.join(cwd, 'sib-dir'), 'junction');
link(secret, path.join(cwd, 'secret-dir'), 'junction');
const fileLinks = link(path.join(outside, 'doc.txt'), path.join(cwd, 'out-file.txt'), 'file')
  && link(path.join(secret, 'key.txt'), path.join(cwd, 'secret-file.txt'), 'file');

// ---------------------------------------------------------------- real services
function host({ withTrust = true, feed } = {}) {
  const dshHome = mk(`home-${Math.random().toString(36).slice(2)}`);
  const emitted = [];
  const { service: trust } = createWorkspaceTrust(
    { dshHome, deniedPaths: [secret], useDefaultDeniedPaths: false, env: {}, home: tmp },
    { get: () => undefined, emit: (e, p) => emitted.push([e, p]), logger: {} },
  );
  const localFs = Object.create(LocalFileSystem.prototype);
  Object.assign(localFs, { config: { cwd, diffBasisMaxBytes: 1 << 20 }, internals: {}, locks: new Map(), ctx: { logger: console } });
  const wf = Object.create(WorkspaceFiles.prototype);
  const listeners = {};
  const wfCtx = { fs: localFs, logger: console, on: (e, cb) => { listeners[e] = cb; }, effect: () => {} };
  Object.assign(wf, { ctx: wfCtx, config: { maxLines: 2000, maxBytes: 1 << 20, maxEntries: 1000, maxFileBytes: 1 << 20 } });
  wf.feed = feed?.(localFs) ?? { async *follow() {} };
  const pluginListeners = {};
  const disposers = [];
  const warnings = [];
  plugin.apply({
    logger: { info() {}, warn: (m) => warnings.push(m) },
    get: (n) => (n === 'workspaceTrust' && withTrust ? trust : undefined),
    on: (e, cb) => { pluginListeners[e] = cb; },
    inject(deps, fn) {
      if (deps.includes('workspaceFiles')) disposers.push(fn({ workspaceFiles: wf }));
      else if (deps.includes('fs')) disposers.push(fn({ fs: localFs }));
    },
  }, {});
  return { trust, fs: localFs, wf, emitted, warnings, pluginListeners, dispose: () => disposers.reverse().forEach((d) => typeof d === 'function' && d()) };
}

const scope = { sessionId: 's', workspaceRoot: cwd };

// ---------------------------------------------------------------- unit: spelling / gate
check('spelled: inside', plugin.spelledInside(cwd, path.join(cwd, 'a', 'b')), true);
check('spelled: outside', plugin.spelledInside(cwd, outside), false);
check('spelled: dotdot refused', plugin.spelledInside(cwd, `${cwd}${path.sep}a${path.sep}..${path.sep}b`), false);
check('spelled: relative refused', plugin.spelledInside(cwd, 'a'), false);
{
  const gate = plugin.createGate(() => undefined);
  const r1 = gate.grant('C:\\A', 'C:\\B');
  const r2 = gate.grant('C:\\A', 'C:\\B');
  check('gate: granted', gate.has('C:\\A', 'C:\\B'), true);
  r1();
  check('gate: counted', gate.has('C:\\A', 'C:\\B'), true);
  r2();
  check('gate: released', gate.has('C:\\A', 'C:\\B'), false);
  gate.grant('x', 'y');
  gate.clear();
  check('gate: clear', gate.size, 0);
  check('gate: no trust -> null', await gate.check(cwd, path.join(cwd, 'out-dir'), outside), null);
}

// ---------------------------------------------------------------- list (confine)
{
  const h = host();
  const listNames = async (p) => { const r = await outcome(() => h.wf.list(scope, p)); return r instanceof Error ? `${r.code}: ${r.message}` : r.entries.map((e) => e.name); };
  check('list: plain dir unaffected', await listNames('.'), (await h.wf.list(scope, '.')).entries.map((e) => e.name));
  check('list: sibling in repo, untrusted -> allowed', await listNames('sib-dir'), ['lib.txt']);
  const r = await listNames('out-dir');
  check('list: outside untrusted -> refused w/ hint', [r.startsWith('workspace-file/outside-workspace'), r.includes('/workspace-trust trust')], [true, true]);
  await h.trust.set(repo, 'trusted');
  check('list: outside trusted -> allowed', await listNames('out-dir'), ['doc.txt']);
  const s = await listNames('secret-dir');
  check('list: denied even when trusted', [s.startsWith('workspace-file/outside-workspace'), s.includes('禁止访问')], [true, true]);
  const abs = await outcome(() => h.wf.list(scope, outside));
  check('list: absolute outside path still refused', abs.code, 'workspace-file/outside-workspace');
  h.dispose();
  const after = await outcome(() => h.wf.list(scope, 'out-dir'));
  check('list: after dispose -> official refusal', [after.code, after.message.includes('workspace-trust')], ['workspace-file/outside-workspace', false]);
}

// ---------------------------------------------------------------- read (locateFile)
if (fileLinks) {
  const h = host();
  const read = async (p) => { const r = await outcome(() => h.wf.read(scope, p, {})); return r instanceof Error ? `${r.code}: ${r.message}` : r.text; };
  check('read: real file', await read('real.txt'), 'real');
  const r = await read('out-file.txt');
  // outside-workspace, not not-regular-file: the preview shows only the former's message
  check('read: file link outside untrusted -> refused w/ hint', [r.startsWith('workspace-file/outside-workspace'), r.includes('/workspace-trust trust')], [true, true]);
  const st = await outcome(() => h.wf.stat(scope, 'out-file.txt'));
  check('stat: file link outside untrusted -> same refusal', [st.code, st.details?.path], ['workspace-file/outside-workspace', 'out-file.txt']);
  await h.trust.set(repo, 'trusted');
  check('read: file link outside trusted -> allowed', await read('out-file.txt'), 'outside');
  const sf = await read('secret-file.txt');
  check('read: file link to denied -> refused', [sf.startsWith('workspace-file/outside-workspace'), sf.includes('禁止访问')], [true, true]);
  const d = await outcome(() => h.wf.read(scope, 'out-dir', {}));
  check('read: dir link as file -> official error', [d.code, d.details?.kind], ['workspace-file/not-regular-file', 'symlink']);
  h.dispose();
} else {
  console.log('note: file symlinks unavailable here; file-link cases skipped');
}

// ---------------------------------------------------------------- contains + pass (changes)
{
  // the official feed re-checks fs.contains on every change; a probe follow stands in for it
  const seen = [];
  let probe;
  const h = host({ feed: (localFs) => ({ async *follow(workspaceRoot, p) {
    const r = await localFs.resolve(workspaceRoot);
    const t = await localFs.resolve(p, { cwd: workspaceRoot });
    probe = { r, t };
    seen.push(localFs.contains(r, t));
    yield { kind: 'ready' };
  } }) });
  const drain = async (p) => { for await (const _ of h.wf.changes(scope, p, new AbortController().signal)) { /* drain */ } };
  const failed = async (p) => { const e = await outcome(() => drain(p)); return e instanceof Error ? `${e.code}: ${e.message}` : 'ok'; };
  const u = await failed('out-dir');
  check('changes: untrusted outside -> refused w/ hint, original not opened', [u.startsWith('workspace-file/outside-workspace'), u.includes('/workspace-trust trust'), seen.length], [true, true, 0]);
  check('changes: in-repo sibling untrusted -> watched, no refusal', [await failed('sib-dir'), seen.length], ['ok', 1]);
  check('changes: plain dir -> original only', [await failed('.'), seen[1]], ['ok', true]);
  await h.trust.set(repo, 'trusted');
  await drain('out-dir');
  check('changes: trusted -> pass during watch', seen[2], true);
  check('changes: pass released after watch', h.fs.contains(probe.r, probe.t), false);
  const d = await failed('secret-dir');
  check('changes: denied -> refused w/ reason', [d.startsWith('workspace-file/outside-workspace'), d.includes('禁止访问'), seen.length], [true, true, 3]);
  // a trust change during a live watch revokes its pass immediately
  const gen = h.wf.changes(scope, 'out-dir', new AbortController().signal);
  await gen.next();
  check('changes: live pass before revoke', h.fs.contains(probe.r, probe.t), true);
  h.pluginListeners['workspace-trust/changed']({ root: repo, state: 'untrusted' });
  check('changes: trust change revokes live pass', h.fs.contains(probe.r, probe.t), false);
  await gen.return();
  h.dispose();
}

// ---------------------------------------------------------------- no trust plugin = official behavior
{
  const h = host({ withTrust: false });
  const r = await outcome(() => h.wf.list(scope, 'sib-dir'));
  check('no trust: in-repo sibling refused (official)', r.code, 'workspace-file/outside-workspace');
  const o = await outcome(() => h.wf.list(scope, 'out-dir'));
  check('no trust: outside refused, official message', [o.code, o.message.includes('workspace-trust')], ['workspace-file/outside-workspace', false]);
  h.dispose();
}

// ---------------------------------------------------------------- trust change clears passes; disabled
{
  const listeners = {};
  const gateCtx = { logger: { info() {}, warn() {} }, get: () => undefined, on: (e, cb) => { listeners[e] = cb; }, inject: () => {} };
  plugin.apply(gateCtx, {});
  check('wiring: listens for trust changes', typeof listeners['workspace-trust/changed'], 'function');
  let injected = 0;
  plugin.apply({ ...gateCtx, inject: () => { injected++; } }, { enabled: false });
  check('disabled: nothing injected', injected, 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  console.log(`FAIL ${failures.length} / ${passed + failures.length}`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log(`PASS ${passed}`);
