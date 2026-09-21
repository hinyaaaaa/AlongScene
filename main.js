import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';
import { createEnvironmentLighting } from './js/lighting.js';
import { createShadowRig } from './js/shadow/shadow-rig.js';
import { initShadowControlsUI } from './js/shadow-controls-ui.js';
import { applyPhotoFinish } from './js/postfx.js';
import { applyAtmosphericPerspective } from './js/atmosphere.js';
import { CHARACTERS } from './js/characters-data.js';
import { loadCharacter as loadCharacterCore, disposeCharacter } from './js/character.js';
import { initDiagnostics } from './js/diagnostics.js';
import { createIdleMotionManager } from './js/idle-motion.js';
import { GroundEstimator } from './js/environment/ground-estimator.js';
import { PlacementReticle } from './js/placement-reticle.js';
import { computePerceptualScaleFactor } from './js/perceptual-scale.js';
import { createCompassCalibration } from './js/compass-calibration.js';
import { looksLikeOutdoorSky } from './js/shadow/environment-shadow.js';
import { ICONS, injectIcons } from './js/icons.js';

// ADR-017: 絵文字アイコンを自作の線画SVGへ置き換え。DOM解析後(モジュール
// スクリプトはdeferと同等)すぐに一括差し込みする。動的に切り替わる
// アイコン(撮影モードのカメラ/動画)は各所でICONSを直接参照する。
injectIcons();

let currentCharacterIndex = 0;

/* ============================================================
   DOM
   ============================================================ */
const selectScreen  = document.getElementById('select-screen');
const characterList = document.getElementById('character-list');
const selectDots    = document.getElementById('select-dots');
const startScreen   = document.getElementById('start-screen');
const startBtn      = document.getElementById('start-btn');
const startError    = document.getElementById('start-error');
const stageWrap     = document.getElementById('stage-wrap');
const stage         = document.getElementById('stage');
const video         = document.getElementById('camera-video');
const canvas        = document.getElementById('three-canvas');
const reticleBtn    = document.getElementById('reticle-btn');
const resetBtn      = document.getElementById('reset-btn');
const debugBtn      = document.getElementById('debug-btn');
const shutterBtn    = document.getElementById('shutter-btn');
const resultScreen  = document.getElementById('result-screen');
const resultImg     = document.getElementById('result-img');
const resultHint    = document.getElementById('result-hint');
const shareBtn      = document.getElementById('share-btn');
const retakeBtn     = document.getElementById('retake-btn');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText   = document.getElementById('loading-text');
const timerBtn = document.getElementById('timer-btn');
const countdownOverlay = document.getElementById('countdown-overlay');
const countdownNum = document.getElementById('countdown-num');
const flashOverlay = document.getElementById('flash-overlay');
const shutterStatus = document.getElementById('shutter-status');
const modeBtn = document.getElementById('mode-btn');
const resultImgWrap = document.getElementById('result-imgwrap');
const resultVideo = document.getElementById('result-video');
const poseToast = document.getElementById('pose-toast');
const pointAdjustPanel = document.getElementById('point-adjust-panel');
const pointYawSlider = document.getElementById('point-yaw');
const pointPitchSlider = document.getElementById('point-pitch');

let poseToastTimer = null;
function showPoseToast(text) {
  poseToast.textContent = text;
  poseToast.classList.add('show');
  clearTimeout(poseToastTimer);
  poseToastTimer = setTimeout(() => poseToast.classList.remove('show'), 1200);
}

/* ============================================================
   状態
   ============================================================ */
const placement = { x: 0, y: -1.1, z: -3.2, rotY: 0, scale: 1 };
const DEFAULT_PLACEMENT = { ...placement };

// 2026/08(ADR-016): カメラ切替機能を廃止した(hinya指示)。本アプリは
// AR配置・接地推定・投影補正のすべてを背面カメラの画角(FOV_BY_FACING.
// environment相当)を前提に作り込んでおり、フロントカメラ切替は
// そもそも使用頻度が低く「ボタンが多くて分かりにくい」の一因だった。
// facingMode/switchCamBtn/ミラー表示等、関連コードを全て削除し、
// 常に背面カメラのみを使う構成に単純化した。
let currentStream = null;
let currentBlobUrl = null;
let lastBlob = null;

// スタート画面(カメラ/センサー許可フロー)を一度でも完走したかどうか。
// resetBtn経由で「推しを選び直す」際、2回目以降は許可ダイアログを
// 再度出す必要がないため、選び直し時はこのフラグを見て
// キャラクターの再読み込みだけを行う(start-screenへは戻らない)。
let appStarted = false;

// 現在読み込み済みのキャラクター(js/character.jsのMMDCharacter/SpriteCharacter)。
// 【重要】この宣言は必ずshadowRig/shadowControls/diagnostics等の初期化より
// 前に置くこと。initShadowControlsUI()は生成時に一度applyPlacement()を
// 同期的に呼ぶ(手動オーバーライドの初期化のため)ため、もしactiveCharacterの
// let宣言がそれより後にあると、applyPlacement()内でのactiveCharacter参照が
// 「初期化前のlet変数へのアクセス」(TDZ)としてReferenceErrorになり、
// main.js全体の実行がその場で止まってしまう(結果としてinitCharacterSelect()
// も実行されず、キャラクター選択画面にカードが1枚も生成されないまま
// 見た目上「選択画面が表示されない」ように見える不具合になっていた)。
let activeCharacter = null;

/* ============================================================
   three.js セットアップ
   ============================================================ */
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, alpha: true, preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

// OutlineEffect: MMDの材質のエッジ情報を使って輪郭線を描画する。
// ただしMMDそのままの太い黒線は「MMDらしさ」が強く出るため、
// モデル読み込み後に各材質のoutlineParametersを上書きして
// 細く・少し透けた線にすることでアニメ調に寄せている。
const effect = new OutlineEffect(renderer, { defaultThickness: 0.0015, defaultColor: [0.05, 0.04, 0.05], defaultAlpha: 0.6 });

const scene = new THREE.Scene();
/* 遠近法(パースペクティブ)についての注記(Sprint 1「遠近法」対応):
   three.jsのPerspectiveCamera.fovは垂直画角(度)。iPhoneの背面広角
   レンズ(26mm相当)は対角画角がおよそ73〜78度、16:9クロップ時の
   垂直画角に換算すると約42〜44度になるという公開情報を根拠に42度とした。
   実際のレンズ画角とはズレがあり得るため、実機で違和感があれば
   この値を直接調整すること。
   2026/08(ADR-016): カメラ切替廃止に伴い、フロント用の40度は不要に
   なったため削除し、単一の定数にした。 */
const CAMERA_VERTICAL_FOV_DEG = 42;
const camera = new THREE.PerspectiveCamera(CAMERA_VERTICAL_FOV_DEG, 1, 0.05, 100);
camera.position.set(0, 0, 0);

// トーンマッピング: 明るさが1.0を超えた部分をハードに白飛びさせず、
// 映画・写真的になだらかに丸める。実写背景に馴染ませる狙いも兼ねる。
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

