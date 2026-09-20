import * as v from 'valibot';
import { buildVisemeTimeline, type Mora } from '../../domain/lipsync.ts';
import type { SettingsProvider } from '../../domain/ports/settings-provider.ts';
import type {
  SpeechSynthesizer,
  SynthesizedSpeech,
} from '../../domain/ports/speech-synthesizer.ts';
import { logger } from '../../observability/logger.ts';

/**
 * Discord の音声は 48kHz ステレオ 16bit。**エンジン側に最初からこの形で
 * 出力させる**ので、こちら側のリサンプリングは要らない（既存 discord-vc の
 * `resamplePcm` はこの指定が無かったための後処理で、移植しない）。
 */
const OUTPUT_SAMPLING_RATE = 48000;

const SYNTHESIS_TIMEOUT_MS = 30_000;
const CONTRACT_TIMEOUT_MS = 10_000;

/** 契約検証に使う短文。モーラが取れることだけを確かめる。 */
const CONTRACT_PROBE_TEXT = 'あ';

const SpeakersSchema = v.array(
  v.object({
    name: v.string(),
    styles: v.array(v.object({ id: v.number(), name: v.string() })),
  }),
);

/**
 * リップシンク（F-21）に必要な分だけを読む。合成そのものは `/synthesis` が
 * 返すバイト列で判断するため、ここでは扱わない。
 *
 * **クエリ全体はそのまま `/synthesis` へ渡す。** ここで作り直すと、この
 * スキーマに書いていない項目（`intonationScale` など）が落ちる。
 */
const MoraSchema = v.object({
  text: v.string(),
  vowel: v.string(),
  vowel_length: v.number(),
  consonant_length: v.nullish(v.number()),
});

const AudioQuerySchema = v.object({
  accent_phrases: v.pipe(
    v.array(
      v.object({
        moras: v.array(MoraSchema),
        pause_mora: v.nullish(MoraSchema),
      }),
    ),
    v.minLength(1),
  ),
  prePhonemeLength: v.number(),
  postPhonemeLength: v.number(),
});

type ParsedAudioQuery = v.InferOutput<typeof AudioQuerySchema>;

/**
 * アクセント句をまたいで 1 本のモーラ列にする。**句の切れ目の間
 * （`pause_mora`）も同じ列に混ぜる** —— 口を閉じる時間も長さのうちで、
 * 落とすと以降の口形が全部前にずれる。
 */
function morasOf(query: ParsedAudioQuery): Mora[] {
  return query.accent_phrases.flatMap((phrase) =>
    [...phrase.moras, ...(phrase.pause_mora ? [phrase.pause_mora] : [])].map(
      (mora) => ({
        vowel: mora.vowel,
        vowelLength: mora.vowel_length,
        consonantLength: mora.consonant_length,
      }),
    ),
  );
}

export interface CreateVoicevoxSynthesizerInput {
  /** エンジンのベース URL。コードにホスト名も既定の話者も埋め込まない（D-05）。 */
  baseUrl: string;
  /** 話者 ID・話速・音高は設定ファイル側（F-60）。毎回読み直して反映する。 */
  settings: SettingsProvider;
}

