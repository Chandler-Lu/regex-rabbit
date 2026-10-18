import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));

// Use an isolated source copy so this check cannot replace a browser test's
// dist directory. Runtime expectations come from the files that load them.
test('build includes page, Worker, options and locale dependencies and rejects missing runtime modules', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'regex-rabbit-package-'));
  try {
    for (const entry of readdirSync(repo, { withFileTypes: true })) {
      if (entry.isFile() && /\.(?:js|css|html|json)$/.test(entry.name)) cpSync(join(repo, entry.name), join(fixture, entry.name));
    }
    for (const directory of ['domain', 'infra', 'icons', '_locales']) cpSync(join(repo, directory), join(fixture, directory), { recursive: true });
    mkdirSync(join(fixture, 'scripts'));
    cpSync(join(repo, 'scripts/package.mjs'), join(fixture, 'scripts/package.mjs'));

    const background = readFileSync(join(fixture, 'background.js'), 'utf8');
    const start = background.indexOf('files: [\n');
    const injection = background.slice(start, background.indexOf('] });', start));
    const files = Array.from(injection.matchAll(/"([^"\n]+\.(?:js|css))"/g), match => match[1]);
    assert.ok(files.length >= 10);
    assert.equal(files[0], 'domain/runtime_policy.js', 'shared contracts must load before all page modules');
    assert.ok(files.includes('infra/text_mapping.js'), 'page injection must load sparse text mapping');
    assert.ok(files.indexOf('infra/text_mapping.js') < files.indexOf('infra/text_collector.js'));
    const worker = readFileSync(join(fixture, 'search_worker.js'), 'utf8');
    const imports = Array.from(worker.matchAll(/importScripts\("([^"\n]+)"\)/g), match => match[1]);
    assert.ok(imports.includes('domain/literal_matcher.js'));
    assert.ok(imports.includes('domain/runtime_policy.js'));
    assert.match(background, /importScripts\("domain\/runtime_policy\.js"\)/);
    const expected = new Set([...files, ...imports, 'manifest.json', 'search_worker.js', 'offscreen.html', 'options.html']);
    for (const html of ['offscreen.html', 'options.html']) {
      const source = readFileSync(join(fixture, html), 'utf8');
      for (const match of source.matchAll(/(?:src|href)="([^"\n]+\.(?:js|css))"/g)) expected.add(match[1]);
    }
    for (const locale of readdirSync(join(fixture, '_locales'))) expected.add('_locales/' + locale + '/messages.json');

    const build = spawnSync(process.execPath, ['scripts/package.mjs'], { cwd: fixture, encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    for (const file of expected) {
      assert.deepEqual(readFileSync(join(fixture, 'dist', file)), readFileSync(join(fixture, file)), file + ' must be included unchanged');
    }
    const zip = readFileSync(join(fixture, 'dist/regex-rabbit.zip'));
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.ok(zip.includes(Buffer.from('domain/literal_matcher.js')));
    assert.ok(zip.includes(Buffer.from('infra/text_mapping.js')));

    for (const missing of ['domain/runtime_policy.js', 'domain/literal_matcher.js', 'infra/text_mapping.js']) {
      rmSync(join(fixture, missing));
      const incomplete = spawnSync(process.execPath, ['scripts/package.mjs'], { cwd: fixture, encoding: 'utf8' });
      assert.notEqual(incomplete.status, 0, missing + ' is required');
      assert.ok(incomplete.stderr.includes(missing.split('/').at(-1)), incomplete.stderr);
      cpSync(join(repo, missing), join(fixture, missing));
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
test('production permissions and version never inherit the browser test grant', () => {
  const manifest = JSON.parse(readFileSync(join(repo, 'manifest.json'),'utf8'));
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'),'utf8'));
  const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'),'utf8'));
  assert.equal(manifest.version,pkg.version);
  assert.equal(lock.version,pkg.version);
  assert.equal(lock.packages[''].version,pkg.version);
  assert.equal(manifest.host_permissions,undefined);
  assert.equal(manifest.externally_connectable,undefined);
  assert.ok(manifest.permissions.includes('offscreen'));
});