// ライト構成についての重要な注記(MMDToonShaderのソースで確認済み):
// HemisphereLight(環境光)はトゥーンのグラデーション階調を経由せず、
// そのままベタ塗りで加算される(RE_IndirectDiffuse_BlinnPhong)。
// そのため強くしすぎるとトゥーンの階調が潰れて全体が白っぽく平坦になる。
// DirectionalLightは階調を経由するので、これらより強めにしても階調は保たれる。
// これらは「環境光推定」が周囲の明るさに応じて掛け合わせるための基準値。
const BASE_HEMI_INTENSITY = 0.35;
const BASE_DIR_INTENSITY = 0.85;
const BASE_RIM_INTENSITY = 0.25;
const BASE_TONE_EXPOSURE = 1.0;

const hemi = new THREE.HemisphereLight(0xffffff, 0x2a2a33, BASE_HEMI_INTENSITY);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xfff2d8, BASE_DIR_INTENSITY);
dir.position.set(1.2, 2.4, 1.6);
scene.add(dir);
// リムライト：背景写真に馴染ませるための縁光。CGっぽい平坦な陰影を減らす狙い。
const rim = new THREE.DirectionalLight(0xcfe8ff, BASE_RIM_INTENSITY);
rim.position.set(-1.5, 1.8, -2.0);
scene.add(rim);

// 足元の影(Contact Shadow・太陽光によるDirectional Shadow・環境連動の
// 濃さ補正)は js/shadow/ 以下のShadowRigに委譲(ADR-014)。
// rendererを渡すとshadowMap.enabled/typeを自動設定する。
const shadowRig = createShadowRig(scene, { renderer, quality: 'high' });

// 影の向き・長さ 手動調整パネル(ADR-016でハロー・ダイヤル方式に刷新)。
// 自動推定が撮影時に破綻した場合の保険。UIロジックはjs/shadow-controls-ui.js
// に分離し、main.js側は生成のみを行う(CONSTRAINTS.md モジュール分割ルール)。
// onManualChangeにapplyPlacementを渡すことで、ダイヤル操作・手動トグルの
// ON/OFF・リセットのいずれでも影が即座に再計算されるようにしている
// (2026/08修正、詳細はjs/shadow-controls-ui.js冒頭コメント参照)。
const shadowControls = initShadowControlsUI(shadowRig, { onManualChange: () => applyPlacement() });

// 環境解析(GPS/太陽位置/カメラ画像解析)・投影整合性チェック・距離較正・
// 画面内デバッグコンソールの初期化。CONSTRAINTS.md 1節の通り、まだ
// ドラフト運用の位置づけ(将来CONSTRAINTS.md改訂で正式化する)。
const diagnostics = initDiagnostics({
  video, stage, camera, renderer,
  getCharacter: () => activeCharacter,
  placement,
  applyPlacement,
  baseVerticalFovDeg: () => camera.fov,
});

// デバッグコンソールの開閉ボタンは、以前は画面左上に単独で浮いていたが、
// 「右上のボタン一覧(ファン・ドック)に集約してほしい」という指示を受け、
// #debug-btn(top-dock内)から開閉するように変更した。
if (debugBtn) {
  debugBtn.addEventListener('click', () => diagnostics.toggleDebugConsole());
}

// 環境光推定(平均色/輝度/簡易光源方向/露出)は js/lighting.js に委譲。
// getEnvironmentStateを渡すことで、EnvironmentAnalyzerのaverageLuminance/
// skyColor/groundColor/estimatedColorTemperatureを既存の画像ベース推定へ
// 弱くブレンドする(js/lighting.js参照)。
const environmentLighting = createEnvironmentLighting({
  video, hemi, dir, rim, renderer,
  baseIntensities: { hemi: BASE_HEMI_INTENSITY, dir: BASE_DIR_INTENSITY, rim: BASE_RIM_INTENSITY },
  baseToneExposure: BASE_TONE_EXPOSURE,
  getEnvironmentState: () => diagnostics.getEnvironmentState(),
});

// コンパス較正(ADR-014の既知の制約への対応、ROADMAP.md「太陽方位角の
// コンパス較正」)。iOS SafariのwebkitCompassHeadingを使い、
// EnvironmentAnalyzerのsunAzimuth(地理方位、GPS未取得時は既定緯度+
// 端末時刻による概算)をこのアプリのAR空間内での相対角へ変換する。
// 詳細はjs/compass-calibration.js冒頭コメント参照。
const compassCalibration = createCompassCalibration();

// 20260722平面推定指示書 Part1: 固定高さの仮想床。
const groundEstimator = new GroundEstimator(DEFAULT_PLACEMENT.y);
// 20260722平面推定指示書 Part2〜4: 配置レティクル。
const placementReticle = new PlacementReticle(scene);
let placementMode = false;

// 実際のARカメラアプリ(Pokémon GO/IKEA Place等)を参考にした初回設置フロー。
// 「起動直後にまずレティクルで床を狙い、タップで設置してからメインUIが
// 使えるようになる」体験にするため、モデル読み込み完了後は一旦非表示のまま
// 待機させ、設置確定後に初めて表示・配置する。
let pendingInitialPlacement = false;
const placementIntro = document.getElementById('placement-intro');
const uiLayer = document.getElementById('ui-layer');

/* ============================================================
   キャラクターの抽象化・材質調整・ロード処理は js/character.js に委譲。
   (activeCharacter変数自体はファイル冒頭で宣言済み。理由は冒頭の
   コメント参照)
   ============================================================ */
function loadCharacter(def) {
  loadCharacterCore(def, { MMDLoader, scene }, {
    onLoad: (character) => {
      activeCharacter = character;
      // 初回設置が確定するまでキャラクター自体は非表示にしておく
      // (裏読み込みは先に済ませ、体感の待ち時間を減らす)。
      character.root.visible = false;
      buildPoseRing(def);
      loadingOverlay.classList.add('hide');
      beginInitialPlacement();
    },
    onProgress: (xhr) => {
      if (xhr.lengthComputable) {
        const pct = Math.round((xhr.loaded / xhr.total) * 100);
        loadingText.textContent = `推しを読み込み中… ${pct}%`;
      }
    },
    onError: (err) => {
      console.error('MMD load error', err);
      loadingText.textContent = 'モデルの読み込みに失敗しました。ファイル配置を確認してください。';
    },
  });
}

/* ============================================================
   カメラのフレーミング(自動)
   ------------------------------------------------------------
   2026/08: 「全身/上半身/顔アップ」の手動切替ボタン(旧#framing-bar)は
   廃止した。代わりに、ポーズに応じてカメラ位置を自動で切り替える方式に
   変更した。「自撮り」ポーズ(poses.hip)を選ぶと、腕を伸ばして自分を
   撮っているような距離感・高さへ自動でカメラを寄せ、それ以外のポーズに
   戻すと通常の全身framingへ自動的に戻る。
   ============================================================ */
const DEFAULT_CAM_POS = { z: 0, y: 0 };
// 自撮り(hip)ポーズ用のカメラ位置。腕を伸ばして自分を写す距離感・
// 見上げ気味の角度に寄せる(実機未確認のたたき台、違和感があれば要調整)。
const SELFIE_CAM_POS = { z: -1.3, y: 0.35 };

function applyCameraFraming(poseKey) {
  const p = poseKey === 'hip' ? SELFIE_CAM_POS : DEFAULT_CAM_POS;
  camera.position.z = p.z;
  camera.position.y = p.y;
  applyPlacement();
}

