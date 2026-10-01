'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuditStore } = require('../src/store');

const basePayload = () => ({
  auditId: 'AUDIT-001',
  constants: ['a', 'b'],
  functions: { f: 1 },
  steps: [
    { op: 'eq', left: 'a', right: 'b' },
    { op: 'claim', left: 'f(a)', right: 'f(b)' },
  ],
});

test('有效证明裁决 equal 并冻结', () => {
  const store = new AuditStore();
  const { status, body } = store.submit(basePayload());
  assert.equal(status, 200);
  assert.equal(body.accepted, true);
  assert.equal(body.verdict, 'equal');
  assert.ok(body.payloadHash.length === 64);
  assert.equal(body.failure, null);
});

test('嵌套同余声称：冻结裁决的 evidence 保留两级同余与原始 declared 依据', () => {
  const store = new AuditStore();
  const { status, body } = store.submit({
    auditId: 'AUDIT-NESTED-1',
    constants: ['a', 'b'],
    functions: { f: 1, g: 1 },
    steps: [
      { op: 'eq', left: 'a', right: 'b' }, // 第 0 步：基础声明
      { op: 'claim', left: 'g(f(a))', right: 'g(f(b))' }, // 嵌套声称
    ],
  });
  assert.equal(status, 200);
  assert.equal(body.accepted, true);
  assert.equal(body.verdict, 'equal');

  const evidence = body.latestClaim.evidence;
  // 两级同余边：g（主路径）与 f（支撑）
  const gEdge = evidence.find((e) => e.kind === 'congruence' && e.function === 'g');
  const fEdge = evidence.find((e) => e.kind === 'congruence' && e.function === 'f');
  assert.ok(gEdge, 'evidence 应包含 g 的同余边');
  assert.ok(fEdge, 'evidence 应包含 f 的同余边');
  assert.ok(gEdge.matchedArguments.some((m) => m.arg === 'f(a)' && m.congruentTo === 'f(b)'));
  assert.ok(fEdge.matchedArguments.some((m) => m.arg === 'a' && m.congruentTo === 'b'));
  // 原始 declared 依据：第 0 步 a = b
  const declared = evidence.find((e) => e.kind === 'declared');
  assert.ok(declared, 'evidence 应包含第 0 步 a=b 的 declared 边');
  assert.equal(declared.step, 0);
  assert.deepEqual([declared.left, declared.right].sort(), ['a', 'b']);

  // 重传回放同一份冻结证据，审查员看到的依据保持一致
  const replay = store.submit({
    auditId: 'AUDIT-NESTED-1',
    constants: ['a', 'b'],
    functions: { f: 1, g: 1 },
    steps: [
      { op: 'eq', left: 'a', right: 'b' },
      { op: 'claim', left: 'g(f(a))', right: 'g(f(b))' },
    ],
  });
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.latestClaim.evidence, evidence);
});

test('同标识同载荷重传：回放冻结结果', () => {
  const store = new AuditStore();
  const first = store.submit(basePayload());
  const frozenAt = first.body.frozenAt;
  const second = store.submit(basePayload());
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.frozenAt, frozenAt);
  assert.equal(second.body.payloadHash, first.body.payloadHash);
});

test('同标识改换载荷：明确拒绝（409）且保留旧冻结结果', () => {
  const store = new AuditStore();
  const first = store.submit(basePayload());
  const changed = basePayload();
  changed.steps = [{ op: 'claim', left: 'a', right: 'b' }];
  const rejected = store.submit(changed);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error, 'PAYLOAD_CHANGED');
  assert.notEqual(rejected.body.frozenPayloadHash, rejected.body.receivedPayloadHash);
  // 旧证据未被覆盖
  const again = store.submit(basePayload());
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.verdict, 'equal');
});

test('失败证明：定位失败步骤并清除页面旧证据（accepted=false, trace 截断）', () => {
  const store = new AuditStore();
  const payload = basePayload();
  payload.steps = [
    { op: 'eq', left: 'a', right: 'b' },
    { op: 'claim', left: 'a', right: 'f(a)' }, // 不成立
    { op: 'eq', left: 'a', right: 'f(a)' }, // 不应执行
  ];
  const { status, body } = store.submit(payload);
  assert.equal(status, 200);
  assert.equal(body.accepted, false);
  assert.equal(body.verdict, 'rejected');
  assert.equal(body.failure.index, 1);
  assert.equal(body.failure.code, 'CLAIM_FAILED');
  assert.equal(body.trace.length, 1); // 失败步及其后不进入轨迹
  assert.deepEqual(body.classes, []);
});

test('空栈弹出等结构性错误被定位到具体步骤', () => {
  const store = new AuditStore();
  const payload = basePayload();
  payload.steps = [{ op: 'push' }, { op: 'pop' }, { op: 'pop' }];
  const { body } = store.submit(payload);
  assert.equal(body.accepted, false);
  assert.equal(body.failure.index, 2);
  assert.equal(body.failure.code, 'EMPTY_STACK_POP');
});

test('未知符号 / 元数不符 / 超长轨迹在受理阶段拒绝', () => {
  const store = new AuditStore();
  let p = basePayload();
  p.auditId = 'X1';
  p.steps = [{ op: 'claim', left: 'a', right: 'z' }];
  assert.equal(store.submit(p).body.failure.code, 'UNKNOWN_SYMBOL');

  p = basePayload();
  p.auditId = 'X2';
  p.steps = [{ op: 'eq', left: 'f(a,b)', right: 'a' }];
  assert.equal(store.submit(p).body.failure.code, 'ARITY_MISMATCH');

  p = basePayload();
  p.auditId = 'X3';
  p.steps = Array.from({ length: 181 }, () => ({ op: 'push' }));
  assert.equal(store.submit(p).body.failure.code, 'TOO_MANY_STEPS');
});

test('失效作用域场景：pop 后声称失败被冻结记录', () => {
  const store = new AuditStore();
  const p = basePayload();
  p.auditId = 'SCOPE-9';
  p.steps = [
    { op: 'push' },
    { op: 'eq', left: 'a', right: 'b' },
    { op: 'pop' },
    { op: 'claim', left: 'f(a)', right: 'f(b)' },
  ];
  const { body } = store.submit(p);
  assert.equal(body.accepted, false);
  assert.equal(body.failure.index, 3);
  assert.equal(body.failure.code, 'CLAIM_FAILED');
});
