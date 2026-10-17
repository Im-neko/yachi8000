import { describe, expect, it } from 'vitest';
import {
  compareClientIps,
  compareErrorCounts,
  compareStatusMix,
  formatJstWindow,
  groupLogPatterns,
  isReviewDue,
  jstDay,
  maskSecrets,
  maxSeverity,
  normalizeLogLine,
  type OpsFinding,
  type OpsSnapshot,
  overallSeverity,
  renderFindingsText,
  settleReportedSurges,
  statusClassCounts,
} from './ops.ts';

function snapshot(partial: Partial<OpsSnapshot> = {}): OpsSnapshot {
  return {
    errorCounts: {},
    clientIps: {},
    statusCounts: {},
    ...partial,
  };
}

function days(count: number, make: (day: number) => Partial<OpsSnapshot>) {
  return Array.from({ length: count }, (_, i) => snapshot(make(i)));
}

describe('compareErrorCounts', () => {
  it('履歴が足りないうちは判定しない（学習中）', () => {
    const history = days(2, () => ({ errorCounts: { app: 10 } }));
    expect(compareErrorCounts({ app: 5000 }, history)).toEqual([]);
  });

  it('平常の 3 倍を超えて 100 件以上なら気付きに挙げる', () => {
    const history = days(5, () => ({ errorCounts: { app: 100 } }));
    const findings = compareErrorCounts({ app: 400 }, history);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: 'error-surge:app',
      severity: 'notice',
    });
    expect(findings[0]?.title).toContain('4.0 倍');
  });

  it('平常の 10 倍以上は要確認になる', () => {
    const history = days(5, () => ({ errorCounts: { app: 100 } }));
    expect(compareErrorCounts({ app: 1500 }, history)[0]?.severity).toBe(
      'warning',
    );
  });

  it('平常が 0 件の場所で出始めたら、件数が多いときだけ挙げる', () => {
    const history = days(5, () => ({ errorCounts: {} }));
    expect(compareErrorCounts({ fresh: 99 }, history)).toEqual([]);
    const findings = compareErrorCounts({ fresh: 150 }, history);
    expect(findings[0]?.title).toContain('平常は 0 件');
    expect(findings[0]?.severity).toBe('notice');
    expect(compareErrorCounts({ fresh: 1000 }, history)[0]?.severity).toBe(
      'warning',
    );
  });

  it('平常の範囲内（常にうるさい場所）は挙げない', () => {
    const history = days(5, () => ({ errorCounts: { noisy: 60000 } }));
    expect(compareErrorCounts({ noisy: 70000 }, history)).toEqual([]);
  });

  it('基準は中央値なので、過去の 1 日だけの突発では引きずられない', () => {
    const history = [
      snapshot({ errorCounts: { app: 100 } }),
      snapshot({ errorCounts: { app: 100 } }),
      snapshot({ errorCounts: { app: 100 } }),
      snapshot({ errorCounts: { app: 9000 } }),
      snapshot({ errorCounts: { app: 100 } }),
    ];
    expect(compareErrorCounts({ app: 400 }, history)).toHaveLength(1);
  });
});

describe('compareClientIps', () => {
  const known = (ip: string, count = 300) =>
    days(5, () => ({ clientIps: { [ip]: count } }));

  it('履歴が足りないうちは判定しない', () => {
    expect(
      compareClientIps(
        { '192.0.2.1': 9999 },
        days(2, () => ({})),
      ),
    ).toEqual([]);
  });

  it('過去の上位に現れていないアクセス元が多く来たら挙げる', () => {
    const findings = compareClientIps(
      { '192.0.2.1': 1000, '198.51.100.7': 500 },
      known('192.0.2.1', 1000),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: 'new-source:198.51.100.7',
      severity: 'notice',
    });
  });

  it('初めてでも件数が少なければ挙げない', () => {
    const findings = compareClientIps(
      { '192.0.2.1': 100000, '198.51.100.7': 50 },
      known('192.0.2.1', 100000),
    );
    expect(findings).toEqual([]);
  });

  it('既知のアクセス元が平常の 5 倍を超えて 500 件以上なら挙げる', () => {
    const findings = compareClientIps(
      { '192.0.2.1': 3000 },
      known('192.0.2.1', 300),
    );
    expect(findings[0]).toMatchObject({ id: 'source-surge:192.0.2.1' });
  });

  it('既知のアクセス元が平常どおりなら挙げない', () => {
    expect(
      compareClientIps({ '192.0.2.1': 320 }, known('192.0.2.1', 300)),
    ).toEqual([]);
  });
});

describe('compareStatusMix', () => {
  it('リクエストが少ない日は比率を見ない', () => {
    expect(compareStatusMix({ '2xx': 10, '5xx': 90 }, [])).toEqual([]);
  });

  it('履歴が無くても、5xx が 1 割を超えていれば要確認', () => {
    const findings = compareStatusMix({ '2xx': 700, '5xx': 300 }, []);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: 'status-5xx',
      severity: 'warning',
    });
  });

  it('履歴が無いとき、5xx が 5% 台なら挙げない（平常かどうか分からない）', () => {
    expect(compareStatusMix({ '2xx': 940, '5xx': 60 }, [])).toEqual([]);
  });

  it('平常から 3 ポイント以上上がって 5% を超えたら挙げる', () => {
    const history = days(5, () => ({
      statusCounts: { '2xx': 990, '5xx': 10 },
    }));
    const findings = compareStatusMix({ '2xx': 920, '5xx': 80 }, history);
    expect(findings[0]?.id).toBe('status-5xx');
  });

  it('4xx の比率が平常より 15 ポイント上がったら気付きに挙げる', () => {
    const history = days(5, () => ({
      statusCounts: { '2xx': 900, '4xx': 100 },
    }));
    const findings = compareStatusMix({ '2xx': 600, '4xx': 400 }, history);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: 'status-4xx', severity: 'notice' });
  });
});

