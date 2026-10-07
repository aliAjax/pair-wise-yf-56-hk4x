import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  addResult,
  addSignature,
  contextKeyOf,
  isConfirmed,
  makeEntryId,
  makeResultId,
  makeSignatureId,
  mergeById,
  mergeSignatures,
  pendingWrites,
  voidSignatures,
  type ExecutionResult,
  type LedgerEntry,
  type LedgerRole,
  type OutboxItem,
  type Signature,
} from './ledger';

export type Severity = 'medium' | 'high' | 'critical';
export interface TimelineEvent { id: string; at: string; actor: string; text: string; sensitive?: boolean; }
export interface SubIncident { id: string; title: string; owner: string; status: 'open' | 'contained' | 'closed'; }
export interface ResponseAction { id: string; title: string; kind: 'isolate' | 'block' | 'restore' | 'notify'; approvals: string[]; status: 'pending' | 'approved' | 'executed'; sensitive?: boolean; }
export interface Incident {
  id: string; title: string; severity: Severity; status: 'investigating' | 'contained' | 'recovered'; affected: string[];
  subIncidents: SubIncident[]; actions: ResponseAction[]; timeline: TimelineEvent[];
}

interface LedgerState {
  entries: LedgerEntry[];
  outbox: OutboxItem[];
  online: boolean;
  terminalId: string;
  forceWriteFail: boolean;
}

interface State {
  incident: Incident;
  role: 'analyst' | 'responder' | 'legal' | 'viewer';
  demoMode: boolean;
  ledger: LedgerState;
  setRole: (role: State['role']) => void;
  toggleDemo: () => void;
  addSubIncident: (payload: { title: string; owner: string }) => void;
  approveAction: (id: string) => void;
  executeAction: (id: string) => void;
  reorderActions: (activeId: string, overId: string) => void;
  tick: () => void;
  // 核验台账
  ledgerSign: (actionId: string) => void;
  ledgerRegisterResult: (actionId: string, segment: string, result: 'success' | 'failed') => void;
  ledgerSetOnline: (online: boolean) => void;
  ledgerReconnectMerge: () => void;
  ledgerRetryWrites: () => void;
  ledgerSetSeverity: (sev: Severity) => void;
  ledgerSetAffected: (segments: string[]) => void;
  ledgerToggleForceFail: () => void;
}

const initial: Incident = {
  id: 'INC-2026-0929', title: '对外网关异常凭证使用', severity: 'critical', status: 'investigating', affected: ['api-gateway', 'customer-portal', 'audit-log'],
  subIncidents: [
    { id: 'sub-1', title: '异常会话来源分析', owner: '分析组', status: 'open' },
    { id: 'sub-2', title: '受影响租户范围确认', owner: '平台组', status: 'open' }
  ],
  actions: [
    { id: 'act-1', title: '隔离异常网关节点', kind: 'isolate', approvals: ['analyst'], status: 'pending', sensitive: true },
    { id: 'act-2', title: '封禁可疑出口地址', kind: 'block', approvals: [], status: 'pending' },
    { id: 'act-3', title: '准备客户披露口径', kind: 'notify', approvals: ['legal'], status: 'pending', sensitive: true }
  ],
  timeline: [
    { id: 'e1', at: new Date(Date.now() - 1500000).toISOString(), actor: '告警平台', text: '检测到同一凭证跨三个地域登录', sensitive: true },
    { id: 'e2', at: new Date(Date.now() - 900000).toISOString(), actor: '值班分析员', text: '确认会话未经过常规办公出口' }
  ]
};

function buildInitialEntries(): LedgerEntry[] {
  return initial.actions.map((a) => ({
    id: makeEntryId(),
    actionId: a.id,
    title: a.title,
    signatures: [],
    results: [],
    conflicts: [],
    status: 'pending',
    writeState: 'idle',
  }));
}

const initialLedger: LedgerState = {
  entries: buildInitialEntries(),
  outbox: [],
  online: true,
  terminalId: 'term-A',
  forceWriteFail: false,
};

