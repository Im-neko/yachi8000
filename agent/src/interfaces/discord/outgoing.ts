/** Discord の 1 メッセージあたりの上限。 */
const MAX_MESSAGE_LENGTH = 2000;

/**
 * 返信を Discord が受け取れる長さに分割する。
 *
 * 分割は表示の都合なので、エージェント側には持ち込まない。改行 → 空白 の
 * 順に区切りを探し、どちらも無ければ長さで切る。
 */
export function splitForDiscord(
  text: string,
  limit: number = MAX_MESSAGE_LENGTH,
): string[] {
  if (limit < 1) throw new Error('limit は 1 以上である必要があります。');

  const chunks: string[] = [];
  let rest = text.trim();

  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    let cut = window.lastIndexOf('\n');
    if (cut <= 0) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = limit;

    const chunk = rest.slice(0, cut).trimEnd();
    if (chunk !== '') chunks.push(chunk);
    rest = rest.slice(cut).trimStart();
  }

  if (rest !== '') chunks.push(rest);
  return chunks;
}
