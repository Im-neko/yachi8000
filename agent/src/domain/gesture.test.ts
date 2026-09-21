import { describe, expect, it } from 'vitest';
import {
  MIN_GESTURE_CONFIDENCE,
  MIN_GESTURE_INTERVAL_MS,
  NO_GESTURE,
  shouldSkipGesture,
  toGesture,
} from './gesture.ts';

describe('toGesture', () => {
  it('確信のある身振りはそのまま通す', () => {
    expect(toGesture('nod', 0.9)).toBe('nod');
  });

  it('確信度が足りなければ出さない', () => {
    expect(toGesture('nod', MIN_GESTURE_CONFIDENCE - 0.01)).toBeUndefined();
  });

  // 身振りは推測で代用できない。知らないラベルは黙って捨てる。
  it('語彙に無いラベルは出さない', () => {
    expect(toGesture('dance', 1)).toBeUndefined();
    expect(toGesture(NO_GESTURE, 1)).toBeUndefined();
  });
});

describe('shouldSkipGesture', () => {
  it('間が空いていなければ見送る', () => {
    expect(shouldSkipGesture(1_000, 1_000 + MIN_GESTURE_INTERVAL_MS - 1)).toBe(
      true,
    );
    expect(shouldSkipGesture(1_000, 1_000 + MIN_GESTURE_INTERVAL_MS)).toBe(
      false,
    );
  });

  it('まだ一度も出していなければ見送らない', () => {
    expect(shouldSkipGesture(undefined, 1_000)).toBe(false);
  });
});
