import type { OutputAvailability } from '../speech-audience.ts';

/**
 * いまつながっている出口を答える口（→ D-40）。
 *
 * 実体は「VC の接続」と「音を鳴らせるブラウザの数」の 2 つだが、
 * application はその内訳の出どころを知らない。**出口が増えてもここの形は
 * 変わらない** —— 増えるのは `OutputAvailability` の項目と、それを読む
 * `selectSpeechTargets` の規則だけ。
 */
export interface OutputAvailabilityProvider {
  current(): OutputAvailability;
}
