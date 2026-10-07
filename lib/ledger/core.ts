// 核验台账核心：纯函数，不依赖 React / Zustand，可独立测试。
// 一本台账 = 追加式编号流水（Entry[]），签字、执行结果、审计记录同册登记。

export type SignRole = 'analyst' | 'responder' | 'legal';
export const SIGN_ROLES: SignRole[] = ['analyst', 'responder', 'legal'];
export const ROLE_NAMES: Record<SignRole, string> = {
  analyst: '分析员',
  responder: '响应负责人',
  legal: '法务/公关',
};

export type Severity = 'medium' | 'high' | 'critical';
export const SEVERITY_NAMES: Record<Severity, string> = {
  medium: '中',
  high: '高',
  critical: '极高',
};
export type Outcome = 'isolated' | 'failed';
export const OUTCOME_NAMES: Record<Outcome, string> = { isolated: '已隔离', failed: '隔离失败' };

export interface ScopeSpec {
  severity: Severity;
  affected: string[]; // 受影响网段，规范化后去重排序
}

export interface Entry {
  seq: number; // 全局唯一编号，重连合并后仍按编号排列
  taskId: string;
  kind: 'signature' | 'execution' | 'audit';
  opId: string; // 提交端生成的操作编号，断网重连重复投递时去重
  clientId: string; // 来源终端
  basisSig: number; // 登记时所依据的作用域版本
  at: string; // 登记时刻

  // 签字
  role?: SignRole;
  signedAt?: string; // 签字时刻
  supersededBy?: number; // 同角色冲突时，生效签字（较早签字时刻）的编号
  voided?: boolean; // 作用域变更后作废
  voidReason?: 'scope-changed';

  // 执行结果
  segment?: string;
  executedAt?: string; // 执行时刻
  outcome?: Outcome;
  operator?: string;

  // 审计
  text?: string;
  decision?: 'confirmed' | 'returned';
}

export interface Hub {
  taskId: string;
  title: string;
  scopeSig: number;
  scope: ScopeSpec;
  entries: Entry[];
  nextSeq: number;
  seenOps: Record<string, number>; // opId -> seq，at-least-once 投递去重
}

export interface Op {
  opId: string;
  clientId: string;
  at: string;
  type: 'sign' | 'execute' | 'audit' | 'scope-change';
  taskId: string;
  basisSig?: number; // 终端提交时依据的作用域版本；缺失时按主台账当前版本计
  role?: SignRole;
  signedAt?: string;
  segment?: string;
  executedAt?: string;
  outcome?: Outcome;
  operator?: string;
  text?: string;
  decision?: 'confirmed' | 'returned';
  scope?: ScopeSpec;
}

export interface ApplyResult {
  hub: Hub;
  touched: Entry[]; // 新增或被改写、需要落盘的条目
  deduped: boolean; // 是否为重复提交（opId 已见过）
}

export function normalizeScope(scope: ScopeSpec): ScopeSpec {
  return {
    severity: scope.severity,
    affected: Array.from(new Set(scope.affected.map((s) => s.trim()).filter(Boolean))).sort(),
  };
}

export function isSameScope(a: ScopeSpec, b: ScopeSpec): boolean {
  const x = normalizeScope(a);
  const y = normalizeScope(b);
  return x.severity === y.severity && x.affected.length === y.affected.length && x.affected.every((s, i) => s === y.affected[i]);
}

