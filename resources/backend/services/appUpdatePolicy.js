const REPOSITORY = 'liamwong-1987/Lavans-Development-Backup';
const BRANCH = 'main';
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const BLOCKED_DIRECTORIES = [
  'resources/backend/output/',
  'resources/backend/uploads/',
  'resources/backend/logs/',
  'resources/backend/cache/',
  'resources/backend/agent-skills/imported/',
  'resources/backend/tests/'
];

const BLOCKED_FILES = new Set([
  'resources/backend/asset-library.json',
  'resources/backend/canvas-config.json',
  'resources/backend/config.json',
  'resources/backend/creative-config.json',
  'resources/backend/creative-history.json',
  'resources/backend/sessions.json'
]);

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function normalizeVersion(value) {
  const version = String(value || '').trim();
  if (!VERSION_PATTERN.test(version)) throw new Error('版本号必须使用 x.y.z 格式');
  return version;
}

function compareVersions(left, right) {
  const a = normalizeVersion(left).split('.').map(Number);
  const b = normalizeVersion(right).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function isAllowedUpdatePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) return false;
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//')) return false;
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes(':')
    || segment.endsWith('.') || segment.endsWith(' ') || WINDOWS_RESERVED_NAME.test(segment))) return false;

  const relativePath = segments.join('/');
  const lower = relativePath.toLowerCase();
  if (relativePath === 'VERSION') return true;
  if (!lower.startsWith('resources/backend/') && !lower.startsWith('resources/frontend/')) return false;
  if (BLOCKED_DIRECTORIES.some(prefix => lower.startsWith(prefix))) return false;
  if (BLOCKED_FILES.has(lower)) return false;

  const filename = segments.at(-1).toLowerCase();
  if (filename === '.env' || filename.startsWith('.env.')) return false;
  if (filename.endsWith('.log') || filename.endsWith('.bak') || filename.includes('.before-')) return false;
  return true;
}

module.exports = {
  REPOSITORY,
  BRANCH,
  VERSION_PATTERN,
  normalizeVersion,
  compareVersions,
  isAllowedUpdatePath
};
