// 台账引擎：终端断网期间继续签字/登记结果（入本地 outbox），重连后按序提交，
// 主台账按编号合并、重复 opId 只算一次；落盘按行进行，写入失败只重试没写完的行。

import {
  applyOp,
  createHub,
  evaluateTask,
  uid,
  type ApplyResult,
  type Entry,
  type Hub,
  type Op,
  type Outcome,
  type ScopeSpec,
  type Severity,
  type SignRole,
} from './core';

export interface OutboxItem {
  op: Op;
  submittedAt: string; // 终端实际提交（按下按钮）时刻，断网时也会记录
}

/** 持久化行存储：按编号幂等 upsert。返回成功写入的编号。 */
export interface LedgerSink {
  writeRows(rows: Entry[]): Promise<{ okSeqs: number[]; failedSeqs: number[] }>;
}

export type QueueStatus = 'idle' | 'writing' | 'degraded';

export interface PendingRow {
  row: Entry;
  attempts: number;
  lastError?: string;
}

export interface ReconnectSummary {
  applied: number;
  deduped: number;
  auditSeq?: number;
}

export interface EngineSnapshot {
  hub: Hub;
  online: boolean;
  outbox: OutboxItem[];
  queue: PendingRow[];
  queueStatus: QueueStatus;
  lastReconnect?: { at: string; summary: ReconnectSummary };
}

type Listener = (engine: LedgerEngine) => void;

const nowIso = () => new Date().toISOString();

export class LedgerEngine {
  hub: Hub;
  online = true;
  outbox: OutboxItem[] = [];
  queue: PendingRow[] = [];
  queueStatus: QueueStatus = 'idle';
  lastReconnect?: { at: string; summary: ReconnectSummary };
  sink: LedgerSink;
  private listeners = new Set<Listener>();
  private flushToken = 0;

  constructor(hub: Hub, sink: LedgerSink) {
    this.hub = hub;
    this.sink = sink;
  }

  /** 注入部分写入失败（仅 LocalStorageSink 支持），用于验证只重试未写完的条目。 */
  armFault(rows: number): void {
    if (this.sink instanceof LocalStorageSink) LocalStorageSink.armFailures(rows);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn(this);
  }

  setOnline(online: boolean): ReconnectSummary | undefined {
    if (online === this.online) return undefined;
    this.online = online;
    let summary: ReconnectSummary | undefined;
    if (online) summary = this.drainOutbox();
    this.emit();
    void this.flush();
    return summary;
  }

  // —— 终端提交入口 ————————————————————————————————————————————
  sign(args: { clientId: string; role: SignRole; signedAt?: string; at?: string; opId?: string }): void {
    const at = args.at ?? nowIso();
    const op: Op = {
      opId: args.opId ?? uid('sig'),
      clientId: args.clientId,
      at,
      type: 'sign',
      taskId: this.hub.taskId,
      role: args.role,
      signedAt: args.signedAt ?? at,
    };
    this.dispatch(op, args.signedAt ?? at);
  }

  execute(args: { clientId: string; segment: string; outcome: Outcome; executedAt?: string; operator?: string; at?: string; opId?: string }): void {
    const at = args.at ?? nowIso();
    const op: Op = {
      opId: args.opId ?? uid('exe'),
      clientId: args.clientId,
      at,
      type: 'execute',
      taskId: this.hub.taskId,
      segment: args.segment,
      executedAt: args.executedAt ?? at,
      outcome: args.outcome,
      operator: args.operator,
    };
    this.dispatch(op, at);
  }

  /** 账目确认 / 退回待办，写审计结论。 */
  recordDecision(decision: 'confirmed' | 'returned', clientId: string, text: string, at?: string): void {
    const op: Op = { opId: uid('dec'), clientId, at: at ?? nowIso(), type: 'audit', taskId: this.hub.taskId, decision, text };
    this.dispatch(op, op.at);
  }

  changeScope(args: { clientId: string; scope: ScopeSpec; at?: string }): void {
    const at = args.at ?? nowIso();
    const op: Op = { opId: uid('scope'), clientId: args.clientId, at, type: 'scope-change', taskId: this.hub.taskId, scope: args.scope };
    this.dispatch(op, at);
  }

