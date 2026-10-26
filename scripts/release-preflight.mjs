import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';

import { buildRelease } from './build-web.mjs';
import { productionReadiness } from './production-readiness.mjs';

const execFile = promisify(execFileCallback);
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const scriptPath = fileURLToPath(import.meta.url);

const EXPECTED = Object.freeze({
  bind: process.env.RELEASE_EXPECTED_BIND || '127.0.0.1',
  port: Number(process.env.RELEASE_EXPECTED_PORT || 17507),
  publicOrigin: process.env.RELEASE_EXPECTED_PUBLIC_ORIGIN || 'https://donego.udify.fun',
  serviceUnit: process.env.RELEASE_EXPECTED_SERVICE_UNIT || null,
  litellmUrl: process.env.RELEASE_EXPECTED_LITELLM_URL || 'http://127.0.0.1:4000/v1/chat/completions',
  litellmModel: process.env.RELEASE_EXPECTED_LITELLM_MODEL || 'auto'
});

const REQUIRED_ENV_NAMES = Object.freeze([
  'NODE_ENV', 'TANGO_HOST', 'TANGO_PORT', 'TANGO_PUBLIC_ORIGIN',
  'TANGO_AUTH_SECRET', 'EMAIL_TRANSPORT', 'MAIL_FROM', 'TANGO_COLLAB_DB',
  'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD',
  'LITELLM_URL', 'LITELLM_MODEL'
]);

const AI_FLAG_NAMES = Object.freeze([
  'TANGO_AI_ENABLED', 'TANGO_AI_PROVIDER', 'TANGO_AI_MODEL', 'TANGO_AI_MODE',
  'TANGO_AI_STREAMING', 'TANGO_LITELLM_ENABLED'
]);

const CAP_LIMIT_NAMES = Object.freeze([
  'TANGO_AI_MAX_TOKENS', 'TANGO_AI_MAX_OUTPUT_TOKENS', 'TANGO_AI_MAX_PROMPT_CHARS',
  'TANGO_AI_MAX_REQUEST_BYTES', 'TANGO_AI_MAX_RESPONSE_BYTES', 'TANGO_AI_DAILY_LIMIT',
  'TANGO_AI_VISITOR_DAILY_LIMIT', 'TANGO_AI_TOTAL_BUDGET', 'TANGO_AI_TIMEOUT_MS',
  'TANGO_AI_MAX_SECONDS'
]);

const DIRECT_TESTS = Object.freeze([
  'tests/unit/tango-release.test.mjs',
  'tests/unit/tango-release-rollback.test.mjs',
  'tests/unit/tango-production-readiness.test.mjs'
]);

function result(status, message, details = undefined) {
  return details === undefined ? { status, message } : { status, message, details };
}

function hasValue(name) {
  return typeof process.env[name] === 'string' && process.env[name].length > 0;
}

