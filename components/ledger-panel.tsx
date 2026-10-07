'use client';
import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { CheckCircle2, CloudOff, Cloudy, AlertTriangle, RefreshCw, PenLine, ClipboardCheck, RotateCcw, Wifi, WifiOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useIncidentStore, type Severity } from '@/lib/store';
import { LEDGER_ROLES, missingRoles, missingSegments, type LedgerEntry } from '@/lib/ledger';

const roleNames: Record<string, string> = { analyst: '分析员', responder: '响应负责人', legal: '法务/公关' };
const severityNames: Record<Severity, string> = { medium: '中危', high: '高危', critical: '紧急' };

function fmt(iso?: string): string {
  if (!iso) return '未签';
  return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: zhCN });
}

function EntryRow({ entry }: { entry: LedgerEntry }) {
  const store = useIncidentStore();
  const ctx = `${store.incident.severity}::${[...store.incident.affected].sort().join(',')}`;
  const missingR = missingRoles(entry, ctx);
  const missingS = missingSegments(entry, store.incident.affected);
  const canSign = !store.demoMode && store.role !== 'viewer';

  return (
    <div className="ledger-entry">
      <div className="ledger-entry-head">
        <div>
          <strong>{entry.title}</strong>
          <div className="muted">台账编号 {entry.id}</div>
        </div>
        <div className="ledger-badges">
          {entry.status === 'confirmed'
            ? <Badge className="ok"><CheckCircle2 size={12} /> 已确认</Badge>
            : <Badge className="pending">待办</Badge>}
          <Badge className={entry.writeState === 'written' ? 'ok' : entry.writeState === 'failed' ? 'failed' : 'idle'}>
            {entry.writeState === 'written' ? '已写入' : entry.writeState === 'failed' ? '写入失败' : entry.writeState === 'writing' ? '写入中' : '待写入'}
          </Badge>
        </div>
      </div>

      <div className="ledger-sigs">
        {LEDGER_ROLES.map((r) => {
          const sig = entry.signatures.filter((s) => s.role === r).sort((a, b) => +new Date(a.at) - +new Date(b.at))[0];
          const active = sig?.status === 'active' && sig.contextKey === ctx;
          const isVoid = sig?.status === 'void' || (sig && sig.contextKey !== ctx);
          return (
            <div key={r} className={`sig-chip ${active ? 'sig-active' : isVoid ? 'sig-void' : 'sig-none'}`}>
              <PenLine size={13} />
              <span>{roleNames[r]}</span>
              <small>{active ? fmt(sig!.at) : isVoid ? '已作废' : '未签'}</small>
            </div>
          );
        })}
      </div>

      <div className="ledger-results">
        {store.incident.affected.map((seg) => {
          const res = entry.results.filter((r) => r.segment === seg && r.at).sort((a, b) => +new Date(b.at) - +new Date(a.at))[0];
          return (
            <div key={seg} className={`seg-chip ${res ? (res.result === 'success' ? 'seg-ok' : 'seg-fail') : 'seg-none'}`}>
              <ClipboardCheck size={13} />
              <span>{seg}</span>
              <small>{res ? `${res.result === 'success' ? '成功' : '失败'} · ${fmt(res.at)}` : '缺执行结果'}</small>
            </div>
          );
        })}
      </div>

      {entry.conflicts.length > 0 && (
        <div className="ledger-conflicts">
          {entry.conflicts.map((c) => (
            <div key={c.id} className="conflict-row"><AlertTriangle size={13} /> 冲突记录：{roleNames[c.role] ?? c.role} 重复签字，保留 {c.keptId}，丢弃 {c.droppedId}（{fmt(c.at)}）</div>
          ))}
        </div>
      )}

      {entry.status !== 'confirmed' && (missingR.length > 0 || missingS.length > 0) && (
        <div className="ledger-missing muted">
          缺：{missingR.map((r) => roleNames[r]).join('、') || '签字齐全'}{missingR.length > 0 && missingS.length > 0 ? ' · ' : ''}{missingS.length > 0 ? `执行结果（${missingS.join('、')}）` : ''}
        </div>
      )}

      <div className="ledger-actions">
        <Button size="sm" variant="outline" disabled={!canSign} onClick={() => store.ledgerSign(entry.actionId)}>
          <PenLine size={14} /> 签字（{roleNames[store.role] ?? store.role}）
        </Button>
        {store.incident.affected.map((seg) => (
          <span key={seg} className="seg-actions">
            <Button size="sm" variant="ghost" disabled={!canSign} onClick={() => store.ledgerRegisterResult(entry.actionId, seg, 'success')}>{seg} · 成功</Button>
            <Button size="sm" variant="ghost" disabled={!canSign} onClick={() => store.ledgerRegisterResult(entry.actionId, seg, 'failed')}>{seg} · 失败</Button>
          </span>
        ))}
      </div>
      {entry.lastError && <div className="ledger-error">{entry.lastError}</div>}
    </div>
  );
}

