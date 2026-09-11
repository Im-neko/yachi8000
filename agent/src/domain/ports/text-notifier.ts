/**
 * VC へ出せなかった通知のテキスト配信先（F-15）。
 */
export interface TextNotifier {
  send(channelId: string, text: string): Promise<void>;
}