function envName(name) {
  return process.env[name] || '';
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args, options = {}) {
  try {
    const output = await execFile(command, args, {
      cwd: root,
      timeout: options.timeout ?? 5000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    return { ok: true, stdout: output.stdout, stderr: output.stderr };
  } catch (error) {
    return {
      ok: false,
      code: error?.code,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : ''
    };
  }
}

async function checkGit() {
  const branch = await run('git', ['branch', '--show-current']);
  const commit = await run('git', ['rev-parse', '--verify', 'HEAD']);
  const status = await run('git', ['status', '--porcelain']);
  const name = await run('git', ['config', '--get', 'user.name']);
  const email = await run('git', ['config', '--get', 'user.email']);
  const branchName = branch.stdout.trim();
  const commitId = commit.stdout.trim();
  const dirty = status.ok && status.stdout.trim().length > 0;
  if (!branch.ok || !commit.ok || !name.ok || !email.ok || !branchName || !commitId) {
    return result('FAIL', 'git branch, commit, and identity are required', {
      branch: branchName || null,
      commit: commitId || null,
      identityPresent: name.ok && email.ok && Boolean(name.stdout.trim()) && Boolean(email.stdout.trim())
    });
  }
  if (!status.ok) return result('FAIL', 'git state could not be read');
  if (dirty) return result('FAIL', 'working tree is dirty', { branch: branchName, commit: commitId, dirty: true });
  return result('VERIFIED', 'clean git state and configured identity', { branch: branchName, commit: commitId, dirty: false });
}

async function readPackage() {
  try {
    const packagePath = join(root, 'package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
    return { packagePath, packageJson };
  } catch {
    return null;
  }
}

async function checkDependencies(packageJson) {
  if (!packageJson) return result('FAIL', 'package.json is missing or invalid');
  if (!(await pathExists(join(root, 'node_modules')))) return result('FAIL', 'node_modules is absent');
  const dependencyNames = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
  const missing = [];
  for (const name of dependencyNames) {
    if (!(await pathExists(join(root, 'node_modules', ...name.split('/'))))) missing.push(name);
  }
  return missing.length === 0
    ? result('VERIFIED', 'declared dependencies are present', { count: dependencyNames.length })
    : result('FAIL', 'declared dependencies are missing', { missing });
}

function scriptTarget(command) {
  const match = String(command || '').match(/(?:^|\s)node(?:\s+[^\s]+)*\s+([^\s]+)/);
  return match?.[1] || null;
}

async function checkUnitReadiness(packageJson) {
  const scripts = packageJson?.scripts;
  if (!scripts || typeof scripts['test:unit'] !== 'string' || typeof scripts['verify:web'] !== 'string') {
    return result('FAIL', 'test:unit and verify:web scripts are required');
  }
  const target = scriptTarget(scripts['test:unit']);
  const targetPresent = target ? await pathExists(join(root, target)) : false;
  const testsPresent = await Promise.all(DIRECT_TESTS.map(path => pathExists(join(root, path))));
  if (!targetPresent || testsPresent.some(present => !present)) {
    return result('FAIL', 'unit command targets are incomplete', { testRunnerPresent: targetPresent, directTestsPresent: testsPresent.every(Boolean) });
  }
  return result('VERIFIED', 'unit command and direct release tests are ready', { testRunner: target, verifyWebPresent: true, directTests: DIRECT_TESTS });
}

async function syntaxCheck(paths) {
  const failures = [];
  for (const path of paths) {
    if (!(await pathExists(join(root, path)))) {
      failures.push(path);
      continue;
    }
    const checked = await run(process.execPath, ['--check', path]);
    if (!checked.ok) failures.push(path);
  }
  return failures.length === 0
    ? result('VERIFIED', 'Node syntax checks passed', { files: paths })
    : result('FAIL', 'Node syntax checks failed', { files: failures });
}

async function recursiveFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const relativePath = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await recursiveFiles(path, relativePath + '/'));
    else if (entry.isFile()) files.push(relativePath);
    else files.push(relativePath);
  }
  return files.sort();
}

async function validateManifest(directory, manifest) {
  if (!manifest || manifest.schema !== 1 || manifest.product !== 'tango-donego' || manifest.entry !== 'web/index.html' || manifest.scope !== 'local-user-test') {
    return result('FAIL', 'release manifest metadata is invalid');
  }
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(manifest.releaseDate || '') || typeof manifest.releaseId !== 'string' || !manifest.releaseId) {
    return result('FAIL', 'release manifest date or id is invalid');
  }
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    return result('FAIL', 'release manifest file map is invalid');
  }
  const listed = Object.keys(manifest.files).sort();
  const actual = await recursiveFiles(directory);
  const missing = [];
  const mismatched = [];
  for (const path of listed) {
    const filePath = join(directory, path);
    try {
      const bytes = await readFile(filePath);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== manifest.files[path]) mismatched.push(path);
    } catch {
      missing.push(path);
    }
  }
  const extras = actual.filter(path => !listed.includes(path) && path !== 'manifest.json' && path !== 'package.json');
  if (missing.length || mismatched.length || extras.length) return result('FAIL', 'release manifest does not match its files', { missing, mismatched, extras });
  const html = await readFile(join(directory, 'web/index.html'), 'utf8');
  const packaged = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const metadataOk = html.includes('Done&amp;Go') && html.includes('tango-time-core') && packaged?.scripts?.start === 'node scripts/serve-tango.mjs' && packaged?.scripts?.['verify:production'] === 'node scripts/production-readiness.mjs' && packaged?.dependencies?.nodemailer === '10.0.9';
  const topLevel = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const requiredDirectories = ['scripts', 'server', 'web'];
  if (!metadataOk || requiredDirectories.some(name => !topLevel.includes(name)) || !actual.includes('manifest.json') || !actual.includes('package.json')) return result('FAIL', 'release static metadata is incomplete');
  const packagedServer = await import(pathToFileURL(join(directory, 'scripts/serve-tango.mjs')).href);
  const server = packagedServer.createTangoServer();
  if (server.listening !== false) return result('FAIL', 'packaged server was not inert during preflight');
  return result('VERIFIED', 'temporary release build and SHA-256 manifest verified', { releaseId: manifest.releaseId, releaseDate: manifest.releaseDate, fileCount: listed.length });
}

