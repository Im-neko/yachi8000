/**
 * サーバの中で実行されたか（→ D-26 の 2）。
 *
 * **テナントを決めるためではない**（→ D-35 で廃止）。`/skill` `/persona` の
 * 権限の根拠が `ManageGuild` であり、ギルドの外ではそれを確かめる手立てが
 * 無いため。コマンドはギルド単位で登録するので DM には生えないが、
 * 権限の前提はコマンド側にも置いておく。
 */
export function isInGuild(interaction: { inGuild(): boolean }): boolean {
  return interaction.inGuild();
}
