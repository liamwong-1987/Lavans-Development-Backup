const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Lavans 根入口使用干净的开发资源路径和应用身份', () => {
  const pkg = JSON.parse(read('package.json'));
  const main = read('electron/main.js');

  assert.equal(pkg.name, 'lavans');
  assert.equal(pkg.main, 'electron/main.js');
  assert.equal(pkg.scripts.start, 'electron .');
  assert.match(main, /app\.isPackaged/);
  assert.match(main, /path\.resolve\(__dirname, '\.\.', 'resources'\)/);
  assert.match(main, /app\.setName\(BRAND\.appName\)/);
});

test('桌面入口只允许一个实例并由主实例恢复窗口', () => {
  const main = read('electron/main.js');
  const lockAt = main.indexOf('app.requestSingleInstanceLock()');
  const portCleanupAt = main.indexOf('killPort3001();');

  assert.notEqual(lockAt, -1);
  assert.ok(lockAt < portCleanupAt);
  assert.match(main, /if \(!gotTheLock\) \{\s*app\.quit\(\);\s*\} else \{/);
  assert.match(main, /app\.on\('second-instance',[\s\S]*mainWindow\.restore\(\)[\s\S]*mainWindow\.show\(\)[\s\S]*mainWindow\.focus\(\)/);

  let quitCount = 0;
  const executedCommands = [];
  vm.runInNewContext(main, {
    __dirname: path.join(root, 'electron'),
    require(id) {
      if(id === 'electron') return {
        app: {
          isPackaged: false,
          setName() {},
          requestSingleInstanceLock: () => false,
          quit: () => { quitCount += 1; }
        }
      };
      if(id === 'child_process') return { execSync: command => { executedCommands.push(command); } };
      return require(id);
    }
  }, { filename: 'electron/main.js' });

  assert.equal(quitCount, 1);
  assert.deepEqual(executedCommands, []);
});

test('Electron 预加载与外壳只暴露 Lavans 命名接口', () => {
  const preload = read('electron/preload.js');
  const shell = read('electron/shell.html');

  assert.match(preload, /lavansWindow/);
  assert.match(preload, /lavansNav/);
  assert.match(shell, /window\.lavansWindow/);
  assert.match(shell, /window\.lavansNav/);
  assert.doesNotMatch(preload + shell, /chroma/i);
});

test('画布适配器文件、全局名与加载入口同步迁移', () => {
  const adapterPath = path.join(root, 'resources', 'frontend', 'smart-canvas-core', 'adapters', 'lavans-canvas-adapter.js');
  const oldAdapterPath = path.join(root, 'resources', 'frontend', 'smart-canvas-core', 'adapters', 'chroma-canvas-adapter.js');
  const html = read('resources/frontend/smart-canvas-core/smart-canvas.html');
  const adapter = fs.readFileSync(adapterPath, 'utf8');

  assert.equal(fs.existsSync(adapterPath), true);
  assert.equal(fs.existsSync(oldAdapterPath), false);
  assert.match(html, /adapters\/lavans-canvas-adapter\.js/);
  assert.match(adapter, /LavansCanvasAdapter/);
});

test('用户可见品牌由静态源直接提供，不再运行时扫描改名', () => {
  const brand = read('resources/frontend/brand-config.js');
  const index = read('resources/frontend/index.html');
  const unified = read('resources/frontend/lanvas-unified.js');

  assert.match(brand, /name: 'Lavans'/);
  assert.match(brand, /title: 'Lavans — AI Creative Canvas'/);
  assert.match(index, /<title>Lavans — AI Creative Canvas<\/title>/);
  assert.doesNotMatch(unified, /replaceVisibleBrand/);
});
