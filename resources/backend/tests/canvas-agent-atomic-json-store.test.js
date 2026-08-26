'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { atomicWriteJson } = require('../services/canvasAgentFoundation/atomicJsonStore');

function lockError(code) {
  return Object.assign(new Error(`fixture ${code}`), { code });
}

test('原子 JSON 写入会在短暂 Windows 锁定后完成同一次替换', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-atomic-json-'));
  const target = path.join(root, 'state.json');
  const originalRename = fs.renameSync;
  let attempts = 0;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.renameSync = (...args) => {
    attempts += 1;
    if (attempts < 3) throw lockError('EPERM');
    return Reflect.apply(originalRename, fs, args);
  };
  try {
    atomicWriteJson(target, { status: 'saved' });
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { status: 'saved' });
});

test('持续 Windows 锁定会在有限次数后失败并保留旧 JSON', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-atomic-json-'));
  const target = path.join(root, 'state.json');
  const original = '{"status":"old"}\n';
  const originalRename = fs.renameSync;
  let attempts = 0;
  fs.writeFileSync(target, original, 'utf8');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.renameSync = () => {
    attempts += 1;
    throw lockError('EBUSY');
  };
  try {
    assert.throws(() => atomicWriteJson(target, { status: 'new' }), error => error?.code === 'EBUSY');
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(attempts, 5);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
});
