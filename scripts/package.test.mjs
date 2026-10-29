import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bash = process.env.BASH_BIN || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const tar = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar';
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function run(command, args, cwd, env, log) {
  const fd = fs.openSync(log, 'w');
  try {
    const result = spawnSync(command, args, { cwd, env, stdio: ['ignore', fd, fd] });
    assert.ifError(result.error);
    return { status: result.status, output: fs.readFileSync(log, 'utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

function fixture(t, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gonavi package test '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const sub of ['scripts', 'tools', 'frontend/dist', 'frontend/node_modules/typescript/bin', 'frontend/node_modules/vite/bin']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  fs.copyFileSync(path.join(root, 'scripts/package.sh'), path.join(dir, 'scripts/package.sh'));
  fs.copyFileSync(path.join(root, 'gonavi.plugin.json'), path.join(dir, 'gonavi.plugin.json'));
  fs.writeFileSync(path.join(dir, 'frontend/dist/index.html'), 'stale frontend');
  fs.utimesSync(path.join(dir, 'frontend/dist/index.html'), 1, 1);
  fs.writeFileSync(path.join(dir, "tools/go"), "#!/usr/bin/env bash\nwhile [ \"$#\" -gt 0 ]; do if [ \"$1\" = \"-o\" ]; then shift; printf \"test backend\" > \"$1\"; exit 0; fi; shift; done\nexit 2\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "tools/npm"), "#!/usr/bin/env bash\nnode node_modules/typescript/bin/tsc --noEmit && node node_modules/vite/bin/vite.js build\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "frontend/node_modules/typescript/bin/tsc"), "const fs = require(\"node:fs\"); fs.appendFileSync(\"../build.trace\", \"tsc\\n\"); process.exit(Number(process.env.FAIL_TYPECHECK || 0));");
  fs.writeFileSync(path.join(dir, "frontend/node_modules/vite/bin/vite.js"), "const fs = require(\"node:fs\"); fs.appendFileSync(\"../build.trace\", \"vite\\n\"); process.exitCode = Number(process.env.FAIL_VITE || 0); if (process.exitCode) process.exit(process.exitCode); fs.mkdirSync(\"dist\", {recursive:true}); fs.writeFileSync(\"dist/index.html\", \"fresh frontend\");");
  const env = { ...process.env, ...extraEnv, PATH: path.join(dir, 'tools') + path.delimiter + process.env.PATH };
  const build = (...versions) => run(bash, ['scripts/package.sh', ...versions], dir, env, path.join(dir, 'build.log'));
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'gonavi.plugin.json'), 'utf8')).version;
  const zip = path.join(dir, 'dist/gonavi-ssh-v' + version + '.zip');
  return { dir, env, build, zip };
}

test('default and matching explicit archive versions follow the manifest', t => {
  for (const file of ['gonavi.plugin.json', 'frontend/package.json', 'frontend/package-lock.json']) {
    const metadata = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    assert.equal(metadata.version, '0.1.0', file);
    if (metadata.packages) assert.equal(metadata.packages[''].version, '0.1.0', file + ' root package');
  }
  const f = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.dir, 'gonavi.plugin.json'), 'utf8'));
  manifest.version = '1.2.3';
  fs.writeFileSync(path.join(f.dir, 'gonavi.plugin.json'), JSON.stringify(manifest));
  for (const versions of [[], [manifest.version]]) {
    const result = f.build(...versions);
    assert.equal(result.status, 0, result.output);
    assert.ok(fs.existsSync(path.join(f.dir, 'dist/gonavi-ssh-v1.2.3.zip')), 'archive must use manifest version 1.2.3');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'package/gonavi.plugin.json'), 'utf8')).version, '1.2.3');
  }
});

test('mismatched explicit version fails before modifying package outputs', t => {
  const f = fixture(t);
  const marker = path.join(f.dir, 'package/keep.txt');
  fs.mkdirSync(path.dirname(marker));
  fs.writeFileSync(marker, 'keep staging');
  fs.mkdirSync(path.dirname(f.zip));
  fs.writeFileSync(f.zip, 'keep archive');
  for (const version of ['9.9.9', '']) {
    const result = f.build(version);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /版本.*不一致/);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'keep staging');
    assert.equal(fs.readFileSync(f.zip, 'utf8'), 'keep archive');
    assert.equal(fs.existsSync(path.join(f.dir, 'dist/gonavi-ssh-v' + version + '.zip')), false);
    assert.equal(fs.existsSync(path.join(f.dir, 'build.trace')), false);
  }
});