  /** 原始投递入口（测试与重放用）。 */
  submit(op: Op): ApplyResult | undefined {
    if (this.online) return this.applyAndQueue(op);
    this.outbox = [...this.outbox, { op, submittedAt: op.at }];
    this.emit();
    return undefined;
  }

  private dispatch(op: Op, submittedAt: string): void {
    if (this.online) {
      if (op.basisSig === undefined) op.basisSig = this.hub.scopeSig;
      this.applyAndQueue(op);
    } else {
      // 离线时只把“本终端”尚未过账的版本变更计入依据版本；
      // 别的终端离线做的变更本机并不知道，重连后按旧版本签的字会被记为作废。
      if (op.basisSig === undefined && op.type !== 'scope-change') {
        op.basisSig = this.hub.scopeSig + this.outbox.filter((item) => item.op.type === 'scope-change' && item.op.clientId === op.clientId).length;
      }
      this.outbox = [...this.outbox, { op, submittedAt }];
      this.emit();
    }
  }

  private applyAndQueue(op: Op): ApplyResult {
    const result = applyOp(this.hub, op);
    if (result.deduped) {
      this.emit();
      return result;
    }
    this.hub = result.hub;
    // 每个被新增/改写的行各占一个待写条目；重试行按编号幂等 upsert。
    const existing = new Map(this.queue.map((p, i) => [p.row.seq, i]));
    let queue = [...this.queue];
    for (const row of result.touched) {
      const idx = existing.get(row.seq);
      if (idx !== undefined) queue[idx] = { ...queue[idx], row };
      else queue.push({ row, attempts: 0 });
    }
    this.queue = queue;
    this.emit();
    void this.flush();
    return result;
  }

  /** 重连：按终端提交时刻顺序把 outbox 过账；重复 opId（含同终端重投/跨终端重发）只算一次。 */
  private drainOutbox(): ReconnectSummary {
    const pending = [...this.outbox].sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt === b.submittedAt ? (a.op.at < b.op.at ? -1 : 1) : 1));
    let applied = 0;
    let deduped = 0;
    for (const item of pending) {
      const result = applyOp(this.hub, item.op);
      if (result.deduped) {
        deduped += 1;
        continue;
      }
      this.hub = result.hub;
      const existing = new Map(this.queue.map((p, i) => [p.row.seq, i]));
      for (const row of result.touched) {
        const idx = existing.get(row.seq);
        if (idx !== undefined) this.queue[idx] = { ...this.queue[idx], row };
        else this.queue.push({ row, attempts: 0 });
      }
      applied += 1;
    }
    this.outbox = [];

    const evalResult = evaluateTask(this.hub);
    const at = nowIso();
    const audit: Op = {
      opId: uid('sync'),
      clientId: 'hub',
      at,
      type: 'audit',
      taskId: this.hub.taskId,
      text: `重连合并完成：按编号并入离线提交 ${applied} 条，重复提交去重 ${deduped} 条；当前核验状态：${evalResult.status === 'confirmed' ? '材料齐全可确认' : `缺项（${evalResult.missing.join('；')}），退回待办`}。`,
    };
    const auditResult = applyOp(this.hub, audit);
    let auditSeq: number | undefined;
    if (!auditResult.deduped) {
      this.hub = auditResult.hub;
      this.queue.push(...auditResult.touched.map((row) => ({ row, attempts: 0 })));
      auditSeq = auditResult.touched[0]?.seq;
    }

    const summary: ReconnectSummary = { applied, deduped, auditSeq };
    this.lastReconnect = { at, summary };
    this.emit();
    return summary;
  }

  /** 落盘：只把没写完的条目发给 sink；成功的移除，失败的留下次只重试这些。 */
  async flush(): Promise<void> {
    const token = ++this.flushToken;
    if (this.queue.length === 0) {
      this.queueStatus = 'idle';
      this.emit();
      return;
    }
    this.queueStatus = 'writing';
    this.emit();
    const pending = [...this.queue];
    let result: { okSeqs: number[]; failedSeqs: number[] };
    try {
      result = await this.sink.writeRows(pending.map((p) => p.row));
    } catch (error) {
      result = { okSeqs: [], failedSeqs: pending.map((p) => p.row.seq) };
      this.queue = pending.map((p) => ({ ...p, attempts: p.attempts + 1, lastError: error instanceof Error ? error.message : String(error) }));
      this.queueStatus = 'degraded';
      this.emit();
      return;
    }
    if (token !== this.flushToken) return; // 期间又有新 flush 调度，以新调度为准
    const ok = new Set(result.okSeqs);
    const failed = new Set(result.failedSeqs);
    this.queue = this.queue
      .filter((p) => !ok.has(p.row.seq))
      .map((p) => ({
        ...p,
        attempts: p.attempts + (failed.has(p.row.seq) ? 1 : 0),
        lastError: failed.has(p.row.seq) ? 'sink 报告该行写入失败' : undefined,
      }));
    // 最新行内容为准重写（例如签字行从普通变为冲突/作废）
    const latest = new Map<number, Entry>();
    for (const e of this.hub.entries) latest.set(e.seq, e);
    this.queue = this.queue.map((p) => ({ ...p, row: latest.get(p.row.seq) ?? p.row }));
    this.queueStatus = this.queue.length === 0 ? 'idle' : 'degraded';
    this.emit();
  }

  get evaluation() {
    return evaluateTask(this.hub);
  }

  snapshot(): EngineSnapshot {
    return { hub: this.hub, online: this.online, outbox: this.outbox, queue: this.queue, queueStatus: this.queueStatus, lastReconnect: this.lastReconnect };
  }

  static restore(snapshot: EngineSnapshot, sink: LedgerSink): LedgerEngine {
    const engine = new LedgerEngine(snapshot.hub, sink);
    engine.online = snapshot.online;
    engine.outbox = snapshot.outbox;
    engine.queue = snapshot.queue;
    engine.queueStatus = snapshot.queueStatus;
    engine.lastReconnect = snapshot.lastReconnect;
    return engine;
  }
}

