import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const distRoot = path.join(projectRoot, 'dist');
const releaseRoot = path.join(projectRoot, 'release');
const appStage = path.join(distRoot, 'package-source');
const dependencyStage = path.join(distRoot, 'runtime-dependencies');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));

function assertInside(base, target) {
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing unsafe build path: ${target}`);
  }
}

function resetBuildDirectory(target) {
  assertInside(projectRoot, target);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
}

const runtimeDirectories = new Set([
  'cache', 'dawncache', 'gpucache', 'log', 'logs', 'output', 'outputs', 'uploads', 'user data'
]);
const runtimeFiles = new Set([
  'asset-library.json', 'canvas-config.json', 'config.json', 'creative-config.json',
  'creative-history.json', 'sessions.json'
]);

function isSafeRuntimeResource(sourceRoot, sourcePath) {
  const relative = path.relative(sourceRoot, sourcePath);
  if (!relative) return true;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep).map(segment => segment.toLowerCase());
  const filename = segments.at(-1);
  if (segments.some(segment => runtimeDirectories.has(segment))) return false;
  if (runtimeFiles.has(filename)) return false;
  if (filename === '.env' || (filename.startsWith('.env.') && filename !== '.env.example')) return false;
  if (filename.endsWith('.log') || filename.endsWith('.bak') || filename.includes('.before-')) return false;
  return true;
}

function run(command, args, cwd) {
  let executable = command;
  let commandArgs = args;
  if (process.platform === 'win32') {
    const parts = [command, ...args];
    if (parts.some(part => !/^[A-Za-z0-9_@./:=+-]+$/.test(part))) {
      throw new Error('Refusing unsafe Windows build command');
    }
    executable = process.env.ComSpec || 'cmd.exe';
    commandArgs = ['/d', '/s', '/c', parts.join(' ')];
  }
  const result = spawnSync(executable, commandArgs, {
    cwd,
    stdio: 'inherit',
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

resetBuildDirectory(appStage);
resetBuildDirectory(dependencyStage);
fs.mkdirSync(releaseRoot, { recursive: true });

fs.writeFileSync(path.join(appStage, 'package.json'), `${JSON.stringify({
  name: packageJson.name,
  productName: 'Lavans',
  version: packageJson.version,
  private: true,
  main: packageJson.main
}, null, 2)}\n`);
fs.cpSync(path.join(projectRoot, 'electron'), path.join(appStage, 'electron'), { recursive: true });

const outputPaths = await packager({
  dir: appStage,
  name: 'Lavans',
  executableName: 'Lavans',
  appVersion: packageJson.version,
  buildVersion: packageJson.version,
  electronVersion: packageJson.devDependencies.electron,
  platform: 'win32',
  arch: 'x64',
  out: releaseRoot,
  overwrite: true,
  asar: true,
  prune: false,
  icon: path.join(projectRoot, 'electron', 'assets', 'logo.ico'),
  win32metadata: {
    CompanyName: 'Lavans',
    FileDescription: 'Lavans AI Creative Canvas',
    InternalName: 'Lavans',
    OriginalFilename: 'Lavans.exe',
    ProductName: 'Lavans'
  }
});

if (outputPaths.length !== 1) throw new Error(`Expected one Windows package, got ${outputPaths.length}`);
const outputRoot = outputPaths[0];
const outputResources = path.join(outputRoot, 'resources');

for (const directory of ['backend', 'frontend']) {
  const sourceRoot = path.join(projectRoot, 'resources', directory);
  fs.cpSync(
    sourceRoot,
    path.join(outputResources, directory),
    { recursive: true, filter: sourcePath => isSafeRuntimeResource(sourceRoot, sourcePath) }
  );
}
fs.copyFileSync(
  path.join(projectRoot, 'resources', '.env.example'),
  path.join(outputResources, '.env.example')
);

for (const filename of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
  fs.copyFileSync(path.join(projectRoot, filename), path.join(dependencyStage, filename));
}
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
run(pnpm, ['install', '--prod', '--frozen-lockfile', '--config.node-linker=hoisted'], dependencyStage);
fs.cpSync(
  path.join(dependencyStage, 'node_modules'),
  path.join(outputResources, 'node_modules'),
  { recursive: true, dereference: true }
);

const required = [
  path.join(outputRoot, 'Lavans.exe'),
  path.join(outputResources, 'app.asar'),
  path.join(outputResources, 'frontend', 'index.html'),
  path.join(outputResources, 'backend', 'server.js'),
  path.join(outputResources, 'node_modules', 'express', 'package.json')
];
for (const requiredPath of required) {
  if (!fs.existsSync(requiredPath)) throw new Error(`Missing packaged file: ${requiredPath}`);
}

fs.rmSync(appStage, { recursive: true, force: true });
fs.rmSync(dependencyStage, { recursive: true, force: true });
console.log(`Lavans package created: ${outputRoot}`);