function log(set: (partial: Partial<State>) => void, state: State, text: string, actor = '核验台账') {
  set({ incident: { ...state.incident, timeline: [{ id: `e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), actor, text }, ...state.incident.timeline].slice(0, 30) } });
}

// 写入落盘：forceWriteFail 时模拟失败，否则成功。
function writeEntry(entry: LedgerEntry, forceFail: boolean): LedgerEntry {
  if (forceFail) return { ...entry, writeState: 'failed', lastError: '写入失败：模拟落盘错误' };
  return { ...entry, writeState: 'written', lastError: undefined };
}

// 按当前上下文重判账目状态。
function recompute(entry: LedgerEntry, affected: string[], ctx: string): LedgerEntry {
  const confirmed = isConfirmed(entry, affected, ctx);
  if (confirmed && entry.status !== 'confirmed') return { ...entry, status: 'confirmed', confirmedAt: new Date().toISOString() };
  if (!confirmed && entry.status === 'confirmed') return { ...entry, status: 'pending' };
  return entry;
}

export const useIncidentStore = create<State>()(persist((set, get) => ({
  incident: initial, role: 'analyst', demoMode: false, ledger: initialLedger,
  setRole: (role) => set({ role }),
  toggleDemo: () => set((state) => ({ demoMode: !state.demoMode })),
  addSubIncident: (payload) => { if (get().demoMode) return; set((state) => ({ incident: { ...state.incident, subIncidents: [...state.incident.subIncidents, { id: `sub-${Date.now()}`, ...payload, status: 'open' }], timeline: [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: '响应负责人', text: `创建子事件：${payload.title}` }, ...state.incident.timeline] } })); },
  approveAction: (id) => { if (get().demoMode) return; const state = get(); const action = state.incident.actions.find((item) => item.id === id); if (!action || action.approvals.includes(state.role) || state.role === 'viewer') return; set({ incident: { ...state.incident, actions: state.incident.actions.map((item) => item.id === id ? { ...item, approvals: [...item.approvals, state.role], status: item.approvals.length >= 1 && action.kind === 'isolate' ? 'approved' : item.status } : item), timeline: [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: state.role, text: `审批处置动作：${action.title}` }, ...state.incident.timeline] } }); },
  executeAction: (id) => { const state = get(); const action = state.incident.actions.find((item) => item.id === id); if (!action || state.demoMode || state.role === 'viewer' || (action.kind === 'isolate' && action.approvals.length < 2)) return; set({ incident: { ...state.incident, actions: state.incident.actions.map((item) => item.id === id ? { ...item, status: 'executed' } : item), timeline: [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: state.role, text: `执行处置动作：${action.title}`, sensitive: action.sensitive }, ...state.incident.timeline] } }); },
  reorderActions: (activeId, overId) => { const state = get(); const actions = [...state.incident.actions]; const from = actions.findIndex((item) => item.id === activeId); const to = actions.findIndex((item) => item.id === overId); if (from < 0 || to < 0 || state.demoMode) return; const [moved] = actions.splice(from, 1); actions.splice(to, 0, moved); set({ incident: { ...state.incident, actions } }); },
  tick: () => set((state) => ({ incident: { ...state.incident, timeline: [{ id: `e-${Date.now()}`, at: new Date().toISOString(), actor: '监测代理', text: `实时检查：${state.incident.affected.length} 项资产状态已更新` }, ...state.incident.timeline].slice(0, 30) } })),

  ledgerSign: (actionId) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const role = state.role as LedgerRole;
    const ctx = contextKeyOf(state.incident.severity, state.incident.affected);
    const sig: Signature = {
      id: makeSignatureId(), role, at: new Date().toISOString(),
      terminalId: state.ledger.terminalId, contextKey: ctx, status: 'active',
    };
    if (!state.ledger.online) {
      const item: OutboxItem = { id: sig.id, kind: 'signature', actionId, at: sig.at, payload: sig };
      set({ ledger: { ...state.ledger, outbox: [...state.ledger.outbox, item] } });
      log(set, state, `断网签字已入待发箱：${role} @ ${sig.at}`);
      return;
    }
    let conflictNote = '';
    const entries = state.ledger.entries.map((e) => {
      if (e.actionId !== actionId) return e;
      const { entry, conflict } = addSignature(e, sig);
      if (conflict) conflictNote = `；同角色重复签字，已保留 ${conflict.keptId}，丢弃 ${conflict.droppedId}`;
      const written = writeEntry(entry, state.ledger.forceWriteFail);
      return recompute(written, state.incident.affected, ctx);
    });
    set({ ledger: { ...state.ledger, entries } });
    log(set, state, `签字：${role}${conflictNote}`);
  },

  ledgerRegisterResult: (actionId, segment, result) => {
    const state = get();
    if (state.demoMode || state.role === 'viewer') return;
    const ctx = contextKeyOf(state.incident.severity, state.incident.affected);
    const res: ExecutionResult = {
      id: makeResultId(), segment, at: new Date().toISOString(), result,
      terminalId: state.ledger.terminalId, contextKey: ctx,
    };
    if (!state.ledger.online) {
      const item: OutboxItem = { id: res.id, kind: 'result', actionId, at: res.at, payload: res };
      set({ ledger: { ...state.ledger, outbox: [...state.ledger.outbox, item] } });
      log(set, state, `断网登记执行结果已入待发箱：${segment} -> ${result}`);
      return;
    }
    const entries = state.ledger.entries.map((e) => {
      if (e.actionId !== actionId) return e;
      const added = addResult(e, res);
      const written = writeEntry(added, state.ledger.forceWriteFail);
      return recompute(written, state.incident.affected, ctx);
    });
    set({ ledger: { ...state.ledger, entries } });
    log(set, state, `登记执行结果：${segment} -> ${result}（执行时刻 ${res.at}）`);
  },

  ledgerSetOnline: (online) => {
    const state = get();
    set({ ledger: { ...state.ledger, online } });
    log(set, state, online ? '终端已联网' : '终端已断网，签字与登记结果进入待发箱');
  },

  ledgerReconnectMerge: () => {
    const state = get();
    if (state.ledger.outbox.length === 0) return;
    const ctx = contextKeyOf(state.incident.severity, state.incident.affected);
    // 按编号合并：同一编号只保留一条，重复提交只算一次。
    const mergedSigIds = new Set<string>();
    const mergedResIds = new Set<string>();
    for (const item of state.ledger.outbox) {
      if (item.kind === 'signature') mergedSigIds.add(item.id);
      else mergedResIds.add(item.id);
    }
    const entries = state.ledger.entries.map((e) => {
      let next = e;
      const sigs = state.ledger.outbox.filter((i) => i.actionId === e.actionId && i.kind === 'signature').map((i) => i.payload as Signature);
      const ress = state.ledger.outbox.filter((i) => i.actionId === e.actionId && i.kind === 'result').map((i) => i.payload as ExecutionResult);
      if (sigs.length) {
        const { signatures, conflicts } = mergeSignatures(next.signatures, sigs);
        next = { ...next, signatures, conflicts: [...next.conflicts, ...conflicts] };
      }
      if (ress.length) next = { ...next, results: mergeById(next.results, ress) };
      if (next !== e) {
        const written = writeEntry(next, state.ledger.forceWriteFail);
        next = recompute(written, state.incident.affected, ctx);
      }
      return next;
    });
    set({ ledger: { ...state.ledger, entries, outbox: [], online: true } });
    log(set, state, `重连合并完成：签字 ${mergedSigIds.size} 条、执行结果 ${mergedResIds.size} 条（按编号去重）`);
  },

  ledgerRetryWrites: () => {
    const state = get();
    const ctx = contextKeyOf(state.incident.severity, state.incident.affected);
    const pending = pendingWrites(state.ledger.entries);
    if (pending.length === 0) return;
    const entries = state.ledger.entries.map((e) => {
      if (e.writeState === 'written') return e; // 已写的不重试
      const written = writeEntry(e, state.ledger.forceWriteFail);
      return recompute(written, state.incident.affected, ctx);
    });
    set({ ledger: { ...state.ledger, entries } });
    const failed = entries.filter((e) => e.writeState === 'failed').length;
    log(set, state, `重试写入 ${pending.length} 条未写完条目，其中 ${failed} 条仍失败`);
  },

  ledgerSetSeverity: (sev) => {
    const state = get();
    if (state.demoMode) return;
    const ctx = contextKeyOf(sev, state.incident.affected);
    const entries = state.ledger.entries.map((e) => {
      const voided = voidSignatures(e);
      return recompute(voided, state.incident.affected, ctx);
    });
    set({ incident: { ...state.incident, severity: sev }, ledger: { ...state.ledger, entries } });
    log(set, state, `敏感级别变更为 ${sev}，在途签字全部作废，账目退回待确认`);
  },

  ledgerSetAffected: (segments) => {
    const state = get();
    if (state.demoMode) return;
    const ctx = contextKeyOf(state.incident.severity, segments);
    const entries = state.ledger.entries.map((e) => {
      const voided = voidSignatures(e);
      return recompute(voided, segments, ctx);
    });
    set({ incident: { ...state.incident, affected: segments }, ledger: { ...state.ledger, entries } });
    log(set, state, `影响范围变更为 [${segments.join('、')}]，在途签字全部作废，账目退回待确认`);
  },

  ledgerToggleForceFail: () => set((state) => ({ ledger: { ...state.ledger, forceWriteFail: !state.ledger.forceWriteFail } })),
}), { name: 'yf56-incident-store' }));
