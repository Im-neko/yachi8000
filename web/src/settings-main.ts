import type { VrmExpressionPreset } from './api.ts';
import {
  type EditableSettings,
  EXPRESSION_LABELS,
  fetchMe,
  fetchSettings,
  fetchSpeakers,
  type LoadedSettings,
  SettingsError,
  saveSettings,
  VRM_EXPRESSION_PRESETS,
} from './settings-api.ts';
import './settings.css';

const formElement = document.querySelector<HTMLFormElement>('#form');
const statusElement = document.querySelector<HTMLParagraphElement>('#status');
const saveElement = document.querySelector<HTMLButtonElement>('#save');
const avatarElement = document.querySelector<HTMLElement>('#avatar-section');
const reloadElement = document.querySelector<HTMLButtonElement>('#reload');
if (
  !formElement ||
  !statusElement ||
  !saveElement ||
  !avatarElement ||
  !reloadElement
) {
  throw new Error('ページの土台が見つかりません。');
}
const form: HTMLFormElement = formElement;
const status: HTMLParagraphElement = statusElement;
const saveButton: HTMLButtonElement = saveElement;
const avatarSection: HTMLElement = avatarElement;
const reloadButton: HTMLButtonElement = reloadElement;

function show(message: string, kind: 'info' | 'error' = 'info'): void {
  status.textContent = message;
  status.dataset.kind = kind;
}

/**
 * name で入力欄を引く。**無ければ投げる** —— HTML と食い違ったまま
 * 「なぜか一部だけ保存されない」状態で動き続けるほうが厄介。
 */
function field(name: string): HTMLInputElement {
  const element = form.elements.namedItem(name);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`入力欄 ${name} が見つかりません。`);
  }
  return element;
}

function textarea(name: string): HTMLTextAreaElement {
  const element = form.elements.namedItem(name);
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error(`入力欄 ${name} が見つかりません。`);
  }
  return element;
}

function select(name: string): HTMLSelectElement {
  const element = form.elements.namedItem(name);
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`選択欄 ${name} が見つかりません。`);
  }
  return element;
}

function option(value: string, label: string): HTMLOptionElement {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}

/** つまみの横に今の値を出す。動かしている最中に数字が見えないと合わせられない。 */
function followRange(input: HTMLInputElement, output: HTMLOutputElement): void {
  const render = () => {
    output.textContent = input.value;
  };
  input.addEventListener('input', render);
  render();
}

/** 読み出した版。**保存のたびに新しい版へ差し替える**（F-61）。 */
let loaded: LoadedSettings | undefined;

function fill(next: LoadedSettings): void {
  loaded = next;
  const s = next.settings;

  field('identity.name').value = s.identity.name;
  field('persona.firstPerson').value = s.persona.firstPerson;
  textarea('persona.personality').value = s.persona.personality;
  textarea('persona.speechStyle').value = s.persona.speechStyle;

  // **avatar 節が無い設定では、この一式ごと出さない。** 出して保存させても
  // サーバが断る（節を作るには VRM のパスが要る）ので、押せる形で置かない。
  avatarSection.hidden = !s.avatar;
  if (s.avatar) {
    select('avatar.idleExpression').value = s.avatar.idleExpression;
    field('avatar.camera.targetHeight').valueAsNumber =
      s.avatar.camera.targetHeight;
    field('avatar.camera.distance').valueAsNumber = s.avatar.camera.distance;
  }

  select('voice.speakerId').value = String(s.voice.speakerId);
  field('voice.speedScale').valueAsNumber = s.voice.speedScale;
  field('voice.pitchScale').valueAsNumber = s.voice.pitchScale;
  select('notification.whenNoOutput').value = s.notification.whenNoOutput;
  field('behavior.personaLock').checked = s.behavior.personaLock;
  field('behavior.reminderPollIntervalSeconds').valueAsNumber =
    s.behavior.reminderPollIntervalSeconds;

  form.dispatchEvent(new Event('input', { bubbles: true }));
}