async function checkBuild(blocked) {
  if (blocked) return result('UNKNOWN', 'build check skipped while release safety lock or freeze is active');
  let outputParent;
  try {
    outputParent = await mkdtemp(join(tmpdir(), 'donego-release-preflight-'));
    const release = await buildRelease({ outputParent });
    return await validateManifest(release.directory, release.manifest);
  } catch {
    return result('FAIL', 'temporary release build failed');
  } finally {
    if (outputParent) await rm(outputParent, { recursive: true, force: true });
  }
}

function shanghaiMinute(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  const minute = Number(parts.find(part => part.type === 'minute')?.value);
  return hour * 60 + minute;
}

async function checkSafety() {
  const lockPath = join(root, 'heavy.lock');
  const lockPresent = await pathExists(lockPath);
  const minute = shanghaiMinute();
  const freeze = minute >= 30 && minute < 210;
  const blocked = lockPresent || freeze;
  return {
    state: { lockPath, lockPresent, freeze, blocked },
    check: blocked ? result('BLOCKED', lockPresent && freeze ? 'heavy.lock and Shanghai freeze window are active' : lockPresent ? 'heavy.lock is active' : 'Asia/Shanghai release freeze window is active', { lockPath, freezeWindow: '00:30-03:30 Asia/Shanghai' }) : result('VERIFIED', 'release safety window is open', { lockPath })
  };
}

function expectation(name, expected, aliases = []) {
  const source = [name, ...aliases].find(candidate => hasValue(candidate));
  if (!source) return result('UNKNOWN', name + ' is not present; value was not required or printed', { name, expected, present: false });
  const matches = envName(source) === String(expected);
  return result(matches ? 'VERIFIED' : 'FAIL', matches ? name + ' matches the configured release expectation' : name + ' does not match the configured release expectation', { name, expected, present: true, source });
}

function checkExpectedConfiguration() {
  return {
    bind: expectation('TANGO_HOST', EXPECTED.bind, ['RELEASE_BIND']),
    port: expectation('TANGO_PORT', EXPECTED.port, ['RELEASE_PORT']),
    publicOrigin: expectation('TANGO_PUBLIC_ORIGIN', EXPECTED.publicOrigin, ['RELEASE_PUBLIC_ORIGIN']),
    litellmUrl: expectation('LITELLM_URL', EXPECTED.litellmUrl, ['TANGO_LITELLM_URL']),
    litellmModel: expectation('LITELLM_MODEL', EXPECTED.litellmModel, ['TANGO_LITELLM_MODEL', 'TANGO_AI_MODEL'])
  };
}

function checkRequiredEnvNames() {
  const names = [...new Set([...REQUIRED_ENV_NAMES, ...AI_FLAG_NAMES, ...CAP_LIMIT_NAMES])].sort();
  return result('UNKNOWN', 'environment names were inspected without reading or printing values', { names: names.map(name => ({ name, present: hasValue(name) })) });
}

function checkAiFlags() {
  const discovered = Object.keys(process.env).filter(name => /(?:AI|LLM)/i.test(name) && /(?:FLAG|ENABLED|MODE|PROVIDER|MODEL|STREAM)/i.test(name));
  const names = [...new Set([...AI_FLAG_NAMES, ...discovered])].sort();
  const invalid = [];
  for (const name of names) {
    if (!hasValue(name)) continue;
    if (/(?:ENABLED|FLAG|STREAM)/i.test(name) && !/^(?:0|1|true|false|yes|no|on|off)$/i.test(envName(name))) invalid.push(name);
  }
  return invalid.length ? result('FAIL', 'AI flag values are malformed', { names: names.map(name => ({ name, present: hasValue(name) })), invalid }) : result('UNKNOWN', 'AI flags were inspected by name only; no secret or value was printed', { names: names.map(name => ({ name, present: hasValue(name) })) });
}

