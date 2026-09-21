import type { AvatarExpression } from './avatar.ts';
import type { PersonaProfile } from './persona.ts';

/**
 * 設定ファイルの内容（F-60）。人が直接編集でき、設定 UI も同じ実体を書く。
 * 接続先・認証情報は環境変数側にあり、ここには入らない。
 */
export interface Settings {
  identity: {
    name: string;
  };
  persona: {
    firstPerson: string;
    personality: string;
    speechStyle: string;
  };
  voice: {
    /** 音声合成エンジンの話者 ID。既定値をコードに埋め込まない（D-05）。 */
    speakerId: number;
    speedScale: number;
    pitchScale: number;
  };
  /**
   * アバターの表示（F-20, F-62）。**任意** —— 書いていなければアバターの
   * API が「設定されていません」を返すだけで、会話は普通に動く。
   */
  avatar?: {
    /** VRM ファイルのパス。設定ファイルと同じ PVC に置く（→ D-36 の 2）。 */
    vrmPath: string;
    /** 待機時の表情。**VRM 1.0 のプリセットだけ**（→ D-36 の 1）。 */
    idleExpression: AvatarExpression;
    camera: {
      /** 注視点の高さ（m）。 */
      targetHeight: number;
      /** 注視点からの距離（m）。 */
      distance: number;
    };
  };
  notification: {
    /**
     * **読み上げる出口がひとつも無いとき**の扱い（F-15, D-40）。VC にも
     * つながっておらず、音を鳴らせるブラウザも開いていない場合を指す。
     * どちらでも配信できなかったことはログに残す。
     */
    whenNoOutput: 'text' | 'drop';
    /** `whenNoOutput: 'text'` のときの配信先チャンネル。未設定なら破棄に倒す。 */
    fallbackChannelId?: string;
    /**
     * 通知が名前で選べる配信先（F-15）。
     *
     * **チャンネル ID をリクエストで受けない**のは、それを許すと「喋らせる」
     * ために配ったトークンが「Bot の見えるどこへでも書ける」権限に化けるため
     * （→ D-31）。送信元は名前で選ぶだけで、実体は運用者がここに置く。
     *
     * ギルド ID を併せて持つのは、読み上げを**同じサーバのときだけ**に
     * 絞るため（リマインダーの F-31 と同じ規則）。
     */
    channels?: Readonly<
      Record<string, { readonly guildId: string; readonly channelId: string }>
    >;
  };
  /**
   * Issue を立てる先（F-37）。**チャンネル ID → `owner/name`。**
   * ここに無いチャンネルでは起票しない（→ D-32）。
   */
  issueTracker?: {
    repositories: Record<string, string>;
  };
  behavior: {
    /** 人格・口調固定モード（F-34）。 */
    personaLock: boolean;
    /**
     * リマインダーの期限を確認する間隔（秒）（F-31, F-60）。
     *
     * 発火の粒度がそのままこの値になる。短くすると細かく鳴るが、その分
     * 空振りのクエリが増える。
     */
    reminderPollIntervalSeconds: number;
  };
}

export function personaProfileOf(settings: Settings): PersonaProfile {
  return {
    assistantName: settings.identity.name,
    firstPerson: settings.persona.firstPerson,
    personality: settings.persona.personality,
    speechStyle: settings.persona.speechStyle,
  };
}
