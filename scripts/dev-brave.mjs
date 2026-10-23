import { spawnSync } from 'node:child_process';

if (!process.env.BRAVE_BINARY) {
  console.error('Set BRAVE_BINARY to your Brave executable, then run npm run dev:brave. See README.md.');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['node_modules/wxt/bin/wxt.mjs', '-b', 'chrome', '--mv3'], {
  stdio: 'inherit',
  env: process.env,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