test('archive has canonical root entries and all manifest declarations', t => {
  const f = fixture(t);
  const result = f.build();
  assert.equal(result.status, 0, result.output);
  const list = run(tar, ['-tf', f.zip], f.dir, f.env, path.join(f.dir, 'list.log'));
  assert.equal(list.status, 0, list.output);
  const names = list.output.trim().split(/\r?\n/);
  assert.ok(names.every(name => !name.split('/').includes('.')), 'archive contains ./ path segments');
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, names.length, 'archive has duplicate/case-colliding entries');
  const manifest = JSON.parse(fs.readFileSync(path.join(f.dir, 'gonavi.plugin.json'), 'utf8'));
  for (const entry of [manifest.window.entry, ...Object.values(manifest.backend.platforms).map(platform => platform.executable), 'gonavi.plugin.json']) {
    assert.ok(names.includes(entry), 'missing declared entry: ' + entry);
  }
  assert.equal(hash(path.join(f.dir, 'frontend/dist/index.html')), hash(path.join(f.dir, 'package/frontend/index.html')));
  assert.ok(fs.statSync(path.join(f.dir, 'frontend/dist/index.html')).mtimeMs > 1000);
  const unpack = path.join(f.dir, 'unpack');
  fs.mkdirSync(unpack);
  const extracted = run(tar, ['-xf', f.zip, '-C', unpack], f.dir, f.env, path.join(f.dir, 'extract.log'));
  assert.equal(extracted.status, 0, extracted.output);
  assert.equal(hash(path.join(unpack, 'frontend/index.html')), hash(path.join(f.dir, 'frontend/dist/index.html')));
});

test("frontend build bypasses npm wrappers that report success without output", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'tools/npm'), "#!/usr/bin/env bash\necho \"syntax error near unexpected token\" >&2\nexit 0\n", {mode: 0o755});
  const result = f.build();
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readFileSync(path.join(f.dir, 'package/frontend/index.html'), 'utf8'), 'fresh frontend', 'stale dist copied after npm falsely succeeded');
  assert.equal(fs.readFileSync(path.join(f.dir, 'build.trace'), 'utf8'), "tsc\nvite\n");
});

for (const [failure, code] of [["FAIL_TYPECHECK", 23], ["FAIL_VITE", 24]]) {
  test(failure + " stops packaging with the real nonzero exit", t => {
    const f = fixture(t, {[failure]: String(code)});
    const result = f.build();
    assert.equal(result.status, code, result.output);
    assert.equal(fs.existsSync(path.join(f.dir, 'package/frontend/index.html')), false);
    assert.equal(fs.existsSync(f.zip), false);
  });
}

test("rebuild removes stale staging and archive entries", t => {
  const f = fixture(t);
  assert.equal(f.build().status, 0);
  fs.writeFileSync(path.join(f.dir, 'package/frontend/obsolete.js'), 'obsolete');
  const appended = run(tar, ["-a", "-cf", f.zip, "frontend", "bin", "gonavi.plugin.json"], path.join(f.dir, "package"), f.env, path.join(f.dir, "stale.log"));
  assert.equal(appended.status, 0, appended.output);
  const result = f.build();
  assert.equal(result.status, 0, result.output);
  const list = run(tar, ["-tf", f.zip], f.dir, f.env, path.join(f.dir, "rebuilt.log"));
  assert.equal(list.status, 0, list.output);
  assert.ok(!list.output.includes("obsolete.js"));
});

test("GoNavi InspectPackage rejects legacy paths and accepts the script archive", {skip: !process.env.GONAVI_HOST_ROOT}, t => {
  const f = fixture(t);
  const built = f.build();
  assert.equal(built.status, 0, built.output);
  const legacy = path.join(f.dir, process.platform === "win32" ? "legacy.zip" : "legacy.tgz");
  const legacyArgs = process.platform === "win32" ? ["-a", "-cf", legacy, "."] : ["-czf", legacy, "."];
  const oldArchive = run(tar, legacyArgs, path.join(f.dir, "package"), f.env, path.join(f.dir, "legacy.log"));
  assert.equal(oldArchive.status, 0, oldArchive.output);
  const code = [
    "package plugin",
    'import ("context"; "testing"; "strings")',
    "func TestSSHScriptArchive(t *testing.T) {",
    'if _, err := InspectPackage(context.Background(), ' + JSON.stringify(legacy) + '); err == nil || !strings.Contains(err.Error(), "unsafe package path") { t.Fatalf("legacy archive must reject: %v", err) } else { t.Logf("legacy rejected: %v", err) }',
    'dir, err := InspectPackage(context.Background(), ' + JSON.stringify(path.join(f.dir, 'package')) + '); if err != nil { t.Fatal(err) }',
    'zip, err := InspectPackage(context.Background(), ' + JSON.stringify(f.zip) + '); if err != nil { t.Fatal(err) }',
    'if dir.Digest != zip.Digest { t.Fatalf("archive content differs: %s != %s", dir.Digest, zip.Digest) }; t.Logf("script ZIP accepted: id=%s version=%s digest=%s", zip.Manifest.ID, zip.Manifest.Version, zip.Digest)',
    "}",
  ].join('\n');
  const goTest = path.join(f.dir, "inspect_test.go");
  fs.writeFileSync(goTest, code);
  const overlay = path.join(f.dir, "overlay.json");
  fs.writeFileSync(overlay, JSON.stringify({Replace: {[path.join(process.env.GONAVI_HOST_ROOT, "internal/plugin/ssh_script_archive_test.go")]: goTest}}));
  const inspected = run(process.env.GO_BIN || "go", ["test", "-overlay", overlay, "./internal/plugin", "-run", "^TestSSHScriptArchive$", "-count=1", "-v"], process.env.GONAVI_HOST_ROOT, f.env, path.join(f.dir, "inspect.log"));
  assert.equal(inspected.status, 0, inspected.output);
  t.diagnostic(inspected.output.trim());
});
