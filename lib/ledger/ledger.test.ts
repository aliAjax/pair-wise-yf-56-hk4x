import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOp, createHub, evaluateTask, SIGN_ROLES, type Entry, type Hub, type Op } from './core';
import { LedgerEngine, type LedgerSink } from './engine';

const SEGMENTS = ['seg-a', 'seg-b'];
const at = (ms: number) => new Date(ms).toISOString();

class ScriptedSink implements LedgerSink {
  constructor(private script: Array<Set<number> | 'throw'> = []) {}
  calls = 0;
  written = new Map<number, Entry>();
  async writeRows(rows: Entry[]): Promise<{ okSeqs: number[]; failedSeqs: number[] }> {
    const step = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls += 1;
    if (step === 'throw') throw new Error('磁盘不可用');
    const okSeqs: number[] = [];
    const failedSeqs: number[] = [];
    for (const row of rows) {
      if (step && step.has(row.seq)) failedSeqs.push(row.seq);
      else {
        this.written.set(row.seq, row);
        okSeqs.push(row.seq);
      }
    }
    return { okSeqs, failedSeqs };
  }
}

function newEngine(script: ScriptedSink['script'] = []): LedgerEngine {
  const hub = createHub('T-1', '隔离核验', { severity: 'high', affected: SEGMENTS }, at(1_000));
  return new LedgerEngine(hub, new ScriptedSink(script));
}

async function fillAllSignatures(engine: LedgerEngine, base = 2_000): Promise<void> {
  SIGN_ROLES.forEach((role, i) => engine.sign({ clientId: `term-${role}`, role, signedAt: at(base + i) }));
  await Promise.resolve();
}
async function isolateAllSegments(engine: LedgerEngine, base = 5_000): Promise<void> {
  SEGMENTS.forEach((segment, i) => engine.execute({ clientId: 'term-ops', segment, outcome: 'isolated', executedAt: at(base + i) }));
  await Promise.resolve();
}

test('规则一：三角色签字 + 逐网段执行结果（含执行时刻）+ 审计齐全才确认，缺一项退回待办', async () => {
  const engine = newEngine();
  await fillAllSignatures(engine);
  let ev = evaluateTask(engine.hub);
  assert.equal(ev.status, 'pending');
  assert.deepEqual(ev.missing, ['网段 seg-a（无执行结果）', '网段 seg-b（无执行结果）']);

  await isolateAllSegments(engine);
  ev = evaluateTask(engine.hub);
  assert.equal(ev.status, 'confirmed');
  assert.equal(ev.segmentChecks.every((s) => s.ok && s.result?.executedAt), true);
  assert.equal(ev.auditOk, true);
});

test('规则一：缺一个角色签字或执行结果为失败，均不得确认', async () => {
  const engine = newEngine();
  engine.sign({ clientId: 't1', role: 'analyst', signedAt: at(100) });
  engine.sign({ clientId: 't1', role: 'responder', signedAt: at(101) });
  engine.execute({ clientId: 't1', segment: 'seg-a', outcome: 'isolated', executedAt: at(200) });
  engine.execute({ clientId: 't1', segment: 'seg-b', outcome: 'failed', executedAt: at(201) });
  await Promise.resolve();
  const ev = evaluateTask(engine.hub);
  assert.equal(ev.status, 'pending');
  assert.ok(ev.missing.includes('法务/公关签字'));
  assert.ok(ev.missing.some((m) => m.includes('seg-b') && m.includes('失败')));
});

