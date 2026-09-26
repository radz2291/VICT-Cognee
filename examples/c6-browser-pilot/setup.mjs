/**
 * C6 pilot consumer setup — installs the packed tarball and the tested VICT
 * 0.3.1 packages as an ordinary consumer would (plain `npm install` with
 * tarball `file:` deps; NO flags, NO registry publication, NO workspace
 * links). Every package lands as a REAL tarball copy in this workspace, so
 * nothing can resolve back into a VICT source tree.
 *
 * Required sources (set via env; no machine-specific defaults):
 *   PILOT_COGNEE_TGZ   packed @victframework/cognee tarball (from pack/ npm pack)
 *   PILOT_VICT_ROOT    VICT clone root (packages/{contracts,kernel,sdk,runtime})
 *   PILOT_PYTHON       Python executable with cognee[gliner] 1.6.1 (used by server)
 *
 * Run:  npm run setup   then   npm install --no-audit --no-fund   then  npm start
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const VICT_ROOT = process.env.PILOT_VICT_ROOT;
const COGNEE_TGZ = process.env.PILOT_COGNEE_TGZ;
if (!VICT_ROOT || !COGNEE_TGZ) {
  console.error('[setup] Set PILOT_VICT_ROOT and PILOT_COGNEE_TGZ; see README §Setup.');
  process.exit(2);
}
if (!existsSync(COGNEE_TGZ)) {
  console.error(`[setup] Cognee tarball not found: ${COGNEE_TGZ}`);
  process.exit(2);
}

const vendor = path.resolve('vendor');
mkdirSync(vendor, { recursive: true });

const jobs = [
  { from: COGNEE_TGZ, to: 'victframework-cognee-0.1.0.tgz' },
  { from: path.join(VICT_ROOT, 'packages', 'contracts'), to: 'victframework-contracts-0.3.1.tgz' },
  { from: path.join(VICT_ROOT, 'packages', 'kernel'), to: 'victframework-kernel-0.3.1.tgz' },
  { from: path.join(VICT_ROOT, 'packages', 'sdk'), to: 'victframework-sdk-0.3.1.tgz' },
  { from: path.join(VICT_ROOT, 'packages', 'runtime'), to: 'victframework-runtime-0.3.1.tgz' },
];

for (const job of jobs) {
  let src = job.from;
  if (!src.endsWith('.tgz')) {
    // Pack the VICT package straight into vendor/ — the VICT tree is never
    // modified (tarballs land here; the package dirs stay clean).
    const dest = path.join(vendor, job.to);
    execFileSync('npm', ['pack', '--pack-destination', vendor], {
      cwd: src, stdio: 'pipe', shell: process.platform === 'win32',
    });
    console.log(`[setup] packed ${path.basename(src)} -> vendor/${job.to}`);
    continue;
  }
  copyFileSync(src, path.join(vendor, job.to));
  console.log(`[setup] copied ${path.basename(src)} -> vendor/${job.to}`);
}

console.log(`[setup] done. Now run:
  npm install --no-audit --no-fund
  set PILOT_PYTHON=<python with cognee 1.6.1>   (default below)
  npm start   # http://localhost:${process.env.PILOT_PORT ?? 4173}
`);