let fallbackCounter = 0;
export function uid(prefix = 'op'): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return `${prefix}-${g.crypto.randomUUID()}`;
  fallbackCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackCounter}`;
}

/** 重算某任务某角色在当前作用域版本下的冲突关系：只留签字时刻最早的一条，其余记为冲突记录。 */
function recomputeRoleSignatures(entries: Entry[], taskId: string, role: SignRole, scopeSig: number): Entry[] {
  const group = entries.filter(
    (e) => e.kind === 'signature' && e.taskId === taskId && e.role === role && !e.voided && e.basisSig === scopeSig,
  );
  if (group.length <= 1) return entries.map((e) => (group.includes(e) && e.supersededBy !== undefined ? { ...e, supersededBy: undefined } : e));
  let winner = group[0];
  for (const e of group) {
    if (e.signedAt! < winner.signedAt! || (e.signedAt === winner.signedAt && e.seq < winner.seq)) winner = e;
  }
  return entries.map((e) => (group.includes(e) ? { ...e, supersededBy: e.seq === winner.seq ? undefined : winner.seq } : e));
}

/** 服务端（主台账）应用一条操作。重复 opId 直接幂等忽略。 */
export function applyOp(hub: Hub, op: Op): ApplyResult {
  if (hub.seenOps[op.opId] !== undefined) return { hub, touched: [], deduped: true };

  const seq = hub.nextSeq;
  let entries = hub.entries;
  let scope = hub.scope;
  let scopeSig = hub.scopeSig;
  const row: Entry = { seq, taskId: op.taskId, kind: 'audit', opId: op.opId, clientId: op.clientId, basisSig: op.basisSig ?? hub.scopeSig, at: op.at };
  let touched: Entry[] = [];

  if (op.type === 'sign' && op.role && op.signedAt) {
    row.kind = 'signature';
    row.role = op.role;
    row.signedAt = op.signedAt;
    // 离线终端按旧版本签的字，重连时版本已变：登记为作废，不得冒充当前版本签字。
    if (row.basisSig !== hub.scopeSig) {
      row.voided = true;
      row.voidReason = 'scope-changed';
      entries = [...entries, row];
      const note: Entry = {
        seq: seq + 1,
        taskId: op.taskId,
        kind: 'audit',
        opId: `${op.opId}-stale`,
        clientId: 'hub',
        basisSig: hub.scopeSig,
        at: op.at,
        text: `编号 ${seq} 的${ROLE_NAMES[op.role]}签字依据第 ${row.basisSig} 版作用域（当前第 ${hub.scopeSig} 版），登记即作废，退回待确认。`,
      };
      entries = [...entries, note];
      touched = [row, note];
      return {
        hub: { ...hub, entries, nextSeq: seq + 2, scope, scopeSig, seenOps: { ...hub.seenOps, [op.opId]: seq, [note.opId]: note.seq } },
        touched,
        deduped: false,
      };
    }
    entries = [...entries, row];
    const before = new Map(entries.map((e) => [e.seq, e]));
    entries = recomputeRoleSignatures(entries, op.taskId, op.role, scopeSig);
    // 只有内容真正变化的行（新增行或冲突关系被改判的行）才需要落盘
    touched = entries.filter((e) => {
      if (e.seq === seq) return true;
      const old = before.get(e.seq);
      return old !== undefined && (old.supersededBy ?? 0) !== (e.supersededBy ?? 0);
    });
  } else if (op.type === 'execute' && op.segment && op.executedAt) {
    row.kind = 'execution';
    row.segment = op.segment;
    row.executedAt = op.executedAt;
    row.outcome = op.outcome;
    row.operator = op.operator;
    entries = [...entries, row];
    touched = [row];
  } else if (op.type === 'audit') {
    row.kind = 'audit';
    row.text = op.text;
    row.decision = op.decision;
    entries = [...entries, row];
    touched = [row];
  } else if (op.type === 'scope-change' && op.scope) {
    const next = normalizeScope(op.scope);
    scopeSig = hub.scopeSig + 1;
    scope = next;
    const voidedIds: number[] = [];
    entries = entries.map((e) => {
      if (e.kind === 'signature' && e.taskId === op.taskId && !e.voided) {
        voidedIds.push(e.seq);
        return { ...e, voided: true as const, voidReason: 'scope-changed' as const, supersededBy: undefined };
      }
      return e;
    });
    row.kind = 'audit';
    row.basisSig = scopeSig;
    row.text =
      `敏感级别/影响范围变更为第 ${scopeSig} 版（${SEVERITY_NAMES[next.severity]} · ${next.affected.join('、') || '无网段'}），` +
      `在途签字 ${voidedIds.length} 条（编号 ${voidedIds.join('、') || '无'}）随即作废，退回待确认。`;
    entries = [...entries, row];
    touched = [row, ...entries.filter((e) => voidedIds.includes(e.seq))];
  } else {
    // 非法操作不分配编号
    return { hub, touched: [], deduped: false };
  }

  return {
    hub: { ...hub, entries, nextSeq: seq + 1, scope, scopeSig, seenOps: { ...hub.seenOps, [op.opId]: seq } },
    touched,
    deduped: false,
  };
}

export function createHub(taskId: string, title: string, scopeInput: ScopeSpec, now: string, opId = uid('reg')): Hub {
  const scope = normalizeScope(scopeInput);
  const register: Entry = {
    seq: 1,
    taskId,
    kind: 'audit',
    opId,
    clientId: 'hub',
    basisSig: 0,
    at: now,
    text: `建账：${title}；敏感级别 ${SEVERITY_NAMES[scope.severity]}；受影响网段 ${scope.affected.join('、')}。三角色签字、逐网段执行结果（含执行时刻）、审计记录齐全方可确认。`,
  };
  return { taskId, title, scopeSig: 0, scope, entries: [register], nextSeq: 2, seenOps: { [opId]: 1 } };
}

export interface RoleCheck {
  ok: boolean;
  winner?: Entry;
  reason?: string;
}
export interface SegmentCheck {
  segment: string;
  ok: boolean;
  result?: Entry;
  reason?: string;
}
export interface Evaluation {
  status: 'confirmed' | 'pending';
  roleChecks: Record<SignRole, RoleCheck>;
  segmentChecks: SegmentCheck[];
  auditOk: boolean;
  conflicts: Entry[]; // 被更早签字压掉的重复签字（保留为冲突记录）
  voided: Entry[]; // 作用域变更后作废的在途签字
  missing: string[];
  lastDecision?: Extract<Entry, { decision?: string }>;
}

/** 核验：三角色当前版本生效签字齐全、每个受影响网段都有成功执行结果与执行时刻、审计记录在位。 */
export function evaluateTask(hub: Hub): Evaluation {
  const active = hub.entries.filter((e) => e.taskId === hub.taskId && !e.voided && e.basisSig === hub.scopeSig);
  const roleChecks = {} as Record<SignRole, RoleCheck>;
  const missing: string[] = [];

  for (const role of SIGN_ROLES) {
    const winners = active.filter((e) => e.kind === 'signature' && e.role === role && e.supersededBy === undefined);
    const winner = winners.sort((a, b) => (a.signedAt! < b.signedAt! ? -1 : 1))[0];
    if (winner) {
      roleChecks[role] = { ok: true, winner };
    } else {
      roleChecks[role] = { ok: false, reason: '缺少当前版本签字' };
      missing.push(`${ROLE_NAMES[role]}签字`);
    }
  }

  const segmentChecks: SegmentCheck[] = hub.scope.affected.map((segment) => {
    const results = hub.entries
      .filter((e) => e.kind === 'execution' && e.taskId === hub.taskId && e.segment === segment && !e.voided)
      .sort((a, b) => (a.executedAt! < b.executedAt! ? 1 : -1));
    const result = results[0];
    if (!result) return { segment, ok: false, reason: '无执行结果' };
    if (!result.executedAt) return { segment, ok: false, result, reason: '执行时刻未登记' };
    if (result.outcome !== 'isolated') return { segment, ok: false, result, reason: '执行结果为失败' };
    return { segment, ok: true, result };
  });
  for (const check of segmentChecks) {
    if (!check.ok) missing.push(`网段 ${check.segment}${check.reason ? `（${check.reason}）` : ''}`);
  }

  const auditOk = hub.entries.some((e) => e.kind === 'audit' && e.taskId === hub.taskId && e.basisSig === hub.scopeSig);
  if (!auditOk) missing.push('当前版本审计记录');

  const conflicts = active.filter((e) => e.kind === 'signature' && e.supersededBy !== undefined);
  const voided = hub.entries.filter((e) => e.kind === 'signature' && e.taskId === hub.taskId && e.voided);
  const lastDecision = [...hub.entries].reverse().find((e) => e.kind === 'audit' && e.decision) as Entry | undefined;

  return {
    status: missing.length === 0 ? 'confirmed' : 'pending',
    roleChecks,
    segmentChecks,
    auditOk,
    conflicts,
    voided,
    missing,
    lastDecision,
  };
}