test('规则二：敏感级别或影响范围变更，在途签字全部作废、退回待确认，需重新集齐', async () => {
  const engine = newEngine();
  await fillAllSignatures(engine);
  engine.changeScope({ clientId: 'term-cmd', scope: { severity: 'critical', affected: SEGMENTS }, at: at(3_000) });
  let ev = evaluateTask(engine.hub);
  assert.equal(ev.status, 'pending');
  assert.equal(ev.voided.length, 3);
  assert.ok(ev.missing.includes('分析员签字'));
  assert.equal(engine.hub.scopeSig, 1);

  // 新版本重新签齐，执行结果仍按网段留用，核验即可恢复
  SIGN_ROLES.forEach((role, i) => engine.sign({ clientId: `term-${role}`, role, signedAt: at(4_000 + i) }));
  await isolateAllSegments(engine);
  await Promise.resolve();
  ev = evaluateTask(engine.hub);
  assert.equal(ev.status, 'confirmed');
  assert.equal(ev.voided.length, 3); // 旧签字仍留痕
});

test('规则二：影响范围新增网段，旧签字作废且新网段缺执行结果', async () => {
  const engine = newEngine();
  await fillAllSignatures(engine);
  await isolateAllSegments(engine);
  assert.equal(evaluateTask(engine.hub).status, 'confirmed');
  engine.changeScope({ clientId: 't', scope: { severity: 'high', affected: ['seg-a', 'seg-b', 'seg-c'] }, at: at(6_000) });
  const ev = evaluateTask(engine.hub);
  assert.equal(ev.status, 'pending');
  assert.ok(ev.missing.some((m) => m.includes('seg-c')));
});

test('规则三：两台终端同角色签字，只留签字时刻较早的；其他角色更早签字不受影响，重复者留冲突记录', async () => {
  const engine = newEngine();
  engine.sign({ clientId: 'term-A', role: 'analyst', signedAt: at(5_000) });
  engine.sign({ clientId: 'term-B', role: 'analyst', signedAt: at(4_000) }); // 更早，尽管晚提交
  engine.sign({ clientId: 'term-C', role: 'responder', signedAt: at(3_000) });
  await Promise.resolve();

  const sigs = engine.hub.entries.filter((e) => e.kind === 'signature').sort((a, b) => a.seq - b.seq);
  assert.equal(sigs[0].supersededBy, sigs[1].seq); // term-A 的被 term-B 压掉
  assert.equal(sigs[1].supersededBy, undefined);
  assert.equal(sigs[2].supersededBy, undefined); // responder 的更早签字照常生效

  const ev = evaluateTask(engine.hub);
  assert.equal(ev.conflicts.length, 1);
  assert.equal(ev.conflicts[0].clientId, 'term-A');
  assert.equal(ev.roleChecks.analyst.winner?.clientId, 'term-B');
});

test('规则三：后来的签字时刻更早时，冲突关系即时改判（以时刻而非提交先后为准）', async () => {
  const engine = newEngine();
  engine.sign({ clientId: 'A', role: 'legal', signedAt: at(1_000) });
  engine.sign({ clientId: 'B', role: 'legal', signedAt: at(2_000) });
  engine.sign({ clientId: 'C', role: 'legal', signedAt: at(900) });
  await Promise.resolve();
  const ev = evaluateTask(engine.hub);
  assert.equal(ev.conflicts.length, 2);
  assert.equal(ev.roleChecks.legal.winner?.clientId, 'C');
});

test('规则四：断网期间签字与登记结果，重连按编号合并；重复提交只算一次', async () => {
  const engine = newEngine();
  engine.setOnline(false);
  engine.sign({ clientId: 'laptop-1', role: 'analyst', signedAt: at(2_000), at: at(2_000) });
  engine.execute({ clientId: 'laptop-1', segment: 'seg-a', outcome: 'isolated', executedAt: at(2_500), at: at(2_500) });
  // 同一操作在重投时使用相同 opId（断网恢复后 at-least-once 重发）
  const replay: Op = {
    opId: 'sig-replay', clientId: 'laptop-2', at: at(3_000), type: 'sign', taskId: 'T-1', role: 'responder', signedAt: at(3_000),
  };
  engine.sign({ clientId: 'laptop-2', role: 'responder', signedAt: at(3_000), at: at(3_000), opId: 'sig-replay' });

  const summary = engine.setOnline(true)!;
  assert.equal(summary.applied, 3);
  assert.equal(summary.deduped, 0);

  // 重连后又收到同 opId 的重发：编号不变，只算一次
  const again = applyOp(engine.hub, replay);
  assert.equal(again.deduped, true);
  assert.equal(engine.hub.nextSeq, summary.auditSeq! + 1);

  engine.sign({ clientId: 't', role: 'legal', signedAt: at(4_000) });
  engine.execute({ clientId: 't', segment: 'seg-b', outcome: 'isolated', executedAt: at(4_500) });
  await Promise.resolve();
  assert.equal(evaluateTask(engine.hub).status, 'confirmed');
  assert.ok(engine.hub.entries.some((e) => e.kind === 'audit' && e.text?.includes('重连合并完成')));
});