function checkCapsAndLimits() {
  const discovered = Object.keys(process.env).filter(name => /(?:AI|LLM)/i.test(name) && /(?:CAP|LIMIT|MAX|BUDGET|TOKEN|BYTE|SECOND|TIMEOUT)/i.test(name));
  const names = [...new Set([...CAP_LIMIT_NAMES, ...discovered])].sort();
  const invalid = [];
  for (const name of names) {
    if (!hasValue(name)) continue;
    const value = envName(name);
    if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) < 0) invalid.push(name);
  }
  return invalid.length ? result('FAIL', 'AI caps or limits are not non-negative numbers', { names: names.map(name => ({ name, present: hasValue(name) })), invalid }) : result('UNKNOWN', 'AI caps and limits were inspected by name and shape only', { names: names.map(name => ({ name, present: hasValue(name) })) });
}

async function checkProductionConfiguration() {
  const relevant = REQUIRED_ENV_NAMES.filter(name => hasValue(name));
  if (relevant.length === 0) return result('UNKNOWN', 'production configuration names are absent; secret values were not required');
  const readiness = productionReadiness(process.env);
  if (readiness.configurationReady) return result('VERIFIED', 'production readiness configuration passed without live verification');
  return result('FAIL', 'production readiness configuration has blockers', { missing: readiness.missing });
}

async function checkServiceUnit() {
  const unit = process.env.RELEASE_SERVICE_UNIT || process.env.DONEGO_SERVICE_UNIT || EXPECTED.serviceUnit;
  if (!unit) {
    const manager = await run('systemctl', ['--user', 'show-environment', '--no-pager'], { timeout: 3000 });
    return manager.ok ? result('VERIFIED', 'systemd user manager is available; no unit name was configured') : result('UNKNOWN', 'systemd user manager or unit name could not be observed', { userService: true });
  }
  const unitPath = join(process.env.HOME || '', '.config', 'systemd', 'user', unit);
  if (await pathExists(unitPath)) return result('VERIFIED', 'systemd user unit file is present', { unit, userUnit: true });
  const shown = await run('systemctl', ['--user', 'show', unit, '--property=LoadState,ActiveState,UnitFileState,FragmentPath', '--no-pager'], { timeout: 3000 });
  if (!shown.ok) return result('UNKNOWN', 'systemd user unit could not be observed in this environment', { unit, userUnit: true });
  const properties = Object.fromEntries(shown.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const separator = line.indexOf('=');
    return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
  return properties.LoadState === 'loaded' ? result('VERIFIED', 'systemd user unit is loaded', { unit, userUnit: true, active: properties.ActiveState === 'active' }) : result('UNKNOWN', 'systemd user unit was not loaded', { unit, userUnit: true });
}

async function checkRollbackTarget() {
  const target = process.env.RELEASE_ROLLBACK_TARGET || process.env.DONEGO_ROLLBACK_TARGET;
  if (!target) return result('UNKNOWN', 'no rollback target was configured');
  const manifestPath = target.endsWith('manifest.json') ? target : join(target, 'manifest.json');
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.product !== 'tango-donego' || manifest.schema !== 1 || !manifest.files) return result('FAIL', 'rollback target manifest is not a Done&Go release manifest');
    return result('VERIFIED', 'rollback target manifest is present', { target: resolve(target), releaseId: manifest.releaseId || null });
  } catch {
    return result('FAIL', 'configured rollback target is missing or invalid');
  }
}

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

async function gitIn(repository, args) {
  try {
    const output = await execFile('git', args, { cwd: repository, timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true });
    return { ok: true, stdout: output.stdout, stderr: output.stderr };
  } catch (error) {
    return { ok: false, stdout: typeof error?.stdout === 'string' ? error.stdout : '', stderr: typeof error?.stderr === 'string' ? error.stderr : '' };
  }
}

