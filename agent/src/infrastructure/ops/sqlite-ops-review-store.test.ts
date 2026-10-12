import { beforeEach, describe, expect, it } from 'vitest';
import type { OpsSnapshot } from '../../domain/ops.ts';
import type {
  OpsReviewRecord,
  OpsReviewStore,
} from '../../domain/ports/ops-review-store.ts';
import { openAppDatabase } from '../db/app-database.ts';
import { createSqliteOpsReviewStore } from './sqlite-ops-review-store.ts';

const SNAPSHOT: OpsSnapshot = {
  errorCounts: { app: 3 },
  clientIps: { '192.0.2.1': 10 },
  statusCounts: { '2xx': 10 },
};

function record(day: number, overrides: Partial<OpsReviewRecord> = {}) {
  return {
    id: `r${day}`,
    reviewedAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    status: 'completed',
    severity: 'ok',
    findings: [],
    snapshot: SNAPSHOT,
    notes: [],
    ...overrides,
  } satisfies OpsReviewRecord;
}

describe('createSqliteOpsReviewStore', () => {
  let store: OpsReviewStore;

  beforeEach(() => {
    store = createSqliteOpsReviewStore(openAppDatabase(':memory:'));
  });

  it('保存した内容をそのまま読み戻す', () => {
    const saved = record(1, {
      severity: 'warning',
      findings: [
        {
          id: 'x',
          severity: 'warning',
          title: 't',
          detail: 'd',
          evidence: ['2× e'],
        },
      ],
      narration: '本文',
      notes: ['学習中'],
    });
    store.save(saved);
    expect(store.latest()).toEqual(saved);
  });

  it('latest は一番新しい見回りを返す。無ければ undefined', () => {
    expect(store.latest()).toBeUndefined();
    store.save(record(2));
    store.save(record(5));
    store.save(record(3));
    expect(store.latest()?.id).toBe('r5');
  });

  it('平常の基準は完了した見回りの集計だけを新しい順に返す', () => {
    store.save(record(1, { snapshot: { ...SNAPSHOT, errorCounts: { a: 1 } } }));
    store.save(
      record(2, {
        status: 'failed',
        snapshot: undefined,
        error: 'boom',
        severity: 'critical',
      }),
    );
    store.save(record(3, { snapshot: undefined }));
    store.save(record(4, { snapshot: { ...SNAPSHOT, errorCounts: { a: 4 } } }));

    expect(store.recentSnapshots(10).map((s) => s.errorCounts)).toEqual([
      { a: 4 },
      { a: 1 },
    ]);
    expect(store.recentSnapshots(1)).toHaveLength(1);
  });

  it('失敗した見回りも記録として読める', () => {
    store.save(
      record(1, {
        status: 'failed',
        snapshot: undefined,
        error: 'db is locked',
        severity: 'critical',
      }),
    );
    expect(store.latest()).toMatchObject({
      status: 'failed',
      error: 'db is locked',
    });
  });
});
