import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Read-only production-package audit. Test grants and fixtures never enter here.
const result = { packages: {}, productionDependencies: [] };
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((e) => e.isDirectory() ? files(`${directory}/${e.name}`) : [`${directory}/${e.name}`]))).flat();
}
for (const target of ['chrome', 'firefox']) {
  const root = `.output/${target}-mv3`, paths = await files(root);
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
  assert.equal(manifest.content_security_policy.extension_pages.includes("'unsafe-eval'"), false);
  assert.deepEqual(manifest.host_permissions ?? [], []);
  assert.deepEqual(manifest.content_scripts ?? [], []);
  assert.deepEqual(manifest.web_accessible_resources ?? [], []);
  const hashes = {};
  for (const path of paths) {
    assert(!/\.(map|md|ts|tsx)$|(?:^|\/)(?:tests|fixtures|node_modules)\//.test(path), `Nonshipping file: ${path}`);
    const bytes = await readFile(path), source = bytes.toString('utf8');
    hashes[path.slice(root.length + 1)] = createHash('sha256').update(bytes).digest('hex');
    for (const marker of ['CANARY', 'providerAudit', 'fixture.finalizations', 'fixture.inputEvents', 'fixture.advancements', 'applyr-fixture-tls', '/pattern-upload', 'native-upload.html', 'P15_SYNTHETIC']) assert(!source.includes(marker), `${path}: test marker ${marker}`);
    assert(!/(?:import\s*\(|importScripts\s*\()\s*['"]https?:/.test(source), `${path}: remote code import`);
    if (path.endsWith('.html')) {
      assert(!/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(source), `${path}: inline executable script`);
      assert(!/<script[^>]*src=["'](?:https?:|\/\/)/.test(source), `${path}: remote script`);
    }
  }
  result.packages[target] = { files: paths.length, hashes, fixtureHits: 0, requiredHosts: 0, remoteScriptImports: 0, manifest };
}
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
result.lockfileSha256 = createHash('sha256').update(await readFile('package-lock.json')).digest('hex');
for (const [path, value] of Object.entries(lock.packages)) {
  if (!path || value.dev) continue;
  // License metadata is evidence for publisher review, not a legal conclusion.
  assert(value.license, `Missing production license metadata: ${path}`);
  result.productionDependencies.push({ path, version: value.version, license: value.license, integrity: value.integrity });
}
console.log(JSON.stringify(result, null, 2));