/* ============================================================
   指差しポーズ 専用: 指す方向の微調整パネル
   ------------------------------------------------------------
   「指差し」ポーズ(poses.thinking)を選んでいる間だけ表示し、
   スライダーで右腕/右ひじの向き(character.jsのpointYaw/pointPitch
   全体オフセット)を調整できるようにする。他のポーズへ切り替えたら
   値を0に戻す(見た目に影響を残さないため)。
   ============================================================ */
function updatePointAdjustVisibility(poseKey) {
  const show = poseKey === 'thinking';
  pointAdjustPanel.classList.toggle('show', show);
  if (!show) {
    pointYawSlider.value = '0';
    pointPitchSlider.value = '0';
    if (activeCharacter) {
      activeCharacter.setGlobalOffset('pointYaw', 0);
      activeCharacter.setGlobalOffset('pointPitch', 0);
    }
  }
}
pointYawSlider.addEventListener('input', () => {
  if (activeCharacter) activeCharacter.setGlobalOffset('pointYaw', Number(pointYawSlider.value));
});
pointPitchSlider.addEventListener('input', () => {
  if (activeCharacter) activeCharacter.setGlobalOffset('pointPitch', Number(pointPitchSlider.value));
});

/* ============================================================
   ポーズ/表情セレクター(常時2段のリング)
   ------------------------------------------------------------
   実体はグローバルスクリプトのwindow.PoseRingとして
   index.htmlで先に読み込んでいる(main.jsより前・type=moduleではない
   通常scriptとして読み込むことで、main.js側からそのまま参照できる)。
   2026/08: 内部実装(js/pose-ring.js)はポーズ⇄表情のタブ切替から
   常時2段表示へ変更したが、ここから呼ぶ公開APIの形は変わっていない。
   ============================================================ */
function buildPoseRing(def) {
  const poseItems = Object.entries(def.poses).map(([key, p]) => ({ key, emoji: p.emoji, label: p.label }));
  const exprItems = Object.entries(def.expressions).map(([key, p]) => ({ key, emoji: p.emoji, label: p.label }));
  window.PoseRing.init(
    [
      { key: 'pose', label: 'ポーズ', items: poseItems },
      { key: 'expr', label: '表情', items: exprItems },
    ],
    (categoryKey, itemKey, item) => {
      if (!activeCharacter) return;
      if (categoryKey === 'pose') {
        activeCharacter.setPose(itemKey);
        // 「座る」等centerOffsetを使うポーズは足元のワールドYが変わるため、
        // ポーズ切り替え時にも接地影の位置を再計算する。
        applyCameraFraming(itemKey);
        updatePointAdjustVisibility(itemKey);
        showPoseToast(`ポーズ: ${item.label}`);
      } else if (categoryKey === 'expr') {
        activeCharacter.setExpression(itemKey);
        showPoseToast(`表情: ${item.label}`);
      }
    }
  );
}

/* ============================================================
   配置の反映
   ------------------------------------------------------------
   ADR-017: ドラッグ中のライブプレビュー(previewPlacementAt)から
   確定前のplacement本体を書き換えずに呼べるよう、実処理を
   applyPlacementCore(p)として切り出した。applyPlacement()は
   従来通り確定済みのplacementに対して呼ぶ薄いラッパーとして残す。
   ============================================================ */
function applyPlacementCore(p) {
  if (!activeCharacter) return;

  const distanceFromCam = Math.abs(p.z - camera.position.z);

  // 20260722平面推定指示書 Part7/Part8: 知覚スケール補正はあくまで演出。
  // p.scale自体は書き換えず、setTransformへ渡す直前でのみ
  // 乗算する(ピンチ拡縮・キャラクター設定・将来の保存データに
  // 補正が混入しないようにするため)。
  const perceptualFactor = computePerceptualScaleFactor(distanceFromCam);
  activeCharacter.setTransform({ ...p, scale: p.scale * perceptualFactor });

  const footY = activeCharacter.getFootY();
  const width = activeCharacter.getWidth();

  const azimuthConfidence = diagnostics.getAzimuthConfidence();
  const environmentState = diagnostics.getEnvironmentState();

  // 20260722影修正指示書 Part1 + コンパス較正:
  // 屋外・コンパス較正済みの場合は地理方位ベースのAR相対角を優先し、
  // それ以外は従来通りlighting.jsの画像ベース推定を使う。
  let lightAzimuthDeg = environmentLighting.getEstimatedAzimuthDeg();

  // 2026/08改訂: 当初は`environmentType === 'indoor'`かどうかで
  // 方位を固定するかを判定していたが、「GPSが取れただけでoutdoorScoreが
  // 押し上げられ、実際は方向性の無い拡散光の部屋なのにenvironmentType
  // ='outdoor'になる」ケース(indoor/outdoor判定自体がまだGPS成功に
  // 引っ張られやすいバイアスを持つ)が実機ログで確認された。
  // indoor/outdoorというラベルではなく、実際の空色が「屋外の光らしいか」
  // (影の強さの判定で使っているlooksLikeOutdoorSkyと同じ基準)で
  // 判定するように統一する。こうすることで、GPSの成否やラベルの
  // 誤判定に振り回されず、「本当に方向性のある光を裏付ける材料が
  // あるかどうか」だけで方位を固定するか判断できる。
  const hasPlausibleLightDirection = environmentState && looksLikeOutdoorSky(environmentState.skyColor);

  // 2026/08修正(ADR-015案): 「影が常に真後ろに伸びる」という報告への対応。
  // 従来はここで`environmentState.gpsAccuracy != null && gpsAccuracy <= 20`を
  // 必須条件にしていたため、GPS許可が下りない実機(GPS許可ダイアログが
  // 表示されない不具合を含む)では、この分岐に一度も到達できず、
  // 常に画像ベースの弱い推定(実質ほぼ0度=真後ろ)に落ち続けていた。
  //
  // js/environment-analyzer.js側で、GPS未取得時は既定緯度(東京)+
  // 端末のローカル時刻から「概算」の太陽方位を常に計算するように
  // 変更した(environmentState.sunPositionIsRoughで判別可能)ため、
  // ここではGPS精度の必須チェックを撤廃し、コンパス
  // (webkitCompassHeading、compassCalibration.isAvailable())さえ
  // 取得できていれば、この較正済み方位を使うようにする。
  // GPSが実際に取得できている場合は、environment-analyzer.js側で
  // 自動的により正確な値に切り替わるため、ここでの扱いは変わらない。
  if (environmentState && !hasPlausibleLightDirection) {
    // 拡散光・屋内らしい場合は、方向性のある光を裏付ける材料が無いため
    // 中立値(0度)のまま(この判断基準は変更していない)。
    lightAzimuthDeg = 0;
  } else if (
    environmentState &&
    hasPlausibleLightDirection &&
    environmentState.sunAzimuth != null &&
    compassCalibration.isAvailable()
  ) {
    const calibratedAzimuth = compassCalibration.toARRelativeAzimuth(environmentState.sunAzimuth);
    if (calibratedAzimuth != null) lightAzimuthDeg = calibratedAzimuth;
  }

  shadowRig.update(
    footY, width, p,
    lightAzimuthDeg,
    environmentLighting.getBrightnessFactor(),
    distanceFromCam,
    camera.position,
    azimuthConfidence,
    environmentState
  );
  applyAtmosphericPerspective(activeCharacter.root, distanceFromCam);
}

/** 確定済みのplacementに対してapplyPlacementCoreを呼ぶ、従来互換の薄いラッパー。 */
function applyPlacement() {
  applyPlacementCore(placement);
}


