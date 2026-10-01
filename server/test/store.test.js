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

test('嵌套声称的冻结记录：evidence 保留两级同余与第 0 步 declared 依据', () => {
  const store = new AuditStore();
  const payload = {
    auditId: 'AUDIT-NESTED-1',
    constants: ['a', 'b'],
    functions: { f: 1, g: 1 },
    steps: [
      { op: 'eq', left: 'a', right: 'b' }, // 第 0 步：基础声明
      { op: 'claim', left: 'g(f(a))', right: 'g(f(b))' }, // 第 1 步：两级嵌套声称
    ],
  };
  const { status, body } = store.submit(payload);
  assert.equal(status, 200);
  assert.equal(body.accepted, true);
  assert.equal(body.verdict, 'equal');

  const evidence = body.latestClaim.evidence;
  assert.ok(Array.isArray(evidence), '冻结记录必须携带可展开依据');

  // g 的同余边：g(f(a)) ~ g(f(b))，实参配对 f(a)/f(b)
  const gEdge = evidence.find((e) => e.kind === 'congruence' && e.function === 'g');
  assert.ok(gEdge, '缺少 g 的同余边');
  assert.ok(gEdge.matchedArguments.some((m) => m.arg === 'f(a)' && m.congruentTo === 'f(b)'));

  // f 的同余边：f(a) ~ f(b)，实参配对 a/b
  const fEdge = evidence.find((e) => e.kind === 'congruence' && e.function === 'f');
  assert.ok(fEdge, '缺少 f 的同余边');
  assert.ok(fEdge.matchedArguments.some((m) => m.arg === 'a' && m.congruentTo === 'b'));

  // 第 0 步 declared 边：a = b，两级同余传播的共同基础
  const declared = evidence.find((e) => e.kind === 'declared');
  assert.ok(declared, '缺少支撑 f(a)=f(b) 的第 0 步 declared 边');
  assert.equal(declared.step, 0);
  assert.deepEqual([declared.left, declared.right].sort(), ['a', 'b']);

  // 重传回放同一份冻结依据，审查员看到的证据不变
  const replay = store.submit(payload);
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(replay.body.latestClaim.evidence, evidence);
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
