import type { ChannelRouteDefinition } from '@flue/runtime';
import type { AgentTurnInput } from '../../agents/run-turn.ts';
import type { SpeechService } from '../../application/speech.ts';
import {
  resolveWebSpeaker,
  transcribeUtterance,
  type VoiceInputDependencies,
} from '../../application/voice-input.ts';
import { webConversationId } from '../../domain/conversation.ts';

/**
 * 受け取る音声の形式（→ D-47 の 2）。**3 つとも Whisper が受けることは
 * 実測済み**（→ D-16 の追記の 2）。Android Chrome は webm、iOS Safari は
 * mp4 を出すので、両方が要る。
 */
const ACCEPTED = ['audio/webm', 'audio/mp4', 'audio/wav'];

/**
 * 1 発話の上限。**これ以上は発話ではない。**
 *
 * webm/Opus なら数分、wav でも 1 分以上入る。切り出しが壊れて録りっぱなしに
 * なったものを、そのまま文字起こしへ流さないための堰。
 */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * 認証基盤が通す利用者名（→ D-37）。**ここでは「誰か」を決めるのに使う**
 * （設定 UI のログ用途とは違う → D-44 の 6）。
 *
 * **守りはこれではなく ingress。** このヘッダを自分で付けて Pod へ直接
 * 来られる相手は、そもそも認証の外にいる。ここでやっているのは認証ではなく
 * 「通った人が対応表のどの話者か」を引くこと（→ D-45）。
 */
const USER_HEADER = 'x-authentik-username';

export interface MicRoutesInput {
  voiceInput: VoiceInputDependencies;
  speech: SpeechService;
  /**
   * 1 ターンを回す。**合成ルートから渡す。**
   *
   * `runAgentTurn` を直に掴むと、この入口を確かめるだけで合成ルート
   * （設定ファイル・DB・Discord）まで起き上がる。入口の仕事は「受け取って
   * 渡す」ところまでで、そこはそこで確かめられるようにしておく。
   */
  runTurn: (input: AgentTurnInput) => Promise<string | undefined>;
}

/**
 * ブラウザのマイクから話しかける入口（F-13 の経路 B、→ D-47）。
 *
 * **`/api/v1/voice/` の下に置かない。** あの前置きは素通しの `publicPaths`
 * に入っており（`/api/v1/voice/status`）、そこへ足すと**インターネットから
 * 誰でもアシスタントに話しかけられる。**
 */
export function createMicRoutes(
  input: MicRoutesInput,
): ChannelRouteDefinition[] {
  const postUtterance: ChannelRouteDefinition['handler'] = async (c) => {
    const username = c.req.header(USER_HEADER);
    const speaker = resolveWebSpeaker(input.voiceInput, username);
    if (!speaker) {
      // **名乗りをそのまま返す。** 対応表は手で書くもので（→ D-44）、
      // 書くには認証基盤での自分の名前が要る。それを知る手立てが無いと、
      // 「誰か分かりません」と言われたまま何もできない。
      return c.json(
        {
          error: username
            ? `${username} は設定ファイルの web.speakers にいません。`
            : 'あなたが誰か分かりません（認証基盤の利用者名が届いていません）。',
          username: username ?? null,
        },
        403,
      );
    }

    const contentType = (c.req.header('content-type') ?? '')
      .split(';')[0]
      ?.trim();
    if (!contentType || !ACCEPTED.includes(contentType)) {
      return c.json(
        { error: `音声の形式が分かりません（${ACCEPTED.join(' / ')}）。` },
        415,
      );
    }

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length === 0) {
      return c.json({ error: '音声が空です。' }, 400);
    }
    if (bytes.length > MAX_BYTES) {
      return c.json({ error: '音声が長すぎます。' }, 413);
    }

    const heard = await transcribeUtterance(input.voiceInput, {
      bytes,
      contentType,
    });
    switch (heard.kind) {
      case 'not-configured':
        return c.json(
          { error: '文字起こしが設定されていません（STT_MODEL）。' },
          503,
        );
      case 'rate-limited':
        // **503 にしない。** 「落ちている」と同じ扱いにすると、少し待てば
        // 直ると読める（枠の超過は数時間単位で続く → Q-29）。状態コードでも
        // 区別する。
        return c.json({ error: heard.message, rateLimited: true }, 429);
      case 'unavailable':
        return c.json({ error: `いま聞き取れません: ${heard.message}` }, 503);
      case 'not-heard':
        // **失敗ではない。** 2 秒に満たない発話にはエンジンが空を返す
        // （→ D-16 の追記の 3）。**黙って捨てず、そう言う。**
        return c.json({ heard: false, transcript: null, reply: null });
      default:
        break;
    }

    const reply = await input.runTurn({
      conversationId: webConversationId(speaker.userId),
      message: {
        kind: 'signal',
        type: 'web.utterance',
        // **文字起こしは非信頼データ**（絶対ルール 6）。部屋にいる誰の声か
        // までは分からないので、指示としてではなく発言として渡す。
        body: heard.text,
        attributes: {
          speakerId: speaker.speakerId,
          speakerName: username ?? '',
        },
      },
    });

    if (reply) {
      // **出口の判定は発話側が 1 箇所で持つ**（→ D-40）。ここは
      // 「ブラウザから話しかけられた」とだけ言う。
      input.speech.speak({
        text: reply,
        priority: 'reply',
        origin: { kind: 'web-conversation' },
      });
    }

    return c.json({
      heard: true,
      transcript: heard.text,
      reply: reply ?? null,
    });
  };

  return [{ method: 'POST', path: '/mic/utterance', handler: postUtterance }];
}