/* ============================================================
   配置レティクル(20260722平面推定指示書 Part5/6 + 07/27再設計)
   ------------------------------------------------------------
   【2026/07/27】カメラが常に固定姿勢になった(main.jsの方位センサー
   セクション参照)ことで、レイキャストによる床認識が機能しなくなった
   ため、「指でドラッグして薄い円を動かし、位置を決めたら確定ボタンを
   押す」方式に変更した。ドラッグの変換式は、既存の1本指ドラッグ
   (キャラクター移動)と同じ「画面上のピクセル移動量→現在の距離に
   応じたワールド座標移動量」を使う(センサーに一切依存しない、
   すでに実績のある安全な計算式)。

   縦ドラッグ = 奥行き(Z、前後)、横ドラッグ = 左右(X)、という
   「地図を見下ろすような」操作感にしている。

   2026/08: 位置の設定・再設定(reticle-btn経由)の間は、ポーズ/表情
   リング等の操作UIが画面下部に表示されたままだと配置操作の邪魔になる
   ため、初回設置時と同じ`placement-pending`クラスをuiLayerへ付与し、
   一時的に隠すようにした(showReticleAt/endPlacementMode参照)。
   ============================================================ */
const placementConfirmBtn = document.getElementById('placement-confirm-btn');
const placementCancelBtn  = document.getElementById('placement-cancel-btn');
const placementActions    = document.getElementById('placement-actions');
const placementDistanceVal = document.getElementById('placement-distance-val');

// ADR-017: ドラッグ確定前に「取り消して元の位置へ戻せる」よう、
// 再配置モードに入る直前のplacementを退避しておく(初回設置は
// そもそもキャンセル不可なのでnullのままでよい)。
let placementSnapshot = null;

/** カメラからの距離(m)をバッジへ反映する。 */
function updateDistanceBadge(zWorld) {
  const distanceM = Math.abs(zWorld - camera.position.z);
  placementDistanceVal.textContent = distanceM.toFixed(1);
}

/** レティクルを指定のワールドXZへ、現在の仮想床の高さで表示する。 */
function showReticleAt(x, z) {
  const y = groundEstimator.getGroundHeight();
  placementReticle.setWorldPosition(x, y, z);
  placementReticle.show();
  placementConfirmBtn.classList.add('show');
  placementActions.classList.add('show');
  updateDistanceBadge(z);
  // ADR-017: 確定前でも実際にキャラクターがそこに立った見た目を
  // その場で確認できるよう、レティクルと同時にキャラクターも
  // プレビュー移動させる(「置いてから確認」→「見ながら置く」)。
  previewPlacementAt(x, y, z);
}

/**
 * ドラッグ中のライブプレビュー。確定前のplacement本体は一切書き換えず
 * (キャンセル時に元へ戻せることを保証するため)、レンダリング用の
 * 一時オブジェクトをapplyPlacementCoreへ渡すだけに留める。
 *
 * 初回設置(pendingInitialPlacement)中は適用しない: loadCharacter内の
 * コメント通り「初回設置が確定するまでキャラクター自体は非表示にして
 * おく」のは意図的な演出(確定した瞬間に初めて姿を見せる)であり、
 * ここでのライブプレビューはその意図を壊してしまうため。
 * 既にキャラクターが見えている再配置時のみ、確定前から追従させる。
 */
function previewPlacementAt(x, y, z) {
  if (!activeCharacter || pendingInitialPlacement) return;
  activeCharacter.root.visible = true;
  applyPlacementCore({ ...placement, x, y, z });
}

/** 配置モード/初回設置モードを終える共通処理。 */
function endPlacementMode() {
  placementMode = false;
  pendingInitialPlacement = false;
  placementReticle.hide();
  placementConfirmBtn.classList.remove('show');
  placementCancelBtn.classList.remove('show');
  placementActions.classList.remove('show');
  reticleBtn.classList.remove('active');
  uiLayer.classList.remove('placement-pending');
  placementIntro.classList.remove('show');
  placementSnapshot = null;
}

/**
 * レティクルの現在位置でキャラクターの配置を確定する。
 * 初回設置(pendingInitialPlacement)・再配置(🎯ボタン経由)の
 * どちらからも呼ばれる共通処理。
 */
function confirmReticlePlacement() {
  const pose = placementReticle.getPlacementPose();
  placement.x = pose.position.x;
  placement.y = pose.position.y;
  placement.z = pose.position.z;
  // rotationYは「初期設定値をそのまま使う」設計(placement-reticle.js参照)。
  groundEstimator.setGroundHeight(pose.position.y);

  if (activeCharacter) activeCharacter.root.visible = true;
  applyPlacement();

  const wasInitial = pendingInitialPlacement;
  endPlacementMode();
  showPoseToast(wasInitial ? 'この場所に配置しました' : '位置を更新しました');
}

/**
 * ADR-017新規: 再配置を確定せずに元の位置へ戻して終える。
 * 初回設置中はボタン自体を表示しないため、ここに来るのは
 * 常に「既に配置済みのキャラクターを再配置しようとした」ケースのみ。
 */
function cancelReticlePlacement() {
  if (placementSnapshot) {
    Object.assign(placement, placementSnapshot);
    applyPlacement();
  }
  endPlacementMode();
  showPoseToast('位置の変更をキャンセルしました');
}

placementConfirmBtn.addEventListener('click', confirmReticlePlacement);
placementCancelBtn.addEventListener('click', cancelReticlePlacement);

reticleBtn.addEventListener('click', () => {
  if (!activeCharacter || pendingInitialPlacement || placementMode) return;
  placementMode = true;
  reticleBtn.classList.add('active');
  // 位置の設定/再設定中はポーズ/表情リング等を一時的に隠し、
  // 配置操作に集中できるようにする(2026/08追加)。
  uiLayer.classList.add('placement-pending');
  placementSnapshot = { x: placement.x, y: placement.y, z: placement.z };
  showReticleAt(placement.x, placement.z);
  // ADR-017: 常駐の案内パネル(placement-intro)を再配置でも出すことで、
  // 一度きりのトーストで消えていた操作説明を配置中ずっと見られるようにした。
  placementIntro.classList.add('show');
  placementCancelBtn.classList.add('show');
});

/**
 * 初回設置フロー: モデル読み込み完了直後に呼ばれる。実際のARカメラアプリ
 * (Pokémon GO/IKEA Place等)を参考に、「まず円で立つ位置を決めてから
 * メインUIが使えるようになる」導入フローにした。キャラクター・
 * メインUIは隠したまま、レティクルと案内バナー・確定ボタンだけを表示する。
 * (キャンセル不可: placementCancelBtnはshowされないため常に非表示のまま)
 */
function beginInitialPlacement() {
  pendingInitialPlacement = true;
  placementMode = true;
  showReticleAt(DEFAULT_PLACEMENT.x, DEFAULT_PLACEMENT.z);
  uiLayer.classList.add('placement-pending');
  placementIntro.classList.add('show');
}