// Read-only git identity verification for a rollback target commit. It never
// checks out, fetches, or writes; it only resolves and reports facts so a
// rollback cannot be driven by a mistyped or non-existent commit id.
export async function rollbackCommitCheck({ repository = root, target = null, anchor = null } = {}) {
  const details = {
    repository: resolve(repository),
    input: target,
    resolves: false,
    objectType: null,
    targetSha: null,
    subject: null,
    commitDate: null,
    refsPointingAtTarget: [],
    anchor: null,
    headSha: null,
    onReleaseLine: null
  };
  if (!target) return result('UNKNOWN', 'no git rollback target was configured', details);
  const resolvedTarget = await gitIn(repository, ['rev-parse', '--verify', target + '^{commit}']);
  const targetSha = resolvedTarget.ok ? resolvedTarget.stdout.trim() : '';
  if (!GIT_SHA_PATTERN.test(targetSha)) {
    return result('FAIL', 'rollback target does not resolve to a commit in the repository', details);
  }
  details.resolves = true;
  details.objectType = 'commit';
  details.targetSha = targetSha;
  const meta = await gitIn(repository, ['show', '-s', '--format=%s%n%cI', targetSha]);
  if (meta.ok) {
    const lines = meta.stdout.trim().split(/\r?\n/);
    details.subject = lines[0] || null;
    details.commitDate = lines[1] || null;
  }
  const refs = await gitIn(repository, ['for-each-ref', '--format=%(refname)', '--points-at', targetSha]);
  if (refs.ok) details.refsPointingAtTarget = refs.stdout.trim().split(/\r?\n/).filter(Boolean);
  const head = await gitIn(repository, ['rev-parse', '--verify', 'HEAD']);
  if (head.ok && GIT_SHA_PATTERN.test(head.stdout.trim())) {
    details.headSha = head.stdout.trim();
    const ancestry = await gitIn(repository, ['merge-base', '--is-ancestor', targetSha, 'HEAD']);
    details.onReleaseLine = ancestry.ok;
  }
  if (anchor) {
    const anchorDetails = { input: anchor, resolves: false, anchorSha: null, matchesTarget: false };
    details.anchor = anchorDetails;
    const resolvedAnchor = await gitIn(repository, ['rev-parse', '--verify', anchor + '^{commit}']);
    const anchorSha = resolvedAnchor.ok ? resolvedAnchor.stdout.trim() : '';
    if (!GIT_SHA_PATTERN.test(anchorSha)) {
      return result('FAIL', 'configured rollback anchor does not resolve to a commit in the repository', details);
    }
    anchorDetails.resolves = true;
    anchorDetails.anchorSha = anchorSha;
    anchorDetails.matchesTarget = anchorSha === targetSha;
    if (!anchorDetails.matchesTarget) return result('FAIL', 'rollback target does not match the configured rollback anchor', details);
  }
  return result('VERIFIED', 'rollback target identity, existence, and anchor consistency verified', details);
}

function openSocket(host, port, timeout = 2500) {
  return new Promise(resolvePromise => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeout, () => finish(false));
  });
}

async function checkRuntime() {
  const host = process.env.RELEASE_BIND || process.env.TANGO_HOST || EXPECTED.bind;
  const portValue = process.env.RELEASE_PORT || process.env.TANGO_PORT || EXPECTED.port;
  const port = Number(portValue);
  if (host !== '127.0.0.1' && host !== 'localhost') return result('FAIL', 'runtime checks are restricted to localhost');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return result('FAIL', 'runtime port is invalid');
  const listening = await openSocket(host, port);
  return listening ? result('VERIFIED', 'localhost TCP listener accepted a read-only connection', { host, port }) : result('UNKNOWN', 'localhost TCP listener was not reachable; no service was started or changed', { host, port });
}

async function checkHealth() {
  const host = process.env.RELEASE_BIND || process.env.TANGO_HOST || EXPECTED.bind;
  const port = Number(process.env.RELEASE_PORT || process.env.TANGO_PORT || EXPECTED.port);
  if (host !== '127.0.0.1' && host !== 'localhost') return result('FAIL', 'health checks are restricted to localhost');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return result('FAIL', 'health port is invalid');
  const url = 'http://' + host + ':' + port + '/';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return response.ok ? result('VERIFIED', 'localhost HTTP health probe returned success', { url, status: response.status }) : result('FAIL', 'localhost HTTP health probe returned a non-success status', { url, status: response.status });
  } catch {
    return result('UNKNOWN', 'localhost HTTP health probe was not reachable; no service was started or changed', { url });
  } finally {
    clearTimeout(timer);
  }
}

const VALUE_OPTIONS = Object.freeze({
  '--rollback-target': 'rollbackTarget',
  '--rollback-anchor': 'rollbackAnchor',
  '--rollback-repo': 'rollbackRepo'
});

