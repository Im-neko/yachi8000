import type { PersonaProfile } from './persona.ts';

/**
 * 設定ファイルの内容（F-60）。人が直接編集でき、設定 UI も同じ実体を書く。
 * 接続先・認証情報は環境変数側にあり、ここには入らない。
 */
export interface Settings {
  identity: {
    name: string;
    userAddress: string;
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
  notification: {
    /** VC に未接続のときの扱い（F-15）。どちらでも配信できなかったことはログに残す。 */
    whenNotInVoice: 'text' | 'drop';
    /** `whenNotInVoice: 'text'` のときの配信先チャンネル。未設定なら破棄に倒す。 */
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
    userAddress: settings.identity.userAddress,
    firstPerson: settings.persona.firstPerson,
    personality: settings.persona.personality,
    speechStyle: settings.persona.speechStyle,
  };
}
