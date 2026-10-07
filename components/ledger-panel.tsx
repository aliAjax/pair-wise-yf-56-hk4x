'use client';
import { format } from 'date-fns';
import { AlertTriangle, CheckCircle2, CloudOff, HardDriveDownload, Radio, RotateCcw, ScrollText, Wifi, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { ROLE_NAMES, SEVERITY_NAMES, OUTCOME_NAMES, SIGN_ROLES, type Entry, type Severity } from '@/lib/ledger/core';
import { useLedger } from '@/lib/ledger/store';
import { useIncidentStore } from '@/lib/store';

const fmt = (iso: string) => format(new Date(iso), 'MM-dd HH:mm:ss.SSS');
const fmtShort = (iso: string) => format(new Date(iso), 'HH:mm:ss');

const KIND_LABEL: Record<Entry['kind'], string> = { signature: '签字', execution: '执行结果', audit: '审计' };

function TerminalPicker({ clientId, onChange }: { clientId: string; onChange: (id: string) => void }) {
  return (
    <select className="ledger-select" value={clientId} onChange={(e) => onChange(e.target.value)}>
      <option value="terminal-A">终端 A</option>
      <option value="terminal-B">终端 B</option>
      <option value="cmd-post">指挥席</option>
    </select>
  );
}

export function LedgerPanel() {
  const { engine, snapshot } = useLedger();
  const role = useIncidentStore((s) => s.role);
  const demoMode = useIncidentStore((s) => s.demoMode);
  const [clientId, setClientId] = useState('terminal-A');
  const [severity, setSeverity] = useState<Severity>(snapshot.hub.scope.severity);
  const [segmentsText, setSegmentsText] = useState(snapshot.hub.scope.affected.join(', '));
  const [showBook, setShowBook] = useState(false);

  const hub = snapshot.hub;
  const ev = engine.evaluation;
  const frozen = demoMode || role === 'viewer';

  function applyScope() {
    const affected = segmentsText.split(/[，,\s]+/).map((s) => s.trim()).filter(Boolean);
    engine.changeScope({ clientId, scope: { severity, affected } });
  }

  function confirmLedger() {
    if (ev.status !== 'confirmed') return;
    engine.recordDecision('confirmed', clientId, `三角色签字、${hub.scope.affected.length} 个受影响网段执行结果（含执行时刻）、审计记录核验一致，账目确认。`);
  }
  function returnLedger() {
    engine.recordDecision('returned', clientId, `核验缺项：${ev.missing.join('；') || '—'}，退回待办。`);
  }

  const lastDecision = [...hub.entries].reverse().find((e) => e.decision);

  return (
    <Card className="ledger-card">
      <CardHeader>
        <div>
          <h2><ScrollText size={18} /> 隔离核验台账</h2>
          <p className="muted">
            账目 {hub.taskId} · 编号流水 {hub.entries.length} 条 · 作用域第 <strong>{hub.scopeSig}</strong> 版 ·{' '}
            {SEVERITY_NAMES[hub.scope.severity]} · 网段 {hub.scope.affected.join('、')}
          </p>
        </div>
        <div className="ledger-head-actions">
          <span className={`ledger-dot ${snapshot.online ? 'on' : 'off'}`}>
            {snapshot.online ? <Wifi size={13} /> : <WifiOff size={13} />}
            {snapshot.online ? '在线' : `断网 · 待发 ${snapshot.outbox.length}`}
          </span>
          <Button size="sm" variant="outline" disabled={frozen} onClick={() => engine.setOnline(!snapshot.online)}>
            {snapshot.online ? <CloudOff size={14} /> : <Radio size={14} />}
            {snapshot.online ? '模拟断网' : '重连合并'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowBook((v) => !v)}>{showBook ? '收起全册' : '展开全册'}</Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="ledger-grid">
          {/* 左：三角色签字 */}
          <div className="ledger-col">
            <h3>三角色签字</h3>
            <p className="muted">以 <TerminalPicker clientId={clientId} onChange={setClientId} /> 的当前角色「{role === 'viewer' ? '访客（不可签）' : ROLE_NAMES[role as keyof typeof ROLE_NAMES] ?? role}」签字；同角色重复签字按签字时刻只留最早一条。</p>
            <div className="ledger-roles">
              {SIGN_ROLES.map((r) => {
                const check = ev.roleChecks[r];
                const winner = check.winner;
                return (
                  <div key={r} className={`ledger-role ${check.ok ? 'ok' : 'missing'}`}>
                    <div>
                      <strong>{ROLE_NAMES[r]}</strong>
                      <div className="muted">
                        {winner
                          ? `#${winner.seq} · ${winner.clientId} · 签于 ${fmt(winner.signedAt!)}`
                          : '待签（当前版本）'}
                      </div>
                    </div>
                    <Button size="sm" variant="outline" disabled={frozen || role !== r || check.ok} onClick={() => engine.sign({ clientId, role: r })}>
                      签字
                    </Button>
                  </div>
                );
              })}
            </div>

            <h3>受影响网段执行结果</h3>
            <div className="ledger-segments">
              {ev.segmentChecks.map((check) => (
                <div key={check.segment} className={`ledger-segment ${check.ok ? 'ok' : 'missing'}`}>
                  <div>
                    <strong>{check.segment}</strong>
                    <div className="muted">
                      {check.result
                        ? `#${check.result.seq} · ${OUTCOME_NAMES[check.result.outcome ?? 'failed']} · 执行时刻 ${fmt(check.result.executedAt!)} · ${check.result.clientId}`
                        : '无执行结果'}
                    </div>
                  </div>
                  <div className="row-actions">
                    <Button size="sm" disabled={frozen} onClick={() => engine.execute({ clientId, segment: check.segment, outcome: 'isolated', operator: role })}>登记已隔离</Button>
                    <Button size="sm" variant="ghost" disabled={frozen} onClick={() => engine.execute({ clientId, segment: check.segment, outcome: 'failed', operator: role })}>登记失败</Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 右：核验、作用域、队列 */}
          <div className="ledger-col">
            <div className={`ledger-verdict ${ev.status === 'confirmed' ? 'ok' : 'pending'}`}>
              {ev.status === 'confirmed' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
              <div>
                <strong>{ev.status === 'confirmed' ? '材料齐全，可确认账目' : '缺项，退回待办'}</strong>
                <div className="muted">
                  {ev.status === 'confirmed'
                    ? '三角色当前版本签字、逐网段执行结果与执行时刻、审计记录均在位。'
                    : ev.missing.join('；')}
                </div>
                {lastDecision && (
                  <div className="muted">最近结论：{lastDecision.decision === 'confirmed' ? '已确认' : '退回待办'}（#{lastDecision.seq} · {fmtShort(lastDecision.at)}）{lastDecision.text ? ` — ${lastDecision.text}` : ''}</div>
                )}
              </div>
            </div>
            <div className="ledger-decision-actions">
              <Button size="sm" disabled={frozen || ev.status !== 'confirmed'} onClick={confirmLedger}>确认账目</Button>
              <Button size="sm" variant="outline" disabled={frozen} onClick={returnLedger}>退回待办</Button>
            </div>

            <h3>敏感级别 / 影响范围变更</h3>
            <div className="ledger-scope">
              <label>敏感级别
                <select className="ledger-select" value={severity} onChange={(e) => setSeverity(e.target.value as Severity)} disabled={frozen}>
                  <option value="medium">{SEVERITY_NAMES.medium}</option>
                  <option value="high">{SEVERITY_NAMES.high}</option>
                  <option value="critical">{SEVERITY_NAMES.critical}</option>
                </select>
              </label>
              <label>受影响网段（逗号分隔）
                <input className="input" value={segmentsText} onChange={(e) => setSegmentsText(e.target.value)} disabled={frozen} />
              </label>
              <Button size="sm" variant="outline" disabled={frozen} onClick={applyScope}>发布变更（在途签字随即作废）</Button>
            </div>

            <h3>断网与写入</h3>
            <div className="ledger-ops">
              <div className="muted">本地待发（重连后按编号合并、重复 opId 只算一次）：<strong>{snapshot.outbox.length}</strong> 条</div>
              <div className={`muted ${snapshot.queueStatus === 'degraded' ? 'ledger-warn' : ''}`}>
                <HardDriveDownload size={13} /> 未落盘条目：<strong>{snapshot.queue.length}</strong>
                {snapshot.queueStatus === 'degraded' ? '（部分写入失败，仅重试未写完的行）' : snapshot.queueStatus === 'writing' ? '（写入中）' : ''}
              </div>
              <div className="row-actions">
                <Button size="sm" variant="outline" disabled={snapshot.queue.length === 0} onClick={() => void engine.flush()}>
                  <RotateCcw size={13} /> 重试未落盘条目
                </Button>
                <Button size="sm" variant="ghost" disabled={frozen} onClick={() => engine.armFault(1)}>演练：注入1行写入失败</Button>
              </div>
              {snapshot.queue.length > 0 && (
                <ul className="ledger-queue">
                  {snapshot.queue.map((p) => (
                    <li key={p.row.seq}>#{p.row.seq} {KIND_LABEL[p.row.kind]} · 已重试 {p.attempts} 次 {p.lastError ? `· ${p.lastError}` : ''}</li>
                  ))}
                </ul>
              )}
              {snapshot.lastReconnect && (
                <div className="muted">上次重连（{fmtShort(snapshot.lastReconnect.at)}）：并入 {snapshot.lastReconnect.summary.applied} 条，去重 {snapshot.lastReconnect.summary.deduped} 条。</div>
              )}
            </div>
          </div>
        </div>

        {/* 冲突与作废 */}
        {(ev.conflicts.length > 0 || ev.voided.length > 0) && (
          <div className="ledger-exceptions">
            {ev.conflicts.length > 0 && (
              <div>
                <h4>冲突记录（同角色后到的重复签字，保留留痕）</h4>
                {ev.conflicts.map((e) => (
                  <span key={e.seq} className="ledger-tag conflict">#{e.seq} {ROLE_NAMES[e.role!]} · {e.clientId} · 签于 {fmtShort(e.signedAt!)} · 已被 #{e.supersededBy} 更早签字压掉</span>
                ))}
              </div>
            )}
            {ev.voided.length > 0 && (
              <div>
                <h4>已作废签字（作用域变更/离线迟到）</h4>
                {ev.voided.map((e) => (
                  <span key={e.seq} className="ledger-tag voided">#{e.seq} {ROLE_NAMES[e.role!]} · {e.clientId} · 依据第 {e.basisSig} 版 · 作废</span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 全册流水 */}
        {showBook && (
          <div className="ledger-book">
            <h4>编号流水（签字 / 执行结果 / 审计同册）</h4>
            <table>
              <thead><tr><th>#</th><th>类型</th><th>来源</th><th>依据版本</th><th>内容</th><th>签字时刻</th><th>执行时刻</th><th>登记时刻</th><th>状态</th></tr></thead>
              <tbody>
                {hub.entries.map((e) => (
                  <tr key={e.seq} className={e.voided ? 'row-voided' : e.supersededBy ? 'row-conflict' : ''}>
                    <td>{e.seq}</td>
                    <td>{KIND_LABEL[e.kind]}</td>
                    <td>{e.clientId}</td>
                    <td>v{e.basisSig}</td>
                    <td>
                      {e.kind === 'signature' && `${ROLE_NAMES[e.role!]}签字`}
                      {e.kind === 'execution' && `${e.segment} · ${OUTCOME_NAMES[e.outcome!]}`}
                      {e.kind === 'audit' && e.text}
                    </td>
                    <td>{e.signedAt ? fmt(e.signedAt) : '—'}</td>
                    <td>{e.executedAt ? fmt(e.executedAt) : '—'}</td>
                    <td>{fmt(e.at)}</td>
                    <td>{e.voided ? '已作废' : e.supersededBy ? `冲突→#${e.supersededBy}` : e.decision === 'confirmed' ? '已确认' : e.decision === 'returned' ? '已退回' : '在簿'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