/* ============================================================
   方位センサー(コンパス較正専用、カメラ回転には使わない)
   ------------------------------------------------------------
   【2026/07/26 設計変更の経緯】
   これまでDeviceOrientationEvent(alpha/beta/gamma)から求めた
   クォータニオンをcamera.quaternionへ毎フレーム反映し、「スマホの
   向きを変えてもキャラクターがその場に立っているように見える」
   3DoFジャイロAR(ADR-002)を実装していた。しかし実機で
   「スマホを傾けるとキャラクターが横に傾いて不自然」「レティクルの
   床認識が安定しない」という2つの問題が解消しなかった。

   ARKit(IKEA Place等)の実際の仕組みを調べ直したところ、これらの
   アプリは加速度センサー/ジャイロだけでなく、カメラ画像の特徴点を
   継続的に追跡する視覚慣性オドメトリ(VIO)によって「回転」だけでなく
   「並進移動(スマホの位置そのもの)」までリアルタイムに推定しており、
   それによって初めて「置いた物が本当にその場に固定されて見える」
   体験が成立している(参考: Appleの公式ARKitサンプル解説、
   ARKit Planes/Hit-Test系の各種技術記事)。本アプリはWeb(Safari)
   専用で、WebXR Device APIもSafariでは利用できず、ARKitのような
   視覚慣性オドメトリには技術的にアクセスできない(CONSTRAINTS.md/
   ADR-001の制約)。つまり「回転センサーの値だけ」からVIO相当の
   体験を再現しようとすること自体が、原理的に無理のある設計だった。

   そこで今回、方針を変更する:
   - camera.quaternionはジャイロで動かさず、常に固定(初期値)のままにする。
     これにより「スマホを傾けるとキャラクターが傾いて見える」問題は
     原理的に解消する(動かす入力自体が無くなるため)。
   - 配置レティクル(placement-reticle.js)のレイキャストは、
     「常に同じ向きの固定カメラ」に対する計算になるため、センサー
     ノイズの影響を受けず、フレームごとに結果が安定する
     (ADR-014が問題視していた「視線角度が変わるたびに交点が暴れる」
     現象は、視線そのものが変化しなくなったことで構造的に解消される)。
   - 「配置したら最初の位置から動かない」という要望にも、これで
     directに応える(スマホの向きが変わっても一切追従しない)。
   - DeviceOrientationEventの購読自体は残すが、用途を
     webkitCompassHeading(コンパス較正、影の方位補正用)の取得のみに
     縮小する。
   ============================================================ */

function onDeviceOrientation(e) {
  // コンパス較正(js/compass-calibration.js): iOS Safariのみ存在する
  // 非標準プロパティ。受信するたびに最新値を記録しておく。
  compassCalibration.recordHeading(e.webkitCompassHeading);
}
async function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const res = await DeviceOrientationEvent.requestPermission();
      return res === 'granted';
    } catch (e) { console.warn('orientation permission error', e); return false; }
  }
  return typeof DeviceOrientationEvent !== 'undefined';
}
function enableOrientationSensing() {
  window.addEventListener('deviceorientation', onDeviceOrientation);
}

/* ============================================================
   手ぶれ検知（写真のブレ対策）
   ------------------------------------------------------------
   devicemotionの角速度(rotationRate)の合計を「揺れの大きさ」の
   簡易指標として使い、一定時間おさまるまでシャッターを待つ。
   真のOIS/EISではないが、「止まってから撮る」ことでブレを減らす
   実用的な近似。
   ============================================================ */
let lastMotionMagnitude = 0;
function onDeviceMotion(e) {
  const rr = e.rotationRate || {};
  lastMotionMagnitude = Math.abs(rr.alpha || 0) + Math.abs(rr.beta || 0) + Math.abs(rr.gamma || 0);
}
async function requestMotionPermission() {
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const res = await DeviceMotionEvent.requestPermission();
      return res === 'granted';
    } catch (e) { console.warn('motion permission error', e); return false; }
  }
  return typeof DeviceMotionEvent !== 'undefined';
}
function enableMotionTracking() {
  window.addEventListener('devicemotion', onDeviceMotion);
}

const STEADY_THRESHOLD = 12;   // deg/s の合計。これ未満なら「静止」とみなす
const STEADY_HOLD_MS = 180;    // これだけ静止が続いたら撮影する
const STEADY_MAX_WAIT_MS = 1500; // これ以上は待たず、諦めて撮影する

function waitForSteady() {
  return new Promise((resolve) => {
    const start = performance.now();
    let steadySince = null;
    function poll() {
      const now = performance.now();
      if (lastMotionMagnitude < STEADY_THRESHOLD) {
        if (steadySince === null) steadySince = now;
        if (now - steadySince >= STEADY_HOLD_MS) { resolve(); return; }
      } else {
        steadySince = null;
      }
      if (now - start >= STEADY_MAX_WAIT_MS) { resolve(); return; }
      requestAnimationFrame(poll);
    }
    poll();
  });
}

/* ============================================================
   カメラ映像
   ------------------------------------------------------------
   2026/08(ADR-016): カメラ切替(前面/背面)機能を廃止したため、
   facingModeは持たず常に背面カメラ(environment)のみを要求する。
   ============================================================ */
async function startCamera() {
  stopCamera();
  try {
    const constraints = {
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    currentStream = stream;
    video.srcObject = stream;
    await video.play();
    video.addEventListener('loadedmetadata', onVideoMeta, { once: true });
    if (video.videoWidth) onVideoMeta();
  } catch (err) {
    console.error(err);
    startError.textContent = 'カメラを起動できませんでした。設定で許可を確認してください。';
    throw err;
  }
}
function stopCamera() {
  if (currentStream) { currentStream.getTracks().forEach((t) => t.stop()); currentStream = null; }
}
function onVideoMeta() {
  sizeStageToVideo(video.videoWidth || 1080, video.videoHeight || 1920);
}
function sizeStageToVideo(vw, vh) {
  const aspect = vw / vh;
  const wrapRect = stageWrap.getBoundingClientRect();
  let w = wrapRect.width, h = w / aspect;
  if (h > wrapRect.height) { h = wrapRect.height; w = h * aspect; }
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  renderer.setSize(vw, vh, false);
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', () => {
  if (video.videoWidth) sizeStageToVideo(video.videoWidth, video.videoHeight);
});
// 横向き対応：回転直後はvideoWidth/Heightやbounding rectの更新が
// 一瞬遅れる機種があるため、resizeに加えて少し遅らせて再計算する。
window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    if (video.videoWidth) sizeStageToVideo(video.videoWidth, video.videoHeight);
  }, 150);
});

/* ============================================================
   ジェスチャー操作
   ------------------------------------------------------------
   1本指ドラッグ: X/Y移動
   2本指ピンチ: 拡縮(scale)
   2本指ひねり: 回転(rotY)
   2本指の縦方向の動き: 奥行き(Z)移動

   2026/08: 「画面タップで位置が変わる」機能(1本指タップでの
   自動配置)は誤操作の原因になりやすいため廃止した。位置決めは
   常に🎯(reticle-btn)経由のレティクル操作のみで行う。
   ============================================================ */
// 2本指の縦ドラッグでどこまでZを動かせるか(m、カメラ前方向)。
const MIN_CHARACTER_DISTANCE_Z = -25;
const MAX_CHARACTER_DISTANCE_Z = -0.8;
// 縦ドラッグの感度係数。1.0が「指の動きと同じ量だけ実距離が動く」基準値で、
// 奥行きの変化は横移動より体感しにくいため気持ち強めにしている。
const DEPTH_DRAG_GAIN = 1.3;

