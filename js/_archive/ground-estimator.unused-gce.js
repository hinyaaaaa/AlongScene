/* ============================================================
   [ADR-017 アーカイブ注記 / 未使用]
   このファイルはmain.jsを含むどこからもimportされていない、孤立した
   実装です。実際に使われているのは js/environment/ground-estimator.js
   (固定高さの仮想床を保持するだけのシンプルな実装)。

   下の本体(GCE: カメラ高さの数値入力によるキャリブレーション+
   localStorage永続化)は、後からのUX変更でより単純な実装に置き換わり、
   削除されずに取り残されたものと推測されます。設計として無価値では
   ないため削除はせず、参照用としてここに退避しました。
   本番機能として復活させる場合は、js/environment/ground-estimator.js
   とAPI(getGroundPlane/setGroundHeight/getGroundHeight)を揃えた上で
   main.js側のimport先を切り替える必要があります。
   ============================================================ */
/* ============================================================
   ground-estimator.js — Ground Confidence Engine (GCE)
   ------------------------------------------------------------
   ARCore/ARKitのような平面認識がないSafari環境で、「床がどこに
   あるか」を確定させるためのエンジン。

   【2026/07 改訂: 傾きベース計算(Step1 Gravity)を撤去】
   従来は起動時に「画面中央のラインを床に合わせる」操作から、
   DeviceOrientationの傾き(pitch)を三角関数で逆算してfloorYを
   算出していた。実機検証の結果、タップ配置(computeFloorPointFromScreen)
   経由で「Distance: 31.32m」等の異常値が発生することが判明し、
   調査の結果、根本原因は「camera.quaternion(ジャイロ推定姿勢)自体の
   精度が保証されていない」という、このアプリのAR実装の構造的な
   制約にあることが分かった。傾きに基づく三角関数は、傾きの推定誤差が
   わずかでもtan()の性質上大きく増幅されるため、そもそも採用すべき
   ではなかったと判断した。

   加えて「画面の線を目視で床に合わせる」操作自体も、ユーザーからの
   「自分の目で接地判定するのは信頼できない」という指摘を受けて廃止した。

   代わりに、**カメラのレンズの床からの高さをユーザーが数値で入力・
   確認する**方式に変更した。このアプリのシーンではカメラは常に
   ワールド原点(0,0,0)固定であり(main.jsのcamera.position.set(0,0,0))、
   かつキャラクターは実寸(メートル)で自己校正されているため、
       floorY = -cameraHeightMeters
   という単純な符号反転だけで、傾きの逆算を一切行わずに床のY座標が
   確定する。これが今回の変更の核心。

   重要: camera.quaternion(ジャイロAR用の姿勢)は「見回した時に
   キャラクターがその場に留まって見える」という見た目の演出にのみ
   使用し、床の高さ・距離計算には二度と使わない(CONSTRAINTS.md参照)。

   ------------------------------------------------------------
   Strategy Patternの構造自体は維持している(将来のOptical Flow導入時に
   差し替えやすくするため)。GravityStrategyのDeviceOrientation購読は
   floorY算出からは完全に切り離した上で、将来の別用途(手ぶれ検知とは
   別軸での使用可能性)のために構造だけ残してある。
   ============================================================ */

const STORAGE_KEY_DEFAULT = 'alongscene_ground_calibration_v1';
// ADR-017 リブランディング(OshiCamera→AlongScene)に伴うキー改名。
// 既存ユーザーの床キャリブレーションを消さないよう、新キーが空の場合のみ
// 旧キーから一度だけ読み込んで新キーへ書き戻す(_load内で実施)。
const LEGACY_STORAGE_KEY_V1 = 'oshi_ground_calibration_v1';

// カメラの高さ(cm)のデフォルト値・許容範囲
const DEFAULT_CAMERA_HEIGHT_CM = 150;
const CAMERA_HEIGHT_MIN_CM = 80;
const CAMERA_HEIGHT_MAX_CM = 220;

