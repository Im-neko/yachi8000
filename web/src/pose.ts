import { type VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

/**
 * 待機の姿勢と、生きて見えるための細かい動き（F-24 の隣、→ Q-27）。
 *
 * **VRM は T ポーズで入ってくる。** それは「何も当てていない素の姿勢」で、
 * 見せるための姿勢ではない。モーション素材（VRMA）を持ち込む前に、
 * **ボーンを直接寝かせるだけで待機の見た目は作れる** —— 素材の置き場所も
 * 差し替えも要らないので、まずここから始める（モーション本体は Q-27）。
 *
 * **左右の符号はひとつの規則で揃う。** このモデルは VRM 1.0 の規約どおり、
 * T ポーズで左腕が +X・右腕が −X、前方が +Z（実測: つま先の z が足首より
 * 大きい）。腕を下ろす Z 回転も、前へ出す Y 回転も、指を握る Z 回転も、
 * **左が負・右が正**になる。
 */

/** 左右で符号が反転する。左が −1。 */
const LEFT = -1;
const RIGHT = 1;

interface BoneAngles {
  /** 腕の軸まわり（ひねり）。 */
  readonly x?: number;
  /** 前後へ振る。正の値が「前（+Z）」になるよう符号を掛けて使う。 */
  readonly y?: number;
  /** 下ろす・曲げる。 */
  readonly z?: number;
}

/**
 * 片腕ぶんの待機姿勢。**符号は左右で掛け分ける**ので、ここには大きさだけ。
 *
 * 肩から手までの寸法を実測して決めた（このモデルは上腕 0.22 m・前腕
 * 0.215 m、肩の付け根が x=0.109 / y=1.293、腰が y=0.908）。上腕を 1.25 rad
 * （72°）下ろし、肘を 0.2 rad 曲げると、**手は y=0.87 あたり —— ちょうど
 * 腰の高さの少し下**に落ちる。肘は x=0.178 で、付け根（0.109）より外側に
 * あるので胴体を抜けない。
 */
const ARM_REST: ReadonlyArray<{
  readonly left: VRMHumanBoneName;
  readonly right: VRMHumanBoneName;
  readonly angles: BoneAngles;
}> = [
  {
    left: VRMHumanBoneName.LeftShoulder,
    right: VRMHumanBoneName.RightShoulder,
    angles: { z: 0.06 },
  },
  {
    left: VRMHumanBoneName.LeftUpperArm,
    right: VRMHumanBoneName.RightUpperArm,
    angles: { y: 0.1, z: 1.25 },
  },
  {
    left: VRMHumanBoneName.LeftLowerArm,
    right: VRMHumanBoneName.RightLowerArm,
    angles: { y: 0.12, z: 0.2 },
  },
  {
    left: VRMHumanBoneName.LeftHand,
    right: VRMHumanBoneName.RightHand,
    angles: { z: 0.05 },
  },
];

/**
 * 指の握り。**軽く丸める程度**にする。
 *
 * T ポーズの手のひらは下（−Y）を向く（VRM 1.0 の規約）ので、握る向きは
 * 腕を下ろすのと同じ符号になる。**強く握らせない** —— 指の関節は
 * モデルによって素直に曲がらないことがあり、外すと目立つのは「握りすぎた手」。
 */
const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;

/** 付け根から先へ。先の関節ほど深く丸める。 */
const FINGER_JOINTS = [
  { part: 'Proximal', z: 0.18 },
  { part: 'Intermediate', z: 0.3 },
  { part: 'Distal', z: 0.22 },
] as const;

const FINGER_CURL: ReadonlyArray<{
  readonly left: VRMHumanBoneName;
  readonly right: VRMHumanBoneName;
  readonly z: number;
}> = FINGERS.flatMap((finger) =>
  FINGER_JOINTS.map(({ part, z }) => ({
    left: `left${finger}${part}` as VRMHumanBoneName,
    right: `right${finger}${part}` as VRMHumanBoneName,
    z,
  })),
);

/** 呼吸 1 回の長さ（秒）。**意識される速さにしない。** */
const BREATH_SECONDS = 4.5;
/** 体重の移し替え。呼吸と割り切れない長さにして、周期を悟らせない。 */
const SWAY_SECONDS = 11;

/** まばたきの間隔（秒）。この幅で毎回引き直す。 */
const BLINK_MIN_SECONDS = 2.5;
const BLINK_MAX_SECONDS = 6;
/** 閉じ切るまで / 開き切るまで。**人のまばたきは 0.1 秒台。** */
const BLINK_CLOSE_SECONDS = 0.06;
const BLINK_OPEN_SECONDS = 0.09;

export interface IdlePose {
  /**
   * 待機の姿勢を当てる。**読み込み直後に 1 回**。
   *
   * ここで当てた腕の角度は、以後 `update()` が基準値として揺らす。
   */
  apply(vrm: VRM): void;
  /** 呼吸とゆらぎを進める。**`vrm.update()` より先に呼ぶ。** */
  update(vrm: VRM, delta: number): void;
  /** いまのまばたきの重み（0〜1）。表情に混ぜるのは呼び出し側。 */
  blink(delta: number): number;
}

function setAngles(
  vrm: VRM,
  bone: VRMHumanBoneName,
  sign: number,
  angles: BoneAngles,
): void {
  // **持っていないボーンは飛ばす。** 指を持たないモデルは珍しくない。
  const node = vrm.humanoid.getNormalizedBoneNode(bone);
  if (!node) return;
  node.rotation.set(
    angles.x ?? 0,
    sign * (angles.y ?? 0),
    sign * (angles.z ?? 0),
  );
}

export function createIdlePose(): IdlePose {
  let elapsed = 0;
  let blinkWeight = 0;
  let untilBlink = nextBlinkInterval();
  /** 0 なら閉じ始めていない。閉じ始めてからの秒数。 */
  let blinking: number | undefined;

  function nextBlinkInterval(): number {
    return (
      BLINK_MIN_SECONDS +
      Math.random() * (BLINK_MAX_SECONDS - BLINK_MIN_SECONDS)
    );
  }

  return {
    apply(vrm) {
      for (const { left, right, angles } of ARM_REST) {
        setAngles(vrm, left, LEFT, angles);
        setAngles(vrm, right, RIGHT, angles);
      }
      for (const { left, right, z } of FINGER_CURL) {
        setAngles(vrm, left, LEFT, { z });
        setAngles(vrm, right, RIGHT, { z });
      }
      elapsed = 0;
      blinkWeight = 0;
      blinking = undefined;
      untilBlink = nextBlinkInterval();
    },

    update(vrm, delta) {
      elapsed += delta;
      const breath = Math.sin((elapsed / BREATH_SECONDS) * Math.PI * 2);
      const sway = Math.sin((elapsed / SWAY_SECONDS) * Math.PI * 2);

      // 胸を起こし、首で戻す。**戻さないと顎が上下に振れて、頷いて見える。**
      const chest = vrm.humanoid.getNormalizedBoneNode(
        VRMHumanBoneName.UpperChest,
      );
      if (chest) chest.rotation.x = -0.018 * breath;
      const neck = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Neck);
      if (neck) neck.rotation.x = 0.012 * breath;

      // 体重の移し替え。腰をひねるだけで、足は動かさない。
      const hips = vrm.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Hips);
      if (hips) {
        hips.rotation.y = 0.02 * sway;
        hips.rotation.z = 0.012 * sway;
      }

      // 腕は待機の角度を基準に揺らす。**基準を上書きしない**ように、
      // 毎フレーム基準 + ゆらぎで置き直す。
      const upper = ARM_REST[1];
      if (upper) {
        setAngles(vrm, upper.left, LEFT, {
          y: (upper.angles.y ?? 0) + 0.02 * sway,
          z: (upper.angles.z ?? 0) + 0.015 * breath,
        });
        setAngles(vrm, upper.right, RIGHT, {
          y: (upper.angles.y ?? 0) - 0.02 * sway,
          z: (upper.angles.z ?? 0) + 0.015 * breath,
        });
      }
    },

    blink(delta) {
      if (blinking === undefined) {
        untilBlink -= delta;
        if (untilBlink > 0) return 0;
        blinking = 0;
      }

      blinking += delta;
      if (blinking < BLINK_CLOSE_SECONDS) {
        blinkWeight = blinking / BLINK_CLOSE_SECONDS;
      } else if (blinking < BLINK_CLOSE_SECONDS + BLINK_OPEN_SECONDS) {
        blinkWeight = 1 - (blinking - BLINK_CLOSE_SECONDS) / BLINK_OPEN_SECONDS;
      } else {
        blinkWeight = 0;
        blinking = undefined;
        untilBlink = nextBlinkInterval();
      }
      return blinkWeight;
    },
  };
}
