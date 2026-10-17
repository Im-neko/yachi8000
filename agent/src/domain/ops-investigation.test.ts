import { describe, expect, it } from 'vitest';
import {
  distinctiveToken,
  findSurgeSpan,
  type OpsDossier,
  renderDossierFacts,
  renderHypothesis,
  shareOf,
  sliceThreshold,
} from './ops-investigation.ts';

describe('sliceThreshold', () => {
  it('平常の 1 区間ぶんの 3 倍。ごく静かな送信元は下限に張り付く', () => {
    expect(sliceThreshold(1_200, 12)).toBe(300);
    expect(sliceThreshold(0, 12)).toBe(10);
    expect(sliceThreshold(60, 12)).toBe(15);
  });
});

describe('findSurgeSpan', () => {
  it('超えた最初と最後の区間を返す。間に平常へ戻った区間があっても 1 つの出来事', () => {
    expect(findSurgeSpan([0, 5, 900, 800, 4, 700, 3], 100)).toEqual({
      first: 2,
      last: 5,
    });
  });

  it('しきい値ちょうどは超えていない。どの区間も超えなければ undefined', () => {
    expect(findSurgeSpan([100, 100], 100)).toBeUndefined();
    expect(findSurgeSpan([], 10)).toBeUndefined();
  });
});

describe('shareOf', () => {
  it('割合を返す。全体が 0 のときは 0% と言い切らず undefined', () => {
    expect(shareOf(94, 100)).toBe(0.94);
    expect(shareOf(5, 0)).toBeUndefined();
  });

  it('数え方の誤差で 1 を超えても 100% で止める', () => {
    expect(shareOf(110, 100)).toBe(1);
  });
});

describe('distinctiveToken', () => {
  it('英字と _ だけの一番長い語を使う。数字は正規化で潰れているので含めない', () => {
    expect(
      distinctiveToken(
        '<time> kernel: WARNING: CPU: N at smsdvb_do_tune',
        '2026-10-16T03:10:00Z kernel: WARNING: CPU: 1 at smsdvb_do_tune',
      ),
    ).toBe('smsdvb_do_tune');
  });

  it('時刻などの置き換え語は選ばない', () => {
    expect(
      distinctiveToken('<time> <uuid> <ip> ab cd', '<time> <uuid> <ip> ab cd'),
    ).toBeUndefined();
  });

  it('短い語しか無ければ選ばない（他の行にも出るので数えられない）', () => {
    expect(distinctiveToken('err N ok', 'err 1 ok')).toBeUndefined();
  });

  it('数字が隣り合う語は、正規化で化けて元の行に無いので選ばない', () => {
    // `v1beta1` は正規化すると `vNbetaN`。これで数えると、どの行にも当たらず 0 件になる。
    expect(
      distinctiveToken(
        'GET /apis/custom.metrics.k8s.io/vNbetaN userAgent',
        'GET /apis/custom.metrics.k8s.io/v1beta1 userAgent',
      ),
    ).toBe('userAgent');
  });
});

const flood: OpsDossier = {
  source: 'home/kernel',
  timeline: [
    {
      start: '2026-10-15T16:00:00.000Z',
      end: '2026-10-15T18:00:00.000Z',
      count: 4,
    },
    {
      start: '2026-10-15T18:00:00.000Z',
      end: '2026-10-15T20:00:00.000Z',
      count: 3_100_000,
    },
  ],
  threshold: 300,
  onset: '2026-10-15T18:10:00.000Z',
  startedBeforeTimeline: false,
  end: '2026-10-15T20:00:00.000Z',
  ongoing: false,
  peak: {
    start: '2026-10-15T18:00:00.000Z',
    end: '2026-10-15T20:00:00.000Z',
    count: 3_100_000,
  },
  dominant: {
    pattern: 'kernel: WARNING: smsdvb_do_tune',
    token: 'smsdvb_do_tune',
    share: 0.94,
  },
  precursors: ['sudo: modprobe -r smsdvb'],
  concurrent: ['アラート NodeNoisy が発火（warning）'],
  gaps: [],
};

describe('renderDossierFacts', () => {
  it('始まり・終わり・ピーク・割合・直前に初めて出た行・ほかの変化を事実として並べる', () => {
    expect(renderDossierFacts(flood)).toEqual([
      '10-16 03:10（JST）ごろから、10-16 05:00（JST）ごろまで',
      'いちばん多かった 10-16 03:00〜05:00（JST） は 3100000 件（急増とみなす目安は 1 区間 300 件超）',
      'その区間のエラー行の 94% が「kernel: WARNING: smsdvb_do_tune」の型',
      '始まりの前後に出て、その前の 24 時間には無かった行: 「sudo: modprobe -r smsdvb」',
      '同じ時間帯のほかの変化: アラート NodeNoisy が発火（warning）',
    ]);
  });

  it('いまも続いているときと、調べた範囲より前から続いているときを言い分ける', () => {
    const facts = renderDossierFacts({
      ...flood,
      ongoing: true,
      end: undefined,
      startedBeforeTimeline: true,
      onset: flood.timeline[0]?.start,
      precursors: [],
      concurrent: [],
    });
    expect(facts[0]).toBe('10-16 01:00（JST）より前から、いまも続いている');
  });

  it('調べられなかったことは黙らずに載せる（INV-7）', () => {
    const facts = renderDossierFacts({
      ...flood,
      dominant: undefined,
      precursors: [],
      concurrent: [],
      gaps: ['代表パターンの割合'],
    });
    expect(facts.at(-1)).toBe('調べられなかったこと: 代表パターンの割合');
  });
});

describe('renderHypothesis', () => {
  it('推測だと分かる印と確度を付け、確かめられていないことを添える', () => {
    expect(
      renderHypothesis({
        text: 'ドライバの入れ替えが引き金のようです。',
        confidence: 'medium',
        unverified: 'モジュールの版',
      }),
    ).toBe(
      '（推測・確度は中程度）ドライバの入れ替えが引き金のようです。（確かめられていないこと: モジュールの版）',
    );
  });

  it('確かめられていないことが無ければ添えない', () => {
    expect(
      renderHypothesis({ text: 'x', confidence: 'low', unverified: '' }),
    ).toBe('（推測・確度は低い）x');
  });
});
