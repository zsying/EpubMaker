const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Called from web/ during wails build's frontend:build step.
const src = path.resolve('dist');
const dest = path.resolve('../app/frontend/dist');

if (!fs.existsSync(src)) {
  console.error(`frontend dist not found: ${src}`);
  process.exit(1);
}

if (!fs.existsSync(dest)) {
  fs.mkdirSync(dest, { recursive: true });
}

// Mirror web/dist into app/frontend/dist using robocopy /MIR. This bypasses
// Node fs shims that intercept recursive deletion as a trash operation.
// /XF .gitkeep preserves the tracked placeholder so go:embed never sees an
// empty directory when no real build has run yet.
const args = [src, dest, '/MIR', '/XF', '.gitkeep'];
const result = spawnSync('robocopy', args, { stdio: 'inherit', shell: false });
// robocopy exit codes 0-7 indicate success (with informational flags).
if (result.error || (result.status !== null && result.status >= 8)) {
  console.error(`robocopy failed: ${result.error ? result.error.message : 'exit ' + result.status}`);
  process.exit(1);
}

console.log(`synced ${src} -> ${dest}`);
