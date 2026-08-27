import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { REPOSITORY, BRANCH, normalizeVersion, isAllowedUpdatePath } = require('../resources/backend/services/appUpdatePolicy.js');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const manifestPath = path.join(projectRoot, 'update-manifest.json');
const checkOnly = process.argv.includes('--check');

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'resources/backend', 'resources/frontend'], {
    cwd: projectRoot,
    encoding: 'utf8'
  });
  return output.split('\0').filter(Boolean).map(value => value.replace(/\\/g, '/'));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readPublishedFile(relativePath) {
  return execFileSync('git', ['show', `:${relativePath}`], {
    cwd: projectRoot,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024
  });
}

const version = normalizeVersion(fs.readFileSync(path.join(projectRoot, 'VERSION'), 'utf8'));
const files = ['VERSION', ...trackedFiles().filter(isAllowedUpdatePath)]
  .sort((left, right) => left.localeCompare(right, 'en'))
  .map(relativePath => {
    const absolutePath = path.join(projectRoot, ...relativePath.split('/'));
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`更新文件必须是普通文件: ${relativePath}`);
    const content = readPublishedFile(relativePath);
    return { path: relativePath, size: content.length, sha256: sha256(content) };
  });

const manifest = `${JSON.stringify({
  schemaVersion: 1,
  repository: REPOSITORY,
  branch: BRANCH,
  version,
  files
}, null, 2)}\n`;

if (checkOnly) {
  const current = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '';
  if (current !== manifest) throw new Error('update-manifest.json 已过期，请运行 pnpm update:manifest');
  console.log(`更新清单有效: ${files.length} 个文件 / ${version}`);
} else {
  fs.writeFileSync(manifestPath, manifest, 'utf8');
  console.log(`已生成更新清单: ${files.length} 个文件 / ${version}`);
}
