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

/* ---- prune stale build output -------------------------------------------
 * vite is configured with `emptyOutDir: false`, so every build drops a new
 * content-hashed bundle next to the previous ones. Nothing ever removes the
 * old ones: they pile up in web/dist, get mirrored into app/frontend/dist,
 * and end up embedded in the binary by go:embed (18 stale bundles had grown
 * the executable by ~3 MB before this was added).
 *
 * Pruning cannot be "delete everything then copy": the deletion has to be
 * selective, so the keep-set is derived from what index.html (and the CSS it
 * pulls in) actually references. Files are removed one by one — no recursive
 * directory deletion, which some environments intercept as a trash operation
 * and which is what this script's robocopy /MIR exists to avoid.
 */

// Root-level text files whose references decide what counts as live output.
function rootTextFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(html|css|js)$/.test(e.name))
    .map((e) => path.join(dir, e.name));
}

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

// Everything under assets/ that no root file mentions by name.
function staleAssets(dir) {
  const assets = path.join(dir, 'assets');
  if (!fs.existsSync(assets)) return [];

  const haystack = rootTextFiles(dir)
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  // With no reference to any asset at all there is nothing to tell live output
  // from junk — most likely a half-finished build. Leave the directory alone
  // rather than empty it and silently ship an app that cannot boot.
  if (!haystack.includes('assets/')) return [];
  const files = listFiles(assets);
  return files.filter((f) => {
    const rel = path.relative(dir, f).split(path.sep).join('/');
    // Match on the URL form: `assets/index-abc.js` or, for references created
    // relative to the CSS file, the bare `index-abc.js`.
    return !haystack.includes(rel) && !haystack.includes(path.basename(rel));
  });
}

function prune(dir, label) {
  const stale = staleAssets(dir);
  if (!stale.length) return 0;
  for (const f of stale) fs.unlinkSync(f);
  console.log(`pruned ${stale.length} stale file(s) from ${label}`);
  return stale.length;
}

// Source first: /MIR only mirrors, it would happily carry the junk across.
prune(src, 'web/dist');

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

// Destination again: /MIR should have purged anything extra, but a failed or
// skipped purge (open file, permissions) must not leave dead bundles in the
// embed path where they cost binary size and hide nothing.
prune(dest, 'app/frontend/dist');

console.log(`synced ${src} -> ${dest}`);
