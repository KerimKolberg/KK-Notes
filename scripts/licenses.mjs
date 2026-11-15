/**
 * Writes THIRD_PARTY_NOTICES.md: every library the app is built from, with its licence.
 *
 *   npm run licenses            # rewrite the file
 *   npm run licenses -- --check # exit 1 if it is out of date (a dependency was added or changed)
 *
 * Nearly all of these licences (MIT, Apache-2.0, BSD) allow the code to be shipped inside an app on one
 * condition: that the app says whose it is and under which licence. This file is that saying, kept by a
 * script because the list is several hundred long and changes whenever a dependency does. It covers what
 * ships: the npm packages the app itself depends on (not the build tools), and the Rust crates of the
 * shell on every platform it is built for.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'THIRD_PARTY_NOTICES.md';
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/** The npm packages that ship: the app's dependencies and theirs, not `devDependencies`. */
function npmPackages() {
  const tree = JSON.parse(run('npm', ['ls', '--omit=dev', '--all', '--json']));
  const seen = new Map();
  const walk = (deps, base) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      if (!info.version) continue;
      const key = `${name}@${info.version}`;
      if (!seen.has(key)) {
        let license = 'UNKNOWN';
        let repository = '';
        for (const dir of [join(base, 'node_modules', name), join('node_modules', name)]) {
          const file = join(dir, 'package.json');
          if (!existsSync(file)) continue;
          const pkg = JSON.parse(readFileSync(file, 'utf8'));
          license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'UNKNOWN');
          repository = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '');
          break;
        }
        seen.set(key, { name, version: info.version, license, repository });
      }
      walk(info.dependencies, join(base, 'node_modules', name));
    }
  };
  walk(tree.dependencies, '.');
  return [...seen.values()];
}

/** The Rust crates of the shell, on every platform it is built for. The workspace's own crates are not third-party. */
function rustCrates() {
  const meta = JSON.parse(run('cargo', ['metadata', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml']));
  const own = new Set(meta.workspace_members);
  return meta.packages
    .filter((p) => !own.has(p.id))
    .map((p) => ({ name: p.name, version: p.version, license: p.license ?? (p.license_file ? 'see the crate' : 'UNKNOWN'), repository: p.repository ?? '' }));
}

const tidy = (url) => url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://');

function section(title, packages) {
  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const rows = sorted.map((p) => `| ${p.name} | ${p.version} | ${p.license} | ${p.repository ? tidy(p.repository) : ''} |`);
  return [`## ${title} (${sorted.length})`, '', '| Package | Version | Licence | Source |', '| --- | --- | --- | --- |', ...rows, ''].join('\n');
}

function summary(packages) {
  const counts = new Map();
  for (const p of packages) counts.set(p.license, (counts.get(p.license) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([license, n]) => `- ${license}: ${n}`).join('\n');
}

const npm = npmPackages();
const rust = rustCrates();
const text = [
  '# Third-party notices',
  '',
  'KK-Notes is built from the open-source libraries listed here. Each is the work of its authors and is used under',
  'the licence named beside it; the full text of each licence is in the package itself, at the source linked.',
  'This file is written by `npm run licenses` and should not be edited by hand.',
  '',
  '## Licences in use',
  '',
  summary([...npm, ...rust]),
  '',
  section('JavaScript packages shipped in the app', npm),
  section('Rust crates of the shell (all platforms)', rust),
].join('\n');

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== text) {
    console.error(`${OUT} is out of date: run \`npm run licenses\` and commit the result.`);
    process.exit(1);
  }
  console.log(`${OUT} is up to date (${npm.length} npm packages, ${rust.length} crates).`);
} else {
  writeFileSync(OUT, text);
  console.log(`Wrote ${OUT}: ${npm.length} npm packages, ${rust.length} crates.`);
}