// 2本指ジェスチャーが「拡縮/回転(planar)」なのか「奥行き移動(depth)」なのかを
// 判定してロックするまでの猶予(px)。
const GESTURE_LOCK_THRESHOLD_PX = 14;
const GESTURE_LOCK_ANGLE_RAD = THREE.MathUtils.degToRad(6);

const touchState = {
  mode: null, lastX: 0, lastY: 0,
  startDist: 0, startAngle: 0, startScale: 1, startRotY: 0,
  startMidY: 0, startZ: 0,
  hadMultiTouch: false,
  gestureLock: null, // null | 'planar' | 'depth'
  reticleDistAtStart: 0,
};
function touchDist(t0, t1) { return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY); }
function touchAngle(t0, t1) { return Math.atan2(t1.clientY - t0.clientY, t1.clientX - t0.clientX); }
function touchMidY(t0, t1) { return (t0.clientY + t1.clientY) / 2; }
function normalizeAngle(a) { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; }

stage.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (e.touches.length === 1) {
    touchState.mode = 'drag';
    touchState.lastX = e.touches[0].clientX; touchState.lastY = e.touches[0].clientY;
    touchState.hadMultiTouch = false;
    if (placementMode) {
      // レティクルのドラッグ変換係数は、ドラッグ開始時点の距離で固定する
      // (2本指の奥行きドラッグと同じ考え方)。ドラッグ中に毎回その場の
      // 距離から再計算すると、遠くへ動かすほど1px当たりの移動量が
      // 増え続けて暴走的に感じる不具合になっていた(実機フィードバック対応)。
      touchState.reticleDistAtStart = Math.abs(placementReticle.getWorldPosition().z - camera.position.z);
    }
  } else if (e.touches.length >= 2) {
    touchState.mode = 'gesture';
    touchState.hadMultiTouch = true;
    touchState.startDist = touchDist(e.touches[0], e.touches[1]);
    touchState.startAngle = touchAngle(e.touches[0], e.touches[1]);
    touchState.startScale = placement.scale;
    touchState.startRotY = placement.rotY;
    touchState.startMidY = touchMidY(e.touches[0], e.touches[1]);
    touchState.startZ = placement.z;
    touchState.gestureLock = null;
  }
}, { passive: false });

stage.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (touchState.mode === 'drag' && e.touches.length === 1) {
    const t = e.touches[0];
    const dx = t.clientX - touchState.lastX, dy = t.clientY - touchState.lastY;
    touchState.lastX = t.clientX; touchState.lastY = t.clientY;
    const rect = stage.getBoundingClientRect();
    const vFovRad = THREE.MathUtils.degToRad(camera.fov);

    if (placementMode) {
      // 配置レティクルのドラッグ移動: 縦方向=奥行き(前後)、横方向=左右。
      // センサーに一切依存しない、既存の1本指ドラッグと同じ変換式だが、
      // 距離はドラッグ開始時点で固定する(touchStart参照、遠方での暴走対策)。
      const cur = placementReticle.getWorldPosition();
      const worldPerPixel = (2 * Math.tan(vFovRad / 2) * touchState.reticleDistAtStart) / rect.height;
      const newX = cur.x + dx * worldPerPixel;
      const newZ = THREE.MathUtils.clamp(
        cur.z + dy * worldPerPixel,
        MIN_CHARACTER_DISTANCE_Z,
        MAX_CHARACTER_DISTANCE_Z
      );
      const groundY = groundEstimator.getGroundHeight();
      placementReticle.setWorldPosition(newX, groundY, newZ);
      // ADR-017: ドラッグ中も距離バッジとキャラクターのプレビューを
      // 毎フレーム追従させる(placement本体には触れない、previewPlacementAt参照)。
      updateDistanceBadge(newZ);
      previewPlacementAt(newX, groundY, newZ);
    } else {
      const distance = Math.abs(placement.z - camera.position.z);
      const worldPerPixelY = (2 * Math.tan(vFovRad / 2) * distance) / rect.height;
      placement.x += dx * worldPerPixelY;
      placement.y -= dy * worldPerPixelY;
      applyPlacement();
    }
  } else if (touchState.mode === 'gesture' && e.touches.length >= 2 && !placementMode) {
    const dist = touchDist(e.touches[0], e.touches[1]);
    const angle = touchAngle(e.touches[0], e.touches[1]);
    const midY = touchMidY(e.touches[0], e.touches[1]);

    const distDeltaPx = dist - touchState.startDist;
    const midYDeltaPx = midY - touchState.startMidY;
    const angleDeltaRad = normalizeAngle(angle - touchState.startAngle);

    if (!touchState.gestureLock) {
      if (Math.abs(midYDeltaPx) > GESTURE_LOCK_THRESHOLD_PX &&
          Math.abs(midYDeltaPx) > Math.abs(distDeltaPx) * 1.5) {
        touchState.gestureLock = 'depth';
      } else if (Math.abs(distDeltaPx) > GESTURE_LOCK_THRESHOLD_PX ||
                 Math.abs(angleDeltaRad) > GESTURE_LOCK_ANGLE_RAD) {
        touchState.gestureLock = 'planar';
      }
    }

    if (touchState.gestureLock !== 'depth') {
      const scaleRatio = dist / (touchState.startDist || dist);
      placement.scale = THREE.MathUtils.clamp(touchState.startScale * scaleRatio, 0.2, 5);
      placement.rotY = touchState.startRotY - angleDeltaRad;
    }

    if (touchState.gestureLock !== 'planar') {
      const rect = stage.getBoundingClientRect();
      const distFromCamAtStart = Math.abs(touchState.startZ - camera.position.z);
      const depthPerPixel = distFromCamAtStart / rect.height;
      placement.z = THREE.MathUtils.clamp(
        touchState.startZ + midYDeltaPx * depthPerPixel * DEPTH_DRAG_GAIN,
        MIN_CHARACTER_DISTANCE_Z,
        MAX_CHARACTER_DISTANCE_Z
      );
    }

    applyPlacement();
  }
}, { passive: false });

stage.addEventListener('touchend', (e) => {
  e.preventDefault();
  if (e.touches.length === 0) touchState.mode = null;
  else if (e.touches.length === 1) {
    touchState.mode = 'drag';
    touchState.lastX = e.touches[0].clientX; touchState.lastY = e.touches[0].clientY;
  }
}, { passive: false });

/* ============================================================
   セルフタイマー
   ============================================================ */
const TIMER_OPTIONS = [0, 3, 10];
let timerIndex = 0;
function updateTimerBtnLabel() {
  const v = TIMER_OPTIONS[timerIndex];
  const iconSpan = timerBtn.querySelector('span:first-child');
  if (iconSpan) iconSpan.textContent = v === 0 ? '⏱' : `⏱${v}`;
  timerBtn.classList.toggle('active', v > 0);
}
timerBtn.addEventListener('click', () => {
  timerIndex = (timerIndex + 1) % TIMER_OPTIONS.length;
  updateTimerBtnLabel();
});
updateTimerBtnLabel();

function runCountdown(seconds) {
  return new Promise((resolve) => {
    if (seconds <= 0) { resolve(); return; }
    countdownOverlay.classList.add('show');
    let remaining = seconds;
    countdownNum.textContent = String(remaining);
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) {
        countdownOverlay.classList.remove('show');
        resolve();
        return;
      }
      countdownNum.textContent = '';
      requestAnimationFrame(() => { countdownNum.textContent = String(remaining); });
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
  });
}