// confidenceの目安値:
//   0.3 = 高さ未確認(デフォルト値のまま)
//   0.9 = ユーザーが数値を確認・確定済み
const CONFIDENCE_UNCONFIRMED = 0.3;
const CONFIDENCE_CONFIRMED = 0.9;

// confidenceの指数移動平均の更新率(毎フレーム大きく変化させないため)
const CONFIDENCE_EMA_ALPHA = 0.12;

/* ------------------------------------------------------------
   Strategy 1(床の高さ算出には使わない): 重力方向(DeviceOrientation)
   ------------------------------------------------------------
   floorYの計算からは完全に切り離した。将来、手ぶれ検知とは別の
   用途で姿勢の生値が必要になった場合のために構造だけ残す。
   ------------------------------------------------------------ */
class GravityStrategy {
  constructor() {
    this.betaDeg = 90;
    this.gammaDeg = 0;
    this.available = false;
    this._onEvent = this._onEvent.bind(this);
  }
  attach() {
    window.addEventListener('deviceorientation', this._onEvent);
  }
  detach() {
    window.removeEventListener('deviceorientation', this._onEvent);
  }
  _onEvent(e) {
    if (e.beta === null || e.beta === undefined) return;
    this.betaDeg = e.beta;
    this.gammaDeg = e.gamma || 0;
    this.available = true;
  }
  getSignal() {
    return { pitchDeg: this.betaDeg, rollDeg: this.gammaDeg, available: this.available };
  }
}

/* ------------------------------------------------------------
   Strategy 2: 実測カメラ高さによる床の確定
   ------------------------------------------------------------
   ユーザーが確認・入力した「カメラのレンズの床からの高さ(cm)」を
   保持するだけのシンプルな戦略。傾きからの逆算は一切行わない。
   ------------------------------------------------------------ */
class MeasuredHeightStrategy {
  constructor(storageKey) {
    this.storageKey = storageKey;
    this.cameraHeightMeters = DEFAULT_CAMERA_HEIGHT_CM / 100;
    this.confirmed = false;
    this._load();
  }
  _load() {
    try {
      let raw = localStorage.getItem(this.storageKey);
      let migrating = false;
      // 新キーに値がなければ、改名前(oshi_...)の旧キーを一度だけ読む。
      // 見つかった場合は新キーへ書き戻し、旧キーは消さずに残す
      // (万一のロールバック時にも古いビルドが読めるようにするため)。
      if (raw === null && this.storageKey !== LEGACY_STORAGE_KEY_V1) {
        raw = localStorage.getItem(LEGACY_STORAGE_KEY_V1);
        migrating = raw !== null;
      }
      if (raw === null) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed.cameraHeightMeters === 'number' && Number.isFinite(parsed.cameraHeightMeters)) {
        this.cameraHeightMeters = parsed.cameraHeightMeters;
        this.confirmed = true;
        if (migrating) this.save(this.cameraHeightMeters);
      }
    } catch (e) {
      console.warn('ground calibration load failed', e);
    }
  }
  /** @param {number} cameraHeightMeters */
  save(cameraHeightMeters) {
    this.cameraHeightMeters = cameraHeightMeters;
    this.confirmed = true;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ cameraHeightMeters, confirmedAt: Date.now() }));
    } catch (e) {
      console.warn('ground calibration save failed', e);
    }
  }
  clear() {
    this.cameraHeightMeters = DEFAULT_CAMERA_HEIGHT_CM / 100;
    this.confirmed = false;
    try { localStorage.removeItem(this.storageKey); } catch (e) { /* noop */ }
  }
  hasConfirmation() {
    return this.confirmed;
  }
  getCameraHeightMeters() {
    return this.cameraHeightMeters;
  }
  getFloorY() {
    return -this.cameraHeightMeters;
  }
}

/* ------------------------------------------------------------
   Strategy 3(未実装スタブ): Optical Flow
   ------------------------------------------------------------
   将来実装予定。今回はスコープ外(スタブのまま維持)。
   ------------------------------------------------------------ */
class OpticalFlowStrategyStub {
  getSignal() {
    return { confidence: 0, available: false };
  }
}

