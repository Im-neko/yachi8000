import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  forgetAboutSpeaker,
  rememberAboutSpeaker,
  renameSpeaker,
} from '../application/person.ts';
import { personDependencies } from '../composition-root.ts';
import type { SpeakerId } from '../domain/speaker.ts';

export interface PersonToolsContext {
  /** 今話している相手（F-05）。判別できない入口ではこのツール群を配らない。 */
  speakerId: SpeakerId;
}

/**
 * 今話している相手のプロフィール（F-05）。
 *
 * **長期記憶（F-30）との使い分けがすべて。** ここに入れたものは検索されずに
 * **毎ターン必ずプロンプトへ載る**ので、「この人と話すときに毎回効いて
 * ほしいこと」だけを入れる。会話に出てくる第三者の話は `remember_fact` へ。
 *
 * **人格（F-33）とも別。** 人格はアシスタント自身の話し方で、誰に対しても
 * 同じように効く（→ D-35）。「この人には敬語で」はプロフィール側。
 */
export function createPersonTools(ctx: PersonToolsContext) {
  const remember = defineTool({
    name: 'remember_about_person',
    description:
      '今話している相手について、次からも毎回踏まえておきたいことを覚えます。' +
      '呼び方の好み・接し方・苦手なこと・立場など、**その人と話すたびに効いてほしいこと**だけに使ってください。' +
      '会話に出てきた第三者の話や、一度きりの出来事は remember_fact を使います。' +
      '毎ターン読み込まれるので、増やしすぎないでください。',
    input: v.object({
      content: v.pipe(v.string(), v.minLength(1), v.maxLength(300)),
    }),
    run({ data }) {
      const note = rememberAboutSpeaker(personDependencies, {
        speakerId: ctx.speakerId,
        content: data.content,
      });
      return `この人について覚えました: ${note.content}（ID: ${note.id}）`;
    },
  });

  const forget = defineTool({
    name: 'forget_about_person',
    description:
      '今話している相手について覚えたことを 1 件忘れます。ID はプロンプトの「話しかけている人」か remember_about_person が返した値です。' +
      '本人から明示的に頼まれたときだけ使ってください。',
    input: v.object({
      id: v.pipe(v.string(), v.uuid()),
    }),
    run({ data }) {
      const removed = forgetAboutSpeaker(personDependencies, {
        speakerId: ctx.speakerId,
        noteId: data.id,
      });
      return removed
        ? `${data.id} を忘れました。`
        : `${data.id} は見つかりませんでした。`;
    },
  });

  const rename = defineTool({
    name: 'set_person_name',
    description:
      '今話している相手の呼び名を変えます。「〇〇って呼んで」と頼まれたときに使ってください。' +
      '一度これで決めた呼び名は、Discord の表示名が変わっても上書きされません。',
    input: v.object({
      name: v.pipe(v.string(), v.minLength(1), v.maxLength(50)),
    }),
    run({ data }) {
      const profile = renameSpeaker(personDependencies, {
        speakerId: ctx.speakerId,
        displayName: data.name,
      });
      return `これからは「${profile.displayName}」と呼びます。`;
    },
  });

  return [remember, forget, rename];
}