/** 浏览器行存储：localStorage 按编号 upsert，整体视为可靠；预留故障注入用于演示部分失败。 */
export class LocalStorageSink implements LedgerSink {
  private key: string;
  private static pendingFailRows = 0;
  constructor(key = 'yf56-ledger-rows') {
    this.key = key;
  }
  /** 下一批写入时，让前 rows 行失败；未消耗完的额度跨批次保留。 */
  static armFailures(rows: number): void {
    LocalStorageSink.pendingFailRows = rows;
    try {
      localStorage.setItem('yf56-ledger-fault', String(rows));
    } catch {
      /* ignore */
    }
  }
  async writeRows(rows: Entry[]): Promise<{ okSeqs: number[]; failedSeqs: number[] }> {
    try {
      const armed = Number(localStorage.getItem('yf56-ledger-fault') ?? '0');
      if (armed > 0) LocalStorageSink.pendingFailRows = armed;
    } catch {
      /* ignore */
    }
    const stored: Record<string, Entry> = this.readAll();
    const okSeqs: number[] = [];
    const failedSeqs: number[] = [];
    let remaining = LocalStorageSink.pendingFailRows;
    rows.forEach((row, i) => {
      // 只让前若干行失败，验证“只重试没写完的条目”
      if (remaining > 0 && i < remaining) {
        remaining -= 1;
        failedSeqs.push(row.seq);
        return;
      }
      stored[String(row.seq)] = row;
      okSeqs.push(row.seq);
    });
    LocalStorageSink.pendingFailRows = remaining;
    try {
      if (remaining > 0) localStorage.setItem('yf56-ledger-fault', String(remaining));
      else localStorage.removeItem('yf56-ledger-fault');
    } catch {
      /* ignore */
    }
    if (failedSeqs.length === rows.length) throw new Error('本批全部未写入');
    localStorage.setItem(this.key, JSON.stringify(stored));
    return { okSeqs, failedSeqs };
  }
  readAll(): Record<string, Entry> {
    if (typeof localStorage === 'undefined') return {};
    try {
      return JSON.parse(localStorage.getItem(this.key) ?? '{}') as Record<string, Entry>;
    } catch {
      return {};
    }
  }
}

export function createDefaultEngine(now = nowIso()): LedgerEngine {
  const scope: ScopeSpec = { severity: 'critical' as Severity, affected: ['seg-dmz-01', 'seg-office-07', 'seg-vault-03'] };
  const hub = createHub('ISO-2026-1007-01', '对外网关异常凭证使用 · 网段隔离', scope, now, 'reg-bootstrap');
  return new LedgerEngine(hub, new LocalStorageSink());
}
