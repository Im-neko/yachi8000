import type { ChannelRouteDefinition } from '@flue/runtime';
import * as v from 'valibot';
import {
  listVoices,
  readEditableSettings,
  type SettingsEditDependencies,
  updateEditableSettings,
} from '../../application/settings.ts';
import { AVATAR_EXPRESSIONS } from '../../domain/avatar.ts';

/** 名前・一人称は 1 行。読み上げの中に何度も出るので短く抑える。 */
const Line = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(40));

/**
 * 人格の記述。**末尾に改行を足す**のは、設定ファイルで `|` のブロックとして
 * 書き戻されるようにするため —— 1 行に潰れると、手で開いた人が読めない。
 */
const Paragraph = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(2000),
  v.transform((text) => `${text.replaceAll('\r\n', '\n')}\n`),
);

const EditableSettingsSchema = v.object({
  identity: v.object({ name: Line }),
  persona: v.object({
    firstPerson: Line,
    personality: Paragraph,
    speechStyle: Paragraph,
  }),
  // **範囲は設定ファイルのスキーマと同じ。** ここで弾くのは、書き戻して
  // から落ちるより先に「どの項目が駄目か」を返せるようにするため。
  avatar: v.optional(
    v.object({
      idleExpression: v.picklist(AVATAR_EXPRESSIONS),
      camera: v.object({
        targetHeight: v.pipe(v.number(), v.minValue(0), v.maxValue(5)),
        distance: v.pipe(v.number(), v.minValue(0.1), v.maxValue(20)),
      }),
    }),
  ),
  voice: v.object({
    speakerId: v.pipe(v.number(), v.integer(), v.minValue(0)),
    speedScale: v.pipe(v.number(), v.minValue(0.5), v.maxValue(2)),
    pitchScale: v.pipe(v.number(), v.minValue(-0.15), v.maxValue(0.15)),
  }),
  notification: v.object({ whenNoOutput: v.picklist(['text', 'drop']) }),
  behavior: v.object({
    personaLock: v.boolean(),
    reminderPollIntervalSeconds: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(5),
      v.maxValue(3600),
    ),
  }),
});

const UpdateRequestSchema = v.object({
  /** 読み出したときの版。**手編集との衝突を見るために持ち回る**（F-61）。 */
  version: v.pipe(v.string(), v.minLength(1)),
  settings: EditableSettingsSchema,
});

/**
 * 認証基盤が通してくれる利用者名（→ D-37）。**ログにしか使わない。**
 *
 * 権限の判断には使わない —— この経路を守っているのは ingress で、ヘッダを
 * 自分で付けて Pod へ直接来られる相手は、ヘッダを付けずにも同じことが
 * できる。つまりこれは「誰が変えたか」の手がかりであって、鍵ではない。
 */
const USER_HEADER = 'x-authentik-username';

export function createSettingsRoutes(
  deps: SettingsEditDependencies,
): ChannelRouteDefinition[] {
  const getSettings: ChannelRouteDefinition['handler'] = (c) =>
    c.json(readEditableSettings(deps));

  const getVoices: ChannelRouteDefinition['handler'] = async (c) => {
    try {
      return c.json({ speakers: await listVoices(deps) });
    } catch (error) {
      // **既定の一覧で代用しない。** 声の名前はエンジン次第（→ D-05）で、
      // こちらが知っていることは何も無い。
      return c.json(
        {
          error: `音声合成エンジンから声の一覧を取得できませんでした: ${(error as Error).message}`,
        },
        502,
      );
    }
  };

  const putSettings: ChannelRouteDefinition['handler'] = async (c) => {
    // **JSON だと名乗らない要求は受けない。** 画面の外から仕込まれた form は
    // この content-type を付けられない（付けると事前確認が要る）ので、
    // ブラウザが勝手に投げてしまう経路をここで閉じておく。
    if (!c.req.header('content-type')?.startsWith('application/json')) {
      return c.json(
        { error: 'content-type: application/json が必要です。' },
        415,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'JSON として読めませんでした。' }, 400);
    }

    const parsed = v.safeParse(UpdateRequestSchema, body);
    if (!parsed.success) {
      return c.json({ error: v.summarize(parsed.issues) }, 400);
    }

    const result = await updateEditableSettings(deps, {
      version: parsed.output.version,
      settings: parsed.output.settings,
      changedBy: c.req.header(USER_HEADER),
    });

    switch (result.kind) {
      case 'saved':
        return c.json({
          version: result.version,
          settings: result.settings,
        });
      case 'conflict':
        return c.json(
          {
            error:
              '読み込んだあとに設定が変わっています。読み直してから保存してください。',
          },
          409,
        );
      case 'avatar-not-configured':
        return c.json(
          {
            error:
              '設定ファイルに avatar 節がありません。VRM を置いて手で追記してください。',
          },
          409,
        );
      case 'unknown-speaker':
        return c.json(
          {
            error: `話者 ID ${result.speakerId} はこのエンジンにありません。`,
          },
          400,
        );
      case 'speakers-unavailable':
        return c.json(
          {
            error: `声を確かめられなかったので保存していません: ${result.message}`,
          },
          502,
        );
      default:
        return c.json({ error: result.message }, 400);
    }
  };

  return [
    { method: 'GET', path: '/settings', handler: getSettings },
    { method: 'PUT', path: '/settings', handler: putSettings },
    { method: 'GET', path: '/settings/voices', handler: getVoices },
  ];
}