export function LedgerPanel() {
  const store = useIncidentStore();
  const [segInput, setSegInput] = useState('');
  const pendingWritesCount = store.ledger.entries.filter((e) => e.writeState !== 'written').length;

  function addSegment() {
    const v = segInput.trim();
    if (!v) return;
    if (store.incident.affected.includes(v)) { setSegInput(''); return; }
    store.ledgerSetAffected([...store.incident.affected, v]);
    setSegInput('');
  }
  function removeSegment(seg: string) {
    store.ledgerSetAffected(store.incident.affected.filter((s) => s !== seg));
  }

  return (
    <Card className="ledger-card">
      <CardHeader>
        <div>
          <h2>核验台账</h2>
          <p className="muted">三个角色都已签、每个受影响网段都有执行结果且执行时刻写清，账目才予确认；少一项退回待办。</p>
        </div>
        {store.ledger.online ? <Wifi color="#16a34a" /> : <WifiOff color="#ef4444" />}
      </CardHeader>
      <CardContent>
        <div className="ledger-toolbar">
          <Button size="sm" variant={store.ledger.online ? 'outline' : 'danger'} onClick={() => store.ledgerSetOnline(!store.ledger.online)}>
            {store.ledger.online ? <Cloudy size={14} /> : <CloudOff size={14} />}
            {store.ledger.online ? '联网中' : '已断网'}
          </Button>
          <Button size="sm" variant="outline" disabled={store.ledger.outbox.length === 0} onClick={store.ledgerReconnectMerge}>
            <RefreshCw size={14} /> 重连合并（{store.ledger.outbox.length}）
          </Button>
          <Button size="sm" variant="outline" disabled={pendingWritesCount === 0} onClick={store.ledgerRetryWrites}>
            <RotateCcw size={14} /> 重试写入（{pendingWritesCount}）
          </Button>
          <Button size="sm" variant={store.ledger.forceWriteFail ? 'danger' : 'ghost'} onClick={store.ledgerToggleForceFail}>
            {store.ledger.forceWriteFail ? '强制写入失败：开' : '强制写入失败：关'}
          </Button>
          <span className="muted terminal-id">终端 {store.ledger.terminalId}</span>
        </div>

        <div className="ledger-context">
          <label>敏感级别
            <select value={store.incident.severity} onChange={(e) => store.ledgerSetSeverity(e.target.value as Severity)} disabled={store.demoMode}>
              <option value="medium">中危</option>
              <option value="high">高危</option>
              <option value="critical">紧急</option>
            </select>
          </label>
          <label>受影响网段
            <span className="seg-edit">
              {store.incident.affected.map((seg) => (
                <span key={seg} className="seg-chip seg-ok">{seg}<button onClick={() => removeSegment(seg)} disabled={store.demoMode}>×</button></span>
              ))}
              <Input value={segInput} onChange={(e) => setSegInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSegment(); } }} placeholder="新增网段" disabled={store.demoMode} />
              <Button size="sm" variant="outline" onClick={addSegment} disabled={store.demoMode}>添加</Button>
            </span>
          </label>
        </div>

        <div className="ledger-entries">
          {store.ledger.entries.map((entry) => <EntryRow key={entry.id} entry={entry} />)}
        </div>
      </CardContent>
    </Card>
  );
}
