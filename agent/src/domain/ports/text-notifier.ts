/**
 * テキストチャンネルへの配信先。
 *
 * VC へ出せなかった通知（F-15）と、リマインダーの発火（F-31）の両方が使う。
 * どちらも「読み上げられなかった / 読み上げに加えて残したい」文面を
 * チャンネルへ流すという同じ関心事。
 */
export interface TextNotifier {
  send(channelId: string, text: string): Promise<void>;
}