export function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (Object.prototype.hasOwnProperty.call(VALUE_OPTIONS, arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('missing value for ' + arg);
      values[VALUE_OPTIONS[arg]] = value;
      index++;
    } else if (arg === '--runtime' || arg === '--health' || arg === '--json') flags.add(arg.slice(2));
    else if (arg === '--help' || arg === '-h') return { help: true, flags, values };
    else throw new Error('unknown option');
  }
  return { help: false, flags, values };
}

export async function releasePreflight({ runtime = false, health = false, rollbackTarget = null, rollbackAnchor = null, rollbackRepository = null } = {}) {
  const safety = await checkSafety();
  const packageInfo = await readPackage();
  const checks = {
    safety: safety.check,
    git: await checkGit(),
    dependencies: await checkDependencies(packageInfo?.packageJson),
    syntax: await syntaxCheck(['scripts/release-preflight.mjs', 'scripts/production-readiness.mjs', 'scripts/build-web.mjs']),
    unitReadiness: await checkUnitReadiness(packageInfo?.packageJson),
    buildManifest: await checkBuild(safety.state.blocked),
    requiredEnvNames: checkRequiredEnvNames(),
    expectedConfiguration: checkExpectedConfiguration(),
    aiFlags: checkAiFlags(),
    aiCapsAndLimits: checkCapsAndLimits(),
    productionConfiguration: await checkProductionConfiguration(),
    serviceUnit: await checkServiceUnit(),
    rollbackTarget: await checkRollbackTarget(),
    rollbackTargetCommit: await rollbackCommitCheck({
      repository: rollbackRepository || process.env.RELEASE_ROLLBACK_REPO || undefined,
      target: rollbackTarget || process.env.RELEASE_ROLLBACK_COMMIT || process.env.DONEGO_ROLLBACK_COMMIT || null,
      anchor: rollbackAnchor || process.env.RELEASE_ROLLBACK_ANCHOR || process.env.DONEGO_ROLLBACK_ANCHOR || null
    })
  };
  if (runtime || health) checks.runtime = await checkRuntime();
  if (health) checks.health = await checkHealth();
  const allChecks = Object.values(checks).flatMap(check => check && check.status ? [check] : Object.values(check || {}));
  const failures = allChecks.filter(check => check?.status === 'FAIL').length;
  const blocked = allChecks.filter(check => check?.status === 'BLOCKED').length;
  return {
    mode: runtime || health ? (health ? 'offline-with-local-health' : 'offline-with-local-runtime') : 'offline',
    target: { bind: EXPECTED.bind, port: EXPECTED.port, publicOrigin: EXPECTED.publicOrigin, serviceUnit: EXPECTED.serviceUnit, litellmUrl: EXPECTED.litellmUrl, litellmModel: EXPECTED.litellmModel },
    checks,
    summary: { verified: allChecks.filter(check => check?.status === 'VERIFIED').length, unknown: allChecks.filter(check => check?.status === 'UNKNOWN').length, failures, blocked }
  };
}

function help() {
  return [
    'Usage: node scripts/release-preflight.mjs [--runtime] [--health] [--json]',
    '                                  [--rollback-target <commit>] [--rollback-anchor <commit>]',
    '                                  [--rollback-repo <path>]',
    '',
    'Default mode is offline and read-only. --runtime probes the expected localhost TCP port.',
    '--health probes the expected localhost HTTP root and implies --runtime.',
    '--rollback-target verifies that a git commit id resolves in the repository and reports',
    'its identity (full SHA, subject, date, refs, ancestry); --rollback-anchor additionally',
    'fails the report when the target does not match that anchor commit. --rollback-repo',
    'runs the read-only rollback identity check against another repository path.',
    'No mode starts, restarts, deploys, installs, pushes, checks out, or prints environment values.'
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(help() + '\n');
    } else {
      const report = await releasePreflight({
        runtime: parsed.flags.has('runtime') || parsed.flags.has('health'),
        health: parsed.flags.has('health'),
        rollbackTarget: parsed.values.rollbackTarget || null,
        rollbackAnchor: parsed.values.rollbackAnchor || null,
        rollbackRepository: parsed.values.rollbackRepo || null
      });
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      if (report.summary.blocked) process.exitCode = 2;
      else if (report.summary.failures) process.exitCode = 1;
    }
  } catch {
    process.stderr.write('release preflight argument or execution error\n');
    process.exitCode = 2;
  }
}
