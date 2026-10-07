'use client';
// 台账在客户端的单例接线：引擎状态订阅 + 快照持久化（断网 outbox、未写完的行刷新后继续重试）。
// SSR 与首次客户端渲染统一使用占位快照，挂载后再读取 localStorage 中的真实台账，避免 hydration 不一致。

import { useSyncExternalStore, useEffect, useState } from 'react';
import { createDefaultEngine, LedgerEngine, LocalStorageSink, type EngineSnapshot } from './engine';

const SNAPSHOT_KEY = 'yf56-ledger-engine-v1';
const PLACEHOLDER: EngineSnapshot = createDefaultEngine(new Date(0).toISOString()).snapshot();

let engine: LedgerEngine | null = null;
let cachedSnapshot: EngineSnapshot | null = null;

function getEngine(): LedgerEngine {
  if (engine) return engine;
  const sink = new LocalStorageSink();
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (raw) {
      const snapshot = JSON.parse(raw) as EngineSnapshot;
      engine = LedgerEngine.restore(snapshot, sink);
      // 恢复后若仍有没写完的条目，自动继续重试
      void engine.flush();
    }
  } catch {
    engine = null;
  }
  if (!engine) engine = createDefaultEngine();
  engine.subscribe(() => {
    cachedSnapshot = null;
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(engine!.snapshot()));
    } catch {
      // 存储不可用时台账仍在内存中运行
    }
  });
  cachedSnapshot = engine.snapshot();
  return engine;
}

export function useLedger(): { engine: LedgerEngine; snapshot: EngineSnapshot } {
  const instance = getEngine();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const snapshot = useSyncExternalStore(
    (onChange) => instance.subscribe(() => onChange()),
    () => {
      if (!mounted) return PLACEHOLDER;
      if (!cachedSnapshot || !engine) cachedSnapshot = instance.snapshot();
      return cachedSnapshot;
    },
    () => PLACEHOLDER,
  );
  return { engine: instance, snapshot: mounted ? snapshot : PLACEHOLDER };
}