function collect(): EditableSettings {
  const base: EditableSettings = {
    identity: { name: field('identity.name').value },
    persona: {
      firstPerson: field('persona.firstPerson').value,
      personality: textarea('persona.personality').value,
      speechStyle: textarea('persona.speechStyle').value,
    },
    voice: {
      speakerId: Number(select('voice.speakerId').value),
      speedScale: field('voice.speedScale').valueAsNumber,
      pitchScale: field('voice.pitchScale').valueAsNumber,
    },
    notification: {
      whenNoOutput:
        select('notification.whenNoOutput').value === 'text' ? 'text' : 'drop',
    },
    behavior: {
      personaLock: field('behavior.personaLock').checked,
      reminderPollIntervalSeconds: field('behavior.reminderPollIntervalSeconds')
        .valueAsNumber,
    },
  };
  if (avatarSection.hidden) return base;
  return {
    ...base,
    avatar: {
      idleExpression: select('avatar.idleExpression')
        .value as VrmExpressionPreset,
      camera: {
        targetHeight: field('avatar.camera.targetHeight').valueAsNumber,
        distance: field('avatar.camera.distance').valueAsNumber,
      },
    },
  };
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!loaded) return;

  saveButton.disabled = true;
  show('保存しています…');
  saveSettings({ version: loaded.version, settings: collect() })
    .then((saved) => {
      // **返ってきたものを画面へ入れ直す。** サーバ側で整えた形（末尾の
      // 改行など）がそのまま次の保存の材料になる。
      fill(saved);
      show('保存しました。');
    })
    .catch((error: unknown) => {
      if (error instanceof SettingsError && error.status === 409) {
        // **勝手に読み直さない。** 入力中の内容を黙って捨てることになる。
        show(
          `${error.message}\n（読み直すと、いま入力した内容は消えます）`,
          'error',
        );
        return;
      }
      show(error instanceof Error ? error.message : String(error), 'error');
    })
    .finally(() => {
      saveButton.disabled = false;
    });
});

/** 保存されている内容を取り直す。**入力中の内容は消える**ので、押されたときだけ。 */
reloadButton.addEventListener('click', () => {
  reloadButton.disabled = true;
  show('読み直しています…');
  fetchSettings()
    .then((next) => {
      fill(next);
      show('読み直しました。');
    })
    .catch((error: unknown) => {
      show(error instanceof Error ? error.message : String(error), 'error');
    })
    .finally(() => {
      reloadButton.disabled = false;
    });
});

/**
 * いま誰として通っているかを出す（→ D-45）。
 *
 * **対応表に無ければ、書き足す 1 行をそのまま見せる。** 対応表は設定
 * ファイルに手で書くもので（→ D-44）、書くには認証基盤での自分の名前が
 * 要る —— それが分からないと「あなたが誰か分かりません」で止まる。
 *
 * **取れなくても設定は開く。** ここは案内であって、設定の一部ではない。
 */
function showMe(): void {
  const section = document.querySelector<HTMLElement>('#identity');
  const line = document.querySelector<HTMLParagraphElement>('#me');
  if (!section || !line) return;

  fetchMe()
    .then((me) => {
      if (!me.username) {
        line.textContent =
          '認証基盤の利用者名が届いていません（forward auth の内側で開いてください）。';
      } else if (me.speakerId) {
        line.textContent = `${me.username} として通っています（話者: ${me.speakerId}）。`;
      } else {
        line.textContent = [
          `${me.username} として通っていますが、話者が決まっていません。`,
          'マイクから話しかけるには、設定ファイルへこの 2 行を足してください:',
          '',
          'web:',
          '  speakers:',
          `    "${me.username}": "discord-user-<Discord のユーザー ID>"`,
        ].join('\n');
      }
      section.hidden = false;
    })
    .catch(() => {
      // 案内が出ないだけ。設定そのものは触れる。
    });
}

try {
  show('設定を読み込んでいます…');
  // **声の一覧が取れないときは設定も出さない。** 話者の選択肢が無い画面で
  // 保存させると、選び直せないまま他の項目だけが書き換わる。
  const [settings, speakers] = await Promise.all([
    fetchSettings(),
    fetchSpeakers(),
  ]);

  const expressions = select('avatar.idleExpression');
  for (const preset of VRM_EXPRESSION_PRESETS) {
    expressions.append(option(preset, EXPRESSION_LABELS[preset]));
  }
  const speakerSelect = select('voice.speakerId');
  for (const speaker of speakers) {
    speakerSelect.append(option(String(speaker.id), speaker.label));
  }

  const speed = document.querySelector<HTMLOutputElement>('#speed-value');
  const pitch = document.querySelector<HTMLOutputElement>('#pitch-value');
  if (speed) followRange(field('voice.speedScale'), speed);
  if (pitch) followRange(field('voice.pitchScale'), pitch);

  fill(settings);
  form.hidden = false;
  showMe();
  show('');
} catch (error) {
  // 何が駄目だったかをそのまま出す。設定ファイルが置かれていないのか、
  // エンジンに繋がらないのかで、次にやることが違う。
  show(
    `設定を読み込めませんでした。\n${
      error instanceof Error ? error.message : String(error)
    }`,
    'error',
  );
}