test('规则四：断网期间作用域已变更，旧版本离线签字重连后作废，不冒充新版本', async () => {
  const engine = newEngine();
  engine.setOnline(false);
  engine.sign({ clientId: 'laptop-1', role: 'analyst', signedAt: at(2_000), at: at(2_000) });
  // 指挥终端在另一处改了级别（离线队列里的版本变更）
  engine.changeScope({ clientId: 'cmd', scope: { severity: 'critical', affected: SEGMENTS }, at: at(2_200) });
  engine.sign({ clientId: 'laptop-1', role: 'responder', signedAt: at(2_400), at: at(2_400) });

  const summary = engine.setOnline(true)!;
  assert.equal(summary.applied, 3);
  const sigs = engine.hub.entries.filter((e) => e.kind === 'signature');
  assert.equal(sigs[0].voided, true); // 旧版分析员签字
  assert.equal(sigs[1].voided, true); // 新版前的 responder 也依据旧版本
  assert.ok(engine.hub.entries.some((e) => e.text?.includes('登记即作废')));
});

test('规则五：部分行写入失败，重试时只发没写完的条目，已写行不重复落盘', async () => {
  // 第 1 批：编号 2 失败；第 2 批（手动重试 2）成功；第 3 批：编号 3 失败；第 4 批（手动重试 3）成功
  const sink = new ScriptedSink([new Set([2]), new Set<number>(), new Set([3]), new Set<number>()]);
  const engine = new LedgerEngine(createHub('T-1', 'x', { severity: 'high', affected: SEGMENTS }, at(0)), sink);
  engine.sign({ clientId: 't', role: 'analyst', signedAt: at(10) }); // 新行编号 2，首批失败
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([...sink.written.keys()].sort(), []);
  assert.equal(engine.queueStatus, 'degraded');
  assert.equal(engine.queue[0].attempts, 1);

  await engine.flush(); // 只重试编号 2 → 成功
  assert.deepEqual([...sink.written.keys()].sort(), [2]);
  assert.equal(engine.queue.length, 0);
  assert.equal(engine.queueStatus, 'idle');

  // 下一批：编号 3 首次失败
  engine.sign({ clientId: 't', role: 'responder', signedAt: at(11) });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual([...sink.written.keys()].sort(), [2]);
  await engine.flush();
  assert.deepEqual([...sink.written.keys()].sort(), [2, 3]);
});

test('规则五：sink 整批抛错后所有行留在队列，下一轮整体补写', async () => {
  const sink = new ScriptedSink(['throw']);
  const engine = new LedgerEngine(createHub('T-1', 'x', { severity: 'high', affected: SEGMENTS }, at(0)), sink);
  engine.sign({ clientId: 't', role: 'analyst', signedAt: at(10) });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(engine.queue.length, 1);
  assert.equal(engine.queue[0].attempts, 1);
});

test('编号全局唯一且单调：合并后执行时刻、签字时刻、登记时刻分别留痕', async () => {
  const engine = newEngine();
  await fillAllSignatures(engine);
  await isolateAllSegments(engine);
  const seqs = engine.hub.entries.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
  const exec = engine.hub.entries.find((e) => e.kind === 'execution' && e.segment === 'seg-a')!;
  assert.ok(exec.executedAt && exec.at);
});
