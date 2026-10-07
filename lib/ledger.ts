// 核验台账：把签字、执行结果与审计记录接成一本账。
// 本文件只放纯逻辑（确认判定、冲突消解、断网合并、上下文作废旧签），不依赖 React。

export const LEDGER_ROLES = ['analyst', 'responder', 'legal'] as const;
export type LedgerRole = (typeof LEDGER_ROLES)[number];

export interface Signature {
  id: string;
  role: LedgerRole;
  at: string; // 签字时刻（ISO）
  terminalId: string; // 提交终端
  contextKey: string; // 签字时的敏感级别 + 影响范围快照
  status: 'active' | 'void' | 'conflict';
}

export interface ExecutionResult {
  id: string;
  segment: string; // 受影响网段
  at: string; // 执行时刻（ISO）
  result: 'success' | 'failed';
  terminalId: string;
  contextKey: string;
}

export interface ConflictRecord {
  id: string;
  role: string;
  at: string;
  keptId: string; // 保留下来的签字
  droppedId: string; // 被判为重复的签字
  reason: 'same-role-duplicate';
}

export interface LedgerEntry {
  id: string; // 台账编号
  actionId: string; // 关联处置动作
  title: string;
  signatures: Signature[];
  results: ExecutionResult[];
  conflicts: ConflictRecord[];
  status: 'pending' | 'confirmed'; // 待办/待确认 | 已确认
  writeState: 'idle' | 'writing' | 'written' | 'failed';
  lastError?: string;
  confirmedAt?: string;
}

export interface OutboxItem {
  id: string; // 编号，重连后按此合并去重
  kind: 'signature' | 'result';
  actionId: string;
  at: string;
  payload: Signature | ExecutionResult;
}

// 敏感级别 + 影响范围的指纹。任一变化，旧签字即作废。
export function contextKeyOf(severity: string, affected: string[]): string {
  return `${severity}::${[...affected].slice().sort().join(',')}`;
}

// 确认条件：三个不同角色都已签（当前上下文），且每个受影响网段都有带执行时刻的结果。
export function isConfirmed(entry: LedgerEntry, affected: string[], contextKey: string): boolean {
  const activeRoles = new Set(
    entry.signatures.filter((s) => s.status === 'active' && s.contextKey === contextKey).map((s) => s.role)
  );
  const allSigned = LEDGER_ROLES.every((r) => activeRoles.has(r));
  const allSegmented = affected.every((seg) => entry.results.some((r) => r.segment === seg && !!r.at));
  return allSigned && allSegmented;
}

export function missingRoles(entry: LedgerEntry, contextKey: string): LedgerRole[] {
  const activeRoles = new Set(
    entry.signatures.filter((s) => s.status === 'active' && s.contextKey === contextKey).map((s) => s.role)
  );
  return LEDGER_ROLES.filter((r) => !activeRoles.has(r));
}

export function missingSegments(entry: LedgerEntry, affected: string[]): string[] {
  return affected.filter((seg) => !entry.results.some((r) => r.segment === seg && !!r.at));
}

// 同一角色重复签字：比较签字时刻，只留较早的一条；另一条记为冲突。
export function addSignature(
  entry: LedgerEntry,
  sig: Signature
): { entry: LedgerEntry; conflict?: ConflictRecord } {
  const existing = entry.signatures.find((s) => s.role === sig.role && s.status === 'active');
  if (!existing) {
    return { entry: { ...entry, signatures: [...entry.signatures, sig] } };
  }
  const conflict: ConflictRecord = {
    id: `cf-${sig.id}`,
    role: sig.role,
    at: new Date().toISOString(),
    keptId: '',
    droppedId: '',
    reason: 'same-role-duplicate',
  };
  let signatures: Signature[];
  if (new Date(sig.at).getTime() < new Date(existing.at).getTime()) {
    // 新到的签字更早：保留新的，旧的降为冲突
    signatures = entry.signatures.map((s) => (s.id === existing.id ? { ...s, status: 'conflict' as const } : s));
    signatures.push(sig);
    conflict.keptId = sig.id;
    conflict.droppedId = existing.id;
  } else {
    // 已有的签字更早：保留旧的，新到的降为冲突
    signatures = [...entry.signatures, { ...sig, status: 'conflict' as const }];
    conflict.keptId = existing.id;
    conflict.droppedId = sig.id;
  }
  return { entry: { ...entry, signatures, conflicts: [...entry.conflicts, conflict] }, conflict };
}

export function addResult(entry: LedgerEntry, result: ExecutionResult): LedgerEntry {
  return { ...entry, results: [...entry.results, result] };
}

// 上下文变更：在途签字（active）一律作废，账目退回待确认。
export function voidSignatures(entry: LedgerEntry): LedgerEntry {
  return {
    ...entry,
    signatures: entry.signatures.map((s) => (s.status === 'active' ? { ...s, status: 'void' as const } : s)),
    status: 'pending',
  };
}

// 断网重连：按编号合并，重复提交只算一次。
export function mergeById<T extends { id: string }>(local: T[], incoming: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of local) if (!map.has(item.id)) map.set(item.id, item);
  for (const item of incoming) if (!map.has(item.id)) map.set(item.id, item);
  return Array.from(map.values());
}

// 合并多份签字：按编号去重后，对同一角色的重复签字做冲突消解，只留最早一条 active。
export function mergeSignatures(
  existing: Signature[],
  incoming: Signature[]
): { signatures: Signature[]; conflicts: ConflictRecord[] } {
  const merged = mergeById(existing, incoming);
  const conflicts: ConflictRecord[] = [];
  const byRole = new Map<string, Signature[]>();
  for (const s of merged) {
    if (s.status !== 'active') continue;
    const arr = byRole.get(s.role) ?? [];
    arr.push(s);
    byRole.set(s.role, arr);
  }
  const dropped = new Set<string>();
  for (const [role, arr] of byRole) {
    if (arr.length <= 1) continue;
    arr.sort((a, b) => +new Date(a.at) - +new Date(b.at));
    const keeper = arr[0];
    for (const s of arr.slice(1)) {
      dropped.add(s.id);
      conflicts.push({
        id: `cf-merge-${s.id}`,
        role,
        at: new Date().toISOString(),
        keptId: keeper.id,
        droppedId: s.id,
        reason: 'same-role-duplicate',
      });
    }
  }
  const signatures = merged.map((s) => (dropped.has(s.id) ? { ...s, status: 'conflict' as const } : s));
  return { signatures, conflicts };
}

// 写入失败后只重试没写完的条目。
export function pendingWrites(entries: LedgerEntry[]): LedgerEntry[] {
  return entries.filter((e) => e.writeState !== 'written');
}

export function makeSignatureId(): string {
  return `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
export function makeResultId(): string {
  return `res-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
export function makeEntryId(): string {
  return `led-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
