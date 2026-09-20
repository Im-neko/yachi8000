import { describe, expect, it } from 'vitest';
import { buildVisemeTimeline, type Mora } from './lipsync.ts';

/** 「カ」相当。子音 0.1 秒 + 母音 0.2 秒。 */
const ka: Mora = { vowel: 'a', vowelLength: 0.2, consonantLength: 0.1 };
/** 「イ」相当。子音なし。 */
const i: Mora = { vowel: 'i', vowelLength: 0.2, consonantLength: null };

describe('buildVisemeTimeline', () => {
  it('母音が鳴り始める時刻で口形を切り替える（子音の間は前の口が残る）', () => {
    const timeline = buildVisemeTimeline({
      moras: [ka],
      speedScale: 1,
      leadingSilence: 0.1,
      trailingSilence: 0.1,
    });

    expect(timeline.frames).toEqual([
      { at: 0, viseme: 'sil' },
      // 先頭の無音 0.1 + 子音 0.1
      { at: 0.2, viseme: 'aa' },
      // + 母音 0.2
      { at: 0.4, viseme: 'sil' },
    ]);
    expect(timeline.duration).toBeCloseTo(0.5, 10);
  });

  it('speedScale で全体が縮む（D-38 の実測どおり、先頭と末尾の無音も含めて）', () => {
    const timeline = buildVisemeTimeline({
      moras: [ka],
      speedScale: 2,
      leadingSilence: 0.1,
      trailingSilence: 0.1,
    });

    expect(timeline.frames).toEqual([
      { at: 0, viseme: 'sil' },
      { at: 0.1, viseme: 'aa' },
      { at: 0.2, viseme: 'sil' },
    ]);
    expect(timeline.duration).toBeCloseTo(0.25, 10);
  });

  it('母音ごとに口形が決まる', () => {
    const vowels = ['a', 'i', 'u', 'e', 'o'];
    const timeline = buildVisemeTimeline({
      moras: vowels.map((vowel) => ({ vowel, vowelLength: 0.1 })),
      speedScale: 1,
      leadingSilence: 0,
      trailingSilence: 0,
    });

    expect(timeline.frames.map((frame) => frame.viseme)).toEqual([
      'sil',
      'aa',
      'ih',
      'ou',
      'ee',
      'oh',
      'sil',
    ]);
  });

  // 「シャツ」の「ツ」のように声が出ないモーラ。口は動くので閉じない。
  it('無声化母音（大文字）も同じ口形にする', () => {
    const timeline = buildVisemeTimeline({
      moras: [{ vowel: 'U', vowelLength: 0.1, consonantLength: 0.05 }],
      speedScale: 1,
      leadingSilence: 0,
      trailingSilence: 0,
    });

    expect(timeline.frames[1]).toEqual({ at: 0.05, viseme: 'ou' });
  });

  it('撥音・促音・間は口を閉じる', () => {
    const timeline = buildVisemeTimeline({
      moras: [
        ka,
        { vowel: 'N', vowelLength: 0.1 },
        { vowel: 'cl', vowelLength: 0.1 },
        { vowel: 'pau', vowelLength: 0.3 },
      ],
      speedScale: 1,
      leadingSilence: 0,
      trailingSilence: 0,
    });

    expect(timeline.frames).toEqual([
      { at: 0, viseme: 'sil' },
      { at: 0.1, viseme: 'aa' },
      // 撥音で閉じたあとは、促音も間も同じ sil なのでまとまる
      { at: 0.3, viseme: 'sil' },
    ]);
    expect(timeline.duration).toBeCloseTo(0.8, 10);
  });

  it('同じ口形が続くところはまとめる', () => {
    const timeline = buildVisemeTimeline({
      moras: [ka, { vowel: 'a', vowelLength: 0.2, consonantLength: 0.1 }],
      speedScale: 1,
      leadingSilence: 0,
      trailingSilence: 0,
    });

    expect(timeline.frames).toEqual([
      { at: 0, viseme: 'sil' },
      { at: 0.1, viseme: 'aa' },
      { at: 0.6, viseme: 'sil' },
    ]);
  });

  // エンジンを差し替えたときに、知らない音素へ勝手な口を当てない。
  it('知らない音素は口を閉じる', () => {
    const timeline = buildVisemeTimeline({
      moras: [i, { vowel: 'xx', vowelLength: 0.1 }],
      speedScale: 1,
      leadingSilence: 0,
      trailingSilence: 0,
    });

    expect(timeline.frames.map((frame) => frame.viseme)).toEqual([
      'sil',
      'ih',
      'sil',
    ]);
  });

  it('モーラが 1 つも無ければ閉じたままになる', () => {
    const timeline = buildVisemeTimeline({
      moras: [],
      speedScale: 1,
      leadingSilence: 0.1,
      trailingSilence: 0.1,
    });

    expect(timeline.frames).toEqual([{ at: 0, viseme: 'sil' }]);
    expect(timeline.duration).toBeCloseTo(0.2, 10);
  });

  it('speedScale が 0 以下なら落とす（無限大の時刻を作らない）', () => {
    expect(() =>
      buildVisemeTimeline({
        moras: [ka],
        speedScale: 0,
        leadingSilence: 0,
        trailingSilence: 0,
      }),
    ).toThrow(/speedScale/);
  });
});