/* ============================================================
   撮影（写真／動画）
   ============================================================ */
let lastIsVideo = false;
let isVideoMode = false;

function capture() {
  effect.render(scene, camera);
  const vw = video.videoWidth, vh = video.videoHeight;
  const out = document.createElement('canvas');
  out.width = vw; out.height = vh;
  const ctx = out.getContext('2d');
  ctx.drawImage(video, 0, 0, vw, vh);
  ctx.drawImage(renderer.domElement, 0, 0, vw, vh);
  applyPhotoFinish(out, { envTint: environmentLighting.getEstimatedTintColor() });
  out.toBlob((blob) => {
    showResult(blob, false);
  }, 'image/png');
}

function showResult(blob, isVideo) {
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  currentBlobUrl = URL.createObjectURL(blob);
  lastBlob = blob;
  lastIsVideo = isVideo;
  resultImgWrap.classList.toggle('video-mode', isVideo);
  if (isVideo) {
    resultVideo.src = currentBlobUrl;
    resultVideo.play().catch(() => {});
  } else {
    resultImg.src = currentBlobUrl;
  }
  resultHint.textContent = isVideo
    ? '動画を長押しして保存するか、下のボタンで共有してください'
    : '画像を長押しして「写真に保存」してください';
  resultScreen.classList.add('show');
}

function flashEffect() {
  flashOverlay.classList.remove('flash-out');
  flashOverlay.classList.add('flash');
  requestAnimationFrame(() => {
    flashOverlay.classList.remove('flash');
    flashOverlay.classList.add('flash-out');
  });
}

/* ---- 動画撮影：video要素とthree.jsの描画を1枚のcanvasへ毎フレーム合成し、
   そのcanvasのcaptureStream()をMediaRecorderで録画する ---- */
const recordCanvas = document.createElement('canvas');
const recordCtx = recordCanvas.getContext('2d');
let mediaRecorder = null;
let recordedChunks = [];
let recordLoopId = null;
let isRecording = false;
let recordStartTime = 0;
let recordTimerInterval = null;

function pickSupportedMime() {
  const candidates = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  if (typeof MediaRecorder === 'undefined') return '';
  return candidates.find((c) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) || '';
}

function recordFrameLoop() {
  if (!isRecording) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (vw && (recordCanvas.width !== vw || recordCanvas.height !== vh)) {
    recordCanvas.width = vw; recordCanvas.height = vh;
  }
  if (vw) {
    recordCtx.drawImage(video, 0, 0, vw, vh);
    recordCtx.drawImage(renderer.domElement, 0, 0, vw, vh);
  }
  recordLoopId = requestAnimationFrame(recordFrameLoop);
}

function startVideoRecording() {
  if (typeof MediaRecorder === 'undefined' || !recordCanvas.captureStream) {
    resultHint.textContent = 'この端末/ブラウザは動画撮影に対応していません';
    return;
  }
  const mime = pickSupportedMime();
  const stream = recordCanvas.captureStream(30);
  recordedChunks = [];
  try {
    mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (e) {
    console.error('MediaRecorder init failed', e);
    resultHint.textContent = '動画撮影を開始できませんでした';
    return;
  }
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: mime || 'video/mp4' });
    showResult(blob, true);
  };
  isRecording = true;
  mediaRecorder.start();
  recordFrameLoop();

  recordStartTime = performance.now();
  shutterBtn.classList.add('recording');
  shutterStatus.classList.add('show');
  recordTimerInterval = setInterval(() => {
    const sec = Math.floor((performance.now() - recordStartTime) / 1000);
    shutterStatus.textContent = `● 録画中 ${sec}秒`;
  }, 250);
}

