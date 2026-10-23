import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

for (const browser of ['chrome', 'firefox']) {
  const root = `.output/${browser}-mv3`;
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), (browser === 'chrome' ? ['activeTab', 'scripting', 'storage', 'sidePanel'] : ['activeTab', 'scripting', 'storage']).sort());
  assert.deepEqual(manifest.host_permissions ?? [], []);
  assert.deepEqual(manifest.content_scripts ?? [], []);
  assert.deepEqual(manifest.web_accessible_resources ?? [], []);
  assert.deepEqual(manifest.optional_permissions, ['notifications']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'none'; connect-src https://api.openai.com https://generativelanguage.googleapis.com https://api.anthropic.com");
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.action.default_title, manifest.name);
  assert.equal(manifest.options_ui.page, 'options.html');
  assert.equal(manifest.options_ui.open_in_tab, true);
  if (browser === 'chrome') {
    assert.deepEqual(manifest.background, { service_worker: 'background.js' });
    assert.deepEqual(manifest.side_panel, { default_path: 'session.html' });
    assert.equal(manifest.sidebar_action, undefined);
  } else {
    assert.deepEqual(manifest.background, { scripts: ['background.js'], persistent: false });
    assert.equal(manifest.sidebar_action.default_panel, 'session.html');
    assert.equal(manifest.side_panel, undefined);
    assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '140.0');
    assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions, { required: ['personallyIdentifyingInfo'], optional: ['authenticationInfo', 'websiteContent'] });
  }
  for (const file of ['background.js', 'popup.html', 'session.html', 'options.html']) await access(`${root}/${file}`);
  console.log(`${browser}: MV3, browser-specific entries, packaged UI and permission assertions passed`);
}