describe('statusClassCounts', () => {
  it('状態コードを階級にまとめ、範囲外は捨てる', () => {
    expect(
      statusClassCounts({ '200': 10, '204': 5, '502': 3, '404': 2, '000': 9 }),
    ).toEqual({ '2xx': 15, '5xx': 3, '4xx': 2 });
  });
});

describe('severity', () => {
  const finding = (severity: OpsFinding['severity']): OpsFinding => ({
    id: severity,
    severity,
    title: severity,
    detail: '',
  });

  it('一番重いものを全体の重大度にする', () => {
    expect(
      overallSeverity([
        finding('notice'),
        finding('critical'),
        finding('warning'),
      ]),
    ).toBe('critical');
    expect(maxSeverity(['notice', 'warning'])).toBe('warning');
  });

  it('項目が無ければ ok', () => {
    expect(overallSeverity([])).toBe('ok');
  });

  it('項目が無い本文は「気になる点なし」になる', () => {
    expect(renderFindingsText([])).toContain(
      '気になる点は見つかりませんでした',
    );
  });
});

describe('isReviewDue', () => {
  // 2026-10-12 00:30 JST = 2026-10-11 15:30 UTC
  const morning = new Date('2026-10-11T15:30:00Z');
  // 2026-10-12 09:00 JST
  const nine = new Date('2026-10-12T00:00:00Z');

  it('設定の時刻（JST）より前は走らない', () => {
    expect(isReviewDue(morning, 8, undefined)).toBe(false);
  });

  it('時刻を過ぎていて、まだ一度も走っていなければ走る', () => {
    expect(isReviewDue(nine, 8, undefined)).toBe(true);
  });

  it('今日（JST）すでに走っていれば走らない', () => {
    expect(isReviewDue(nine, 8, new Date('2026-10-11T23:10:00Z'))).toBe(false);
  });

  it('昨日の分までしか走っていなければ走る', () => {
    expect(isReviewDue(nine, 8, new Date('2026-10-11T00:00:00Z'))).toBe(true);
  });

  it('日付は UTC ではなく JST で数える', () => {
    expect(jstDay(new Date('2026-10-11T15:30:00Z'))).toBe('2026-10-12');
  });
});

describe('maskSecrets', () => {
  it.each([
    ['Authorization: Bearer abcdef0123456789xyz', 'Authorization: Bearer ***'],
    ['password=hunter2&user=a', 'password=***&user=a'],
    ['"api_key": "abc123def456"', '"api_key": "***'],
    ['token: s3cr3tvalue', 'token: ***'],
    ['key sk-abcdefghijklmnop1234', 'key sk-***'],
    ['ghp_abcdefghijklmnopqrstu', 'ghp_***'],
    ['postgres://user:pa55@db:5432/x', 'postgres://user:***@db:5432/x'],
  ])('%s を伏せる', (input, expected) => {
    expect(maskSecrets(input)).toContain(expected);
    expect(maskSecrets(input)).not.toMatch(/hunter2|abcdef0123456789xyz|pa55/);
  });

  it('秘密でないものは変えない', () => {
    const line = 'GET /health 200 12ms';
    expect(maskSecrets(line)).toBe(line);
  });
});

describe('groupLogPatterns', () => {
  it('時刻・IP・数字が違うだけの行を 1 つにまとめ、多い順に返す', () => {
    const lines = [
      '2026/10/11 15:00:40 [error] 1153#1153: *44968207 connect() failed to 10.52.0.4:80',
      '2026/10/11 15:01:12 [error] 1153#1153: *44968999 connect() failed to 10.52.0.9:80',
      '2026/10/11 15:02:00 [error] 1153#1153: *1 connect() failed to 10.52.0.4:80',
      'panic: runtime error',
    ];
    const grouped = groupLogPatterns(lines, 5);
    expect(grouped[0]?.count).toBe(3);
    expect(grouped[0]?.pattern).toContain('connect() failed to <ip>');
    expect(grouped[1]).toMatchObject({ count: 1 });
  });

  it('正規化の過程で秘密も伏せる', () => {
    expect(normalizeLogLine('login token=abcd1234efgh')).toContain('token=***');
  });
});

describe('formatJstWindow', () => {
  it('同じ日なら日付は 1 回', () => {
    expect(
      formatJstWindow(
        new Date('2026-10-15T18:00:00Z'),
        new Date('2026-10-15T20:00:00Z'),
      ),
    ).toBe('10-16 03:00〜05:00（JST）');
  });

  it('日をまたぐなら両端に日付を付ける', () => {
    expect(
      formatJstWindow(
        new Date('2026-10-15T14:00:00Z'),
        new Date('2026-10-15T16:00:00Z'),
      ),
    ).toBe('10-15 23:00〜10-16 01:00（JST）');
  });
});

describe('settleReportedSurges', () => {
  const surge = (source: string) => ({
    id: `error-surge:${source}`,
    severity: 'warning' as const,
    title: 't',
    detail: 'd',
  });

  it('報告済みで収まっていれば外し、続いていれば添え、未報告ならそのまま', () => {
    const { kept, calmed } = settleReportedSurges(
      [surge('a'), surge('b'), surge('c')],
      new Set(['error-surge:a', 'error-surge:b']),
      new Set(['error-surge:b']),
    );

    expect(calmed).toEqual(['error-surge:a']);
    expect(kept.map((f) => f.id)).toEqual(['error-surge:b', 'error-surge:c']);
    expect(kept[0]?.detail).toContain('いまも続いている');
    expect(kept[1]?.detail).toBe('d');
  });
});