function stopVideoRecording() {
  isRecording = false;
  if (recordLoopId) cancelAnimationFrame(recordLoopId);
  if (recordTimerInterval) { clearInterval(recordTimerInterval); recordTimerInterval = null; }
  shutterBtn.classList.remove('recording');
  shutterStatus.classList.remove('show');
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

function updateModeBtnLabel() {
  const iconSpan = modeBtn.querySelector('.mode-chip-fan');
  const labelSpan = modeBtn.querySelector('.fan-label');
  // ADR-017: 絵文字のtextContent直書きから、icons.jsのSVG差し込みへ変更。
  if (iconSpan) iconSpan.innerHTML = ICONS[isVideoMode ? 'video' : 'camera'];
  if (labelSpan) labelSpan.textContent = isVideoMode ? '動画' : '写真';
  modeBtn.classList.toggle('active', isVideoMode);
}
modeBtn.addEventListener('click', () => {
  if (isRecording) return; // 録画中はモード切替させない
  isVideoMode = !isVideoMode;
  updateModeBtnLabel();
});
updateModeBtnLabel();

let isCapturing = false;
async function onShutterPress() {
  if (isVideoMode) {
    if (isRecording) {
      if (navigator.vibrate) navigator.vibrate(20);
      stopVideoRecording();
    } else {
      await runCountdown(TIMER_OPTIONS[timerIndex]);
      if (navigator.vibrate) navigator.vibrate([15, 60, 15]);
      startVideoRecording();
    }
    return;
  }

  if (isCapturing) return;
  isCapturing = true;
  shutterBtn.disabled = true;
  try {
    await runCountdown(TIMER_OPTIONS[timerIndex]);

    shutterBtn.classList.add('waiting');
    shutterStatus.textContent = '手ぶれを確認中…';
    shutterStatus.classList.add('show');
    await waitForSteady();
    shutterBtn.classList.remove('waiting');
    shutterStatus.classList.remove('show');

    if (navigator.vibrate) navigator.vibrate(15);
    flashEffect();
    capture();
  } finally {
    isCapturing = false;
    shutterBtn.disabled = false;
  }
}
shutterBtn.addEventListener('click', onShutterPress);
retakeBtn.addEventListener('click', () => resultScreen.classList.remove('show'));

shareBtn.addEventListener('click', async () => {
  if (!lastBlob) return;
  const ext = lastIsVideo ? (lastBlob.type.includes('mp4') ? 'mp4' : 'webm') : 'png';
  const file = new File([lastBlob], `alongscene.${ext}`, { type: lastBlob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (err) { if (err && err.name === 'AbortError') return; console.error(err); }
  }
  resultHint.textContent = lastIsVideo
    ? 'この環境では共有シートが使えません。動画を長押しして保存してください'
    : 'この環境では共有シートが使えません。画像を長押しして「写真に保存」してください';
});

/* ============================================================
   推しの選び直し(旧: 位置/向きのリセット)
   ------------------------------------------------------------
   2026/08変更: リセットボタン(#reset-btn、旧⟲「リセット」)の挙動を
   「配置を初期値に戻す」から「キャラクター選択画面に戻る」へ変更した。
   現在のキャラクターを解放(disposeCharacter)し、配置・カメラ位置・
   影の手動オーバーライド等をすべて初期状態に戻したうえで、
   キャラクターが複数登録されている場合は選択カルーセルを再表示する
   (1体しか登録されていない場合は選択画面を出す意味が無いため、
   同じキャラクターをそのまま再読み込みする)。

   選択画面のカードは既にappStarted判定込みで「タップ即読み込み」に
   対応させてあるため(initCharacterSelect参照)、ここでは画面を
   表示するだけでよい。
   ============================================================ */
function returnToCharacterSelect() {
  if (activeCharacter) {
    disposeCharacter(activeCharacter, scene);
    activeCharacter = null;
  }
  endPlacementMode();
  resultScreen.classList.remove('show');
  Object.assign(placement, DEFAULT_PLACEMENT);
  groundEstimator.setGroundHeight(DEFAULT_PLACEMENT.y);
  camera.position.set(0, 0, 0);
  shadowControls && shadowControls.close();

  if (CHARACTERS.length <= 1) {
    loadingOverlay.classList.remove('hide');
    loadingText.textContent = '推しを読み込み中…';
    loadCharacter(CHARACTERS[0]);
    return;
  }
  selectScreen.style.display = 'flex';
}
resetBtn.addEventListener('click', returnToCharacterSelect);

/* ============================================================
   待機モーション(20260721ポージング指示書 + 補足指示)
   ------------------------------------------------------------
   ユーザー操作が30秒以上ない場合、既存のwaveポーズ+wink表情、
   または上半身の左右揺れ(setGlobalOffset('bodyYaw', 最大9度))を
   自動再生する機能として実装した。

   【2026/07/26時点、既定でOFFにした】
   「配置後にモデルが傾く/動く」という今回の報告のうち、特に
   「横に傾く」という症状は、この待機モーションのうち上半身を
   最大9度左右に揺らす「sway」の可能性がある(30秒操作しないと
   自動発動する仕様のため、気づかないうちに再生されていた可能性がある)。
   ジャイロ由来の傾き(方位センサーセクション参照)と切り分けるため、
   一旦この機能自体を無効化しておく。「配置したら動かない」という
   要望に対しても、まずはこちらをOFFにするのが安全と判断した。
   気に入っている場合や、原因が待機モーションではなかったと分かった
   場合は、IDLE_MOTION_ENABLEDをtrueに戻せばそのまま復活する
   (js/idle-motion.js自体は変更していない)。
   ============================================================ */
const IDLE_MOTION_ENABLED = false;
if (IDLE_MOTION_ENABLED) {
  const idleMotion = createIdleMotionManager({
    getCharacter: () => activeCharacter,
    isBusy: () => isCapturing || isRecording,
  });
  idleMotion.attachAutoListeners(stage);
  idleMotion.attachAutoListeners(document.getElementById('ui-layer'));
}

/* ============================================================
   レンダーループ
   ============================================================ */
let lastTime = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  // 2026/07/26: camera.quaternionはジャイロで動かさず、常に固定のまま
  // にする方針へ変更した(詳細は「方位センサー」セクションのコメント参照)。
  // そのためここには何も書かない(意図的に空、将来また混乱しないように明記)。
  if (activeCharacter) activeCharacter.update(dt);
  if (placementReticle.isVisible()) {
    placementReticle.updatePulse(dt);
  }
  effect.render(scene, camera);
}
animate();

/* ============================================================
   起動フロー
   ============================================================ */
function initCharacterSelect() {
  if (CHARACTERS.length <= 1) {
    selectScreen.style.display = 'none';
    currentCharacterIndex = 0;
    return;
  }
  selectScreen.style.display = 'flex';
  characterList.innerHTML = '';
  if (selectDots) selectDots.innerHTML = '';

  CHARACTERS.forEach((def, i) => {
    const slide = document.createElement('div');
    slide.className = 'char-slide' + (i === 0 ? ' in-view' : '');
    slide.style.setProperty('--theme', def.themeColor || 'var(--gold)');
    slide.innerHTML = `
      <div class="badge-orbit">
        <div class="badge-ring"></div>
        <div class="badge-core"><span class="badge-emoji">${def.thumb || '⭐'}</span></div>
      </div>
      <h2 class="char-name">${def.name}</h2>
      <p class="char-tagline">${def.tagline || '一緒に、素敵な瞬間を。'}</p>
      <button type="button" class="char-pick-btn">この娘とはじめる</button>
    `;
    slide.querySelector('.char-pick-btn').addEventListener('click', () => {
      currentCharacterIndex = i;
      selectScreen.style.display = 'none';
      // 2026/08追加: スタート画面(許可フロー)を既に完走済みなら
      // (=推しの選び直しでこの画面に戻ってきた場合)、そのまま直接
      // 選んだキャラクターを読み込む。初回起動時はstart-btnの
      // ハンドラ側でloadCharacterが呼ばれるため、ここでは何もしない。
      if (appStarted) {
        loadingOverlay.classList.remove('hide');
        loadingText.textContent = '推しを読み込み中…';
        loadCharacter(def);
      }
    });
    characterList.appendChild(slide);

    if (selectDots) {
      const dot = document.createElement('span');
      if (i === 0) dot.classList.add('active');
      selectDots.appendChild(dot);
    }
  });

  // カルーセルのスクロール位置から「今どのカードが中央にあるか」を判定し、
  // 見出しの背景色(--theme)・ドット・カード自身の強調表示を追従させる。
  // ネイティブのscroll-snapに任せているため、ジェスチャー処理は一切書かない。
  let scrollRaf = null;
  characterList.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      const idx = Math.round(characterList.scrollLeft / characterList.clientWidth);
      const slides = characterList.querySelectorAll('.char-slide');
      slides.forEach((s, i) => s.classList.toggle('in-view', i === idx));
      if (selectDots) {
        Array.from(selectDots.children).forEach((d, i) => d.classList.toggle('active', i === idx));
      }
      const activeDef = CHARACTERS[idx];
      if (activeDef) selectScreen.style.setProperty('--theme', activeDef.themeColor || '#e7b94c');
    });
  }, { passive: true });
}
initCharacterSelect();

startBtn.addEventListener('click', async () => {
  startError.textContent = '';
  // 2026/08追記(ADR-015案): GPS許可ダイアログが表示されない不具合の
  // 調査により、この後に続くオリエンテーション/モーション許可ダイアログ
  // (各々ネイティブUIを介してユーザー操作を消費する)を経由した後だと、
  // iOS Safariの「ユーザー操作起因」の判定が失われ、Geolocationの
  // 許可ダイアログ自体が出ないケースがあることが分かった。
  // diagnostics.start()(内部でEnvironmentAnalyzerのGPS要求を行う)を、
  // 他の許可ダイアログより前、クリックハンドラの最初の行で呼ぶことで
  // 改善を試みる。
  // 【既知の限界・実機確認が必須】ホーム画面に追加したスタンドアロン
  // PWAとして起動している場合、これとは別のAppleプラットフォーム側の
  // 既知の制限(権限プロンプト自体が出ない)がある可能性があり、その
  // ケースはこの並び替えだけでは解決しない(アプリ側での回避策なし)。
  // 通常のSafariタブでの起動か、ホーム画面インストール済みかで
  // 結果が変わりうるため、両方のケースでの実機確認をお願いしたい。
  diagnostics.start();
  try {
    const orientationOK = await requestOrientationPermission();
    if (orientationOK) enableOrientationSensing();
    const motionOK = await requestMotionPermission();
    if (motionOK) enableMotionTracking();
    await startCamera();
    startScreen.style.display = 'none';
    loadCharacter(CHARACTERS[currentCharacterIndex]);
    environmentLighting.start();
    // このフラグが立った以降、resetBtn(推しを選び直す)経由での
    // 再選択はstart-screen(許可フロー)を経由せず直接読み込む。
    appStarted = true;
  } catch (err) {
    // エラーメッセージは startCamera 内で表示済み
  }
});