/* ------------------------------------------------------------
   GroundEstimator
   ------------------------------------------------------------ */
export class GroundEstimator {
  /**
   * @param {object} [options]
   * @param {string} [options.storageKey] localStorageの保存キー
   * @param {number} [options.referenceDistanceMeters] 互換性のため引数は
   *   受け取るが、実測高さ方式では使用しない(傾きからの逆算をやめたため)。
   */
  constructor({ storageKey = STORAGE_KEY_DEFAULT } = {}) {
    this.gravity = new GravityStrategy();
    this.measured = new MeasuredHeightStrategy(storageKey);
    this.opticalFlow = new OpticalFlowStrategyStub(); // 将来実装時に差し替える

    this._confidence = this.measured.hasConfirmation() ? CONFIDENCE_CONFIRMED : CONFIDENCE_UNCONFIRMED;
    this._floorY = this.measured.getFloorY();
    this._pitchDeg = 0;
    this._rollDeg = 0;
  }

  start() {
    this.gravity.attach();
  }
  stop() {
    this.gravity.detach();
  }

  isCalibrated() {
    return this.measured.hasConfirmation();
  }

  getCameraHeightMeters() {
    return this.measured.getCameraHeightMeters();
  }
  getCameraHeightCm() {
    return Math.round(this.measured.getCameraHeightMeters() * 100);
  }
  static get DEFAULT_CAMERA_HEIGHT_CM() { return DEFAULT_CAMERA_HEIGHT_CM; }
  static get CAMERA_HEIGHT_MIN_CM() { return CAMERA_HEIGHT_MIN_CM; }
  static get CAMERA_HEIGHT_MAX_CM() { return CAMERA_HEIGHT_MAX_CM; }

  /**
   * キャリブレーションUIで「OK」が押された時に呼ぶ。
   * 傾きの逆算は一切行わず、渡された高さをそのまま保存する。
   * @param {number} cameraHeightMeters ユーザーが確認・入力したカメラの高さ(m)
   */
  calibrate(cameraHeightMeters) {
    const clamped = Math.min(
      CAMERA_HEIGHT_MAX_CM / 100,
      Math.max(CAMERA_HEIGHT_MIN_CM / 100, cameraHeightMeters)
    );
    this.measured.save(clamped);
    this._floorY = this.measured.getFloorY();
    this._confidence = CONFIDENCE_CONFIRMED;
    return this._floorY;
  }

  recalibrateReset() {
    this.measured.clear();
    this._floorY = this.measured.getFloorY();
    this._confidence = CONFIDENCE_UNCONFIRMED;
  }

  /** 毎フレーム(またはそれに準ずる頻度で)呼ぶ。重い処理は含まない。 */
  update() {
    const g = this.gravity.getSignal();
    this._pitchDeg = g.pitchDeg;
    this._rollDeg = g.rollDeg;

    const flow = this.opticalFlow.getSignal(); // 将来実装後はここで安定度を加味する
    let targetConfidence;
    if (flow.available && flow.confidence > 0) {
      targetConfidence = Math.min(1, CONFIDENCE_CONFIRMED + flow.confidence * (1 - CONFIDENCE_CONFIRMED));
    } else {
      targetConfidence = this.measured.hasConfirmation() ? CONFIDENCE_CONFIRMED : CONFIDENCE_UNCONFIRMED;
    }
    // 指数移動平均(EMA)で滑らかに追従させ、毎フレーム大きく変化させない。
    this._confidence += (targetConfidence - this._confidence) * CONFIDENCE_EMA_ALPHA;

    // floorYは常にmeasured戦略から直接取得する(傾きセンサーには一切依存しない)。
    this._floorY = this.measured.getFloorY();
  }

  /** @returns {{ floorY: number, confidence: number, pitch: number, roll: number }} */
  getGround() {
    return {
      floorY: this._floorY,
      confidence: this._confidence,
      pitch: this._pitchDeg,
      roll: this._rollDeg,
    };
  }
}
