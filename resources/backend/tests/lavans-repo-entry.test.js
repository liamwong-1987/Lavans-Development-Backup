const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
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
  const backendStartAt = main.indexOf('require(backendPath)');

  assert.notEqual(lockAt, -1);
  assert.ok(lockAt < backendStartAt);
  assert.match(main, /if \(!gotTheLock\) \{\s*app\.quit\(\);\s*\} else \{/);
  assert.match(main, /app\.on\('second-instance',[\s\S]*mainWindow\.restore\(\)[\s\S]*mainWindow\.show\(\)[\s\S]*mainWindow\.focus\(\)/);
  assert.doesNotMatch(main, /killPort\d+|taskkill|netstat/);
  assert.match(main, /const PREFERRED_PORT = 43127/);
  assert.match(main, /const LAST_PORT = 43147/);
  assert.match(main, /process\.env\.PORT = String\(PREFERRED_PORT\)/);
  assert.match(main, /process\.env\.PORT_RANGE_END = String\(LAST_PORT\)/);
  assert.match(main, /appPort = started\.port/);
  assert.match(main, /mainWindow\.loadURL\(appUrl\(\)\)/);
  assert.equal((main.match(/port: appPort/g) || []).length, 2);

  let quitCount = 0;
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
      return require(id);
    }
  }, { filename: 'electron/main.js' });

  assert.equal(quitCount, 1);
});

test('后端在首选端口被占用时安全递增且不结束占用者', async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-port-'));
  const occupier = net.createServer();
  let child;
  try {
    await new Promise((resolve, reject) => {
      occupier.once('error', reject);
      occupier.listen(0, resolve);
    });
    const firstPort = occupier.address().port;
    const lastPort = Math.min(firstPort + 20, 65535);
    assert.ok(lastPort > firstPort, '测试首选端口必须留有安全递增空间');

    for (const name of ['output', 'uploads', 'logs']) {
      fs.mkdirSync(path.join(runtimeRoot, name), { recursive: true });
    }
    child = spawn(process.execPath, [path.join(root, 'resources', 'backend', 'server.js')], {
      cwd: path.join(root, 'resources', 'backend'),
      env: {
        ...process.env,
        PORT: String(firstPort),
        PORT_RANGE_END: String(lastPort),
        OUTPUT_DIR: path.join(runtimeRoot, 'output'),
        UPLOAD_DIR: path.join(runtimeRoot, 'uploads'),
        LOG_DIR: path.join(runtimeRoot, 'logs')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const selectedPort = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`后端启动超时\n${output}`)), 10000);
      const collect = chunk => {
        output += chunk.toString();
        const match = output.match(/http:\/\/localhost:(\d+)/);
        if (!match) return;
        clearTimeout(timer);
        resolve(Number(match[1]));
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`后端提前退出 ${code}\n${output}`));
      });
    });

    assert.ok(selectedPort > firstPort && selectedPort <= lastPort);
    assert.equal(occupier.listening, true);
    const statusCode = await new Promise((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${selectedPort}/`, response => {
        response.resume();
        resolve(response.statusCode);
      });
      request.once('error', reject);
    });
    assert.equal(statusCode, 200);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    if (occupier.listening) await new Promise(resolve => occupier.close(resolve));
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('独立启动脚本使用新端口并在冲突时安全退出', () => {
  const launcher = read('resources/backend/启动.bat');

  assert.match(launcher, /set PORT=43127/);
  assert.match(launcher, /set PORT_RANGE_END=43127/);
  assert.match(launcher, /Port 43127 is already in use/);
  assert.doesNotMatch(launcher, /taskkill/i);
  assert.doesNotMatch(launcher, /3001/);
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