export function createVoicevoxSynthesizer(
  input: CreateVoicevoxSynthesizerInput,
): SpeechSynthesizer {
  const baseUrl = input.baseUrl.replace(/\/$/, '');

  async function request(
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `音声合成エンジンへの ${path} が失敗しました: ${response.status} ${response.statusText}`,
      );
    }
    return response;
  }

  async function audioQuery(
    text: string,
    speakerId: number,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const path = `/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`;
    const response = await request(path, { method: 'POST' }, timeoutMs);
    return (await response.json()) as Record<string, unknown>;
  }

  return {
    async synthesize(text): Promise<SynthesizedSpeech> {
      const { speakerId, speedScale, pitchScale } = input.settings.get().voice;

      const query = await audioQuery(text, speakerId, SYNTHESIS_TIMEOUT_MS);
      query.speedScale = speedScale;
      query.pitchScale = pitchScale;
      query.outputSamplingRate = OUTPUT_SAMPLING_RATE;
      query.outputStereo = true;

      // 起動時に契約を確かめてある（verifyContract）ので、ここで読めないのは
      // エンジンが途中で入れ替わったとき。**縮退させずに落とす** ——
      // 口が動かないまま声だけ出るのは、黙って壊れている状態そのもの。
      const parsed = v.safeParse(AudioQuerySchema, query);
      if (!parsed.success) {
        throw new Error(
          `音声合成エンジンの /audio_query を解釈できませんでした（リップシンクが作れません）: ${v.summarize(parsed.issues)}`,
        );
      }

      const response = await request(
        `/synthesis?speaker=${speakerId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(query),
        },
        SYNTHESIS_TIMEOUT_MS,
      );

      const wav = new Uint8Array(await response.arrayBuffer());
      return {
        pcm: extractPcm(wav),
        // 長さは常に等倍で返るので、実際に鳴る時刻にするには送った
        // speedScale で割る（実測、→ D-38 の 2）。
        lipSync: buildVisemeTimeline({
          moras: morasOf(parsed.output),
          speedScale,
          leadingSilence: parsed.output.prePhonemeLength,
          trailingSilence: parsed.output.postPhonemeLength,
        }),
      };
    },

    async verifyContract(): Promise<void> {
      const { speakerId } = input.settings.get().voice;

      const version = await (
        await request('/version', { method: 'GET' }, CONTRACT_TIMEOUT_MS)
      ).text();

      const speakersBody = await (
        await request('/speakers', { method: 'GET' }, CONTRACT_TIMEOUT_MS)
      ).json();
      const speakers = v.safeParse(SpeakersSchema, speakersBody);
      if (!speakers.success) {
        throw new Error(
          `音声合成エンジンの /speakers を解釈できませんでした。VOICEVOX 互換 API を持つエンジンを指してください（D-05）: ${v.summarize(speakers.issues)}`,
        );
      }
      const style = speakers.output
        .flatMap((speaker) =>
          speaker.styles.map((s) => ({ speaker: speaker.name, ...s })),
        )
        .find((s) => s.id === speakerId);
      if (!style) {
        throw new Error(
          `設定された話者 ID ${speakerId} はこのエンジンに存在しません。settings.yaml の voice.speakerId を確認してください。`,
        );
      }

      // `/synthesis` だけ通って `/audio_query` のモーラが取れないエンジンだと、
      // リップシンク（F-21）が黙って壊れる。ここで落とす。
      const probe = v.safeParse(
        AudioQuerySchema,
        await audioQuery(CONTRACT_PROBE_TEXT, speakerId, CONTRACT_TIMEOUT_MS),
      );
      if (!probe.success) {
        throw new Error(
          `音声合成エンジンの /audio_query がモーラ単位の音素と長さを返しません。リップシンク（F-21）が成立しないため起動を中止します: ${v.summarize(probe.issues)}`,
        );
      }

      logger.info(
        {
          engineVersion: version.replaceAll('"', ''),
          speakerId,
          speaker: style.speaker,
          style: style.name,
        },
        'Speech synthesis engine contract verified',
      );
    },
  };
}

/**
 * WAV のヘッダを剥がして PCM 本体だけを返す。
 *
 * `outputSamplingRate` / `outputStereo` を指定しているので、中身は必ず
 * 48kHz ステレオ 16bit。フォーマット変換はしない —— 変換が必要な状態に
 * なったなら、それはエンジンへの指定が効いていないということなので落とす。
 */
function extractPcm(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ascii = (offset: number) =>
    String.fromCharCode(...wav.subarray(offset, offset + 4));

  if (ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') {
    throw new Error('音声合成エンジンが WAV を返しませんでした。');
  }

  let offset = 12;
  while (offset + 8 <= wav.byteLength) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === 'fmt ') {
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      if (
        channels !== 2 ||
        sampleRate !== OUTPUT_SAMPLING_RATE ||
        bitsPerSample !== 16
      ) {
        throw new Error(
          `音声合成エンジンが ${sampleRate}Hz / ${channels}ch / ${bitsPerSample}bit を返しました。` +
            `outputSamplingRate と outputStereo の指定が効いていません。`,
        );
      }
    } else if (id === 'data') {
      return wav.subarray(body, body + size);
    }

    // チャンクサイズは偶数境界へ揃えられる。
    offset = body + size + (size % 2);
  }

  throw new Error('WAV に data チャンクがありません。');
}
