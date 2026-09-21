import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CHARACTERS } from './js/characters-data.js';
import { loadCharacter as loadCharacterCore, disposeCharacter } from './js/character.js';
import { buildExpressionBar, buildPoseBar, createPoseTuner } from './js/pose-ui.js';
import { DevEnvironment, buildEnvironmentControls, buildColorGradePanel } from './js/dev-environment.js';
import { buildCalibrationPanel } from './js/calibration-tool.js';
import { createPosePresetStore } from './js/dev-pose-presets.js';
import { injectIcons } from './js/icons.js';

injectIcons();

/* ============================================================
   DOM
   ============================================================ */
const bgCanvas = document.getElementById('bg-canvas');
const charCanvas = document.getElementById('char-canvas');
const viewport = document.getElementById('dev-viewport');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const poseBar = document.getElementById('pose-bar');
const expressionBar = document.getElementById('expression-bar');
const posePanelHint = document.getElementById('pose-panel-hint');
const tuneBoneSelect = document.getElementById('tune-bone-select');
const tuneBoneSearch = document.getElementById('tune-bone-search');
const tuneBoneResetBtn = document.getElementById('tune-bone-reset-btn');
const tuneX = document.getElementById('tune-x');
const tuneY = document.getElementById('tune-y');
const tuneZ = document.getElementById('tune-z');
const tuneXVal = document.getElementById('tune-x-val');
const tuneYVal = document.getElementById('tune-y-val');
const tuneZVal = document.getElementById('tune-z-val');
const tuneResetBtn = document.getElementById('tune-reset-btn');
const tuneCopyBtn = document.getElementById('tune-copy-btn');
const tunePresetSelect = document.getElementById('tune-preset-select');
const tunePresetApplyBtn = document.getElementById('tune-preset-apply-btn');
const tunePresetSaveBtn = document.getElementById('tune-preset-save-btn');
const tunePresetDeleteBtn = document.getElementById('tune-preset-delete-btn');
const resetViewBtn = document.getElementById('dev-reset-view-btn');
const gridBtn = document.getElementById('dev-grid-btn');
const bgInput = document.getElementById('dev-bg-input');
const bgClearBtn = document.getElementById('dev-bg-clear-btn');
const bgImageDiv = document.getElementById('dev-bg-image');
const screenshotBtn = document.getElementById('dev-screenshot-btn');
const poseToast = document.getElementById('pose-toast');
const characterSwitchBar = document.getElementById('dev-character-switch');
const scenePanel = document.getElementById('dev-scene-panel');
const scenePanelToggle = document.getElementById('dev-scene-panel-toggle');
const tabButtons = document.querySelectorAll('.dsp-tab');
const tabEnv = document.getElementById('dsp-tab-env');
const tabGrade = document.getElementById('dsp-tab-grade');
// 新規: 距離較正ツール用タブ(dev.html側に#dsp-tab-calibと対応するタブボタンの
// 追加が必要。index.html側の変更点は別途パッチとして案内する)
const tabCalib = document.getElementById('dsp-tab-calib');

function hideLoadingOverlay() {
  loadingOverlay.classList.add('hide');
  loadingOverlay.style.pointerEvents = 'none';
}

let poseToastTimer = null;
function showPoseToast(text) {
  poseToast.textContent = text;
  poseToast.classList.add('show');
  clearTimeout(poseToastTimer);
  poseToastTimer = setTimeout(() => poseToast.classList.remove('show'), 1200);
}

/* ============================================================
   エラーログ（コンソールのみ。画面表示はしない）
   ============================================================ */
window.addEventListener('error', (e) => {
  console.error(`[error] ${e.message} (${e.filename}:${e.lineno})`);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error(`[unhandledrejection] ${e.reason}`);
});

/* ============================================================
   タブ切替（環境／色調／検証）
   ============================================================ */
tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    tabEnv.classList.toggle('active', btn.dataset.tab === 'env');
    tabGrade.classList.toggle('active', btn.dataset.tab === 'grade');
    if (tabCalib) tabCalib.classList.toggle('active', btn.dataset.tab === 'calib');
  });
});
scenePanelToggle.addEventListener('click', () => {
  scenePanel.classList.toggle('collapsed');
});

/* ============================================================
   three.js セットアップ
   ------------------------------------------------------------
   背景(bgRenderer/backgroundScene)とキャラクター(charRenderer/
   characterScene)を完全に分離した2レンダラー構成にしている。
   理由: 色調グレーディングをキャラクターにだけ適用したいという
   要望に対し、MMDトゥーンシェーダー自体を改造するのはコスト/リスクが
   大きい(ADR-006参照、シェーダー変更は必ずソース検証が必要)。
   代わりに「キャラクターだけを透明背景で別キャンバスに描画し、
   そのキャンバスにだけCSSフィルタをかける」方式にすることで、
   シェーダーに一切触れずに安全にモデル単独の色調調整を実現している。
   ============================================================ */
const bgRenderer = new THREE.WebGLRenderer({ canvas: bgCanvas, antialias: true });
bgRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
bgRenderer.outputColorSpace = THREE.SRGBColorSpace;
bgRenderer.toneMapping = THREE.ACESFilmicToneMapping;

const charRenderer = new THREE.WebGLRenderer({ canvas: charCanvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
charRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
charRenderer.outputColorSpace = THREE.SRGBColorSpace;
charRenderer.toneMapping = THREE.ACESFilmicToneMapping;
charRenderer.setClearColor(0x000000, 0); // 透明背景(下のbg-canvasを透かす)

const effect = new OutlineEffect(charRenderer, { defaultThickness: 0.0015, defaultColor: [0.05, 0.04, 0.05], defaultAlpha: 0.6 });

const backgroundScene = new THREE.Scene();
const characterScene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100); // 両レンダラーで共有する単一カメラ

const DEFAULT_CAM_POS = new THREE.Vector3(1.6, 1.3, 2.6);
const DEFAULT_TARGET = new THREE.Vector3(0, 0.9, 0);
camera.position.copy(DEFAULT_CAM_POS);

// OrbitControlsは最前面のchar-canvasにぶら下げる(マウス操作を実際に受け取るのはここ)
const controls = new OrbitControls(camera, charRenderer.domElement);
controls.target.copy(DEFAULT_TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.update();

/* ------------------------------------------------------------
   ドラッグ操作が奪われないようにするための保険（ADR-003と同じ理由）
   ------------------------------------------------------------ */
charCanvas.style.touchAction = 'none';
charCanvas.style.userSelect = 'none';
charCanvas.style.pointerEvents = 'auto';
bgCanvas.style.pointerEvents = 'none'; // 常に下敷き、操作はchar-canvasが受ける

function setInert(el, inert) {
  if (!el) return;
  el.style.pointerEvents = inert ? 'none' : '';
}
setInert(bgImageDiv, true);
setInert(poseToast, true);

/* ------------------------------------------------------------
   ライト構成（すべてcharacterScene側。backgroundScene側は光源を
   使わず、DevEnvironmentが地面/空の色を直接計算して設定する）
   ------------------------------------------------------------ */
const hemi = new THREE.HemisphereLight(0xffffff, 0x2a2a33, 0.4);
characterScene.add(hemi);
const dir = new THREE.DirectionalLight(0xfff2d8, 0.9);
characterScene.add(dir);
const rim = new THREE.DirectionalLight(0xcfe8ff, 0.35);
rim.position.set(-1.5, 1.8, -2.0);
characterScene.add(rim);

const grid = new THREE.GridHelper(6, 24, 0x556, 0x334);
grid.position.y = 0;
backgroundScene.add(grid);
let gridVisible = true;
gridBtn.addEventListener('click', () => {
  gridVisible = !gridVisible;
  grid.visible = gridVisible;
  gridBtn.textContent = `床グリッド: ${gridVisible ? 'ON' : 'OFF'}`;
});

/* ============================================================
   環境シミュレーション（場所・季節・時刻）＋ 色調グレーディング(モデル専用)
   ============================================================ */
const devEnvironment = new DevEnvironment({ backgroundScene, sunLight: dir, hemiLight: hemi });
buildEnvironmentControls(tabEnv, devEnvironment);
buildColorGradePanel(tabGrade, charCanvas); // charCanvasにのみフィルタが掛かる

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  bgRenderer.setSize(w, h, false);
  charRenderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

resetViewBtn.addEventListener('click', () => {
  camera.position.copy(DEFAULT_CAM_POS);
  controls.target.copy(DEFAULT_TARGET);
  controls.update();
});

/* ============================================================
   背景参照画像（任意・従来機能をそのまま維持）
   ============================================================ */
bgInput.addEventListener('change', () => {
  const file = bgInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    bgImageDiv.style.backgroundImage = `url('${reader.result}')`;
    bgImageDiv.classList.add('show');
  };
  reader.readAsDataURL(file);
});
bgClearBtn.addEventListener('click', () => {
  bgImageDiv.style.backgroundImage = '';
  bgImageDiv.classList.remove('show');
});

/* ============================================================
   スクリーンショット保存
   ------------------------------------------------------------
   背景canvas→キャラクターcanvas(色調フィルタ込み)の順に2D合成する。
   CanvasRenderingContext2D.filter はCSSと同じ構文をそのまま使えるため、
   char-canvas.style.filter の値を合成時にも適用して見た目を一致させる。
   ============================================================ */
screenshotBtn.addEventListener('click', () => {
  bgRenderer.render(backgroundScene, camera);
  effect.render(characterScene, camera);

  const composite = document.createElement('canvas');
  composite.width = charCanvas.width;
  composite.height = charCanvas.height;
  const ctx = composite.getContext('2d');
  ctx.drawImage(bgCanvas, 0, 0, composite.width, composite.height);
  ctx.filter = charCanvas.style.filter || 'none';
  ctx.drawImage(charCanvas, 0, 0, composite.width, composite.height);
  ctx.filter = 'none';

  composite.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `alongscene-dev-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, 'image/png');
});

/* ============================================================
   距離較正ツール（新規）
   ------------------------------------------------------------
   dev.jsは元々main.jsのようなplacement/applyPlacementの仕組みを
   持たず、キャラクターは常時{x:0,y:0,z:0,rotY:0,scale:1}の固定
   transformで表示していた。calibration-tool.jsはplacement.zを
   一時的に動かして測定するため、このツール専用の最小限のplacement
   オブジェクトをここに新設する(ポーズ/表情等、他の挙動には一切影響しない)。
   ============================================================ */
const calibPlacement = { x: 0, y: 0, z: 0, rotY: 0, scale: 1 };
function applyCalibPlacement() {
  if (activeCharacter) activeCharacter.setTransform(calibPlacement);
}
if (tabCalib) {
  buildCalibrationPanel(tabCalib, {
    camera,
    renderer: charRenderer,
    getCharacter: () => activeCharacter,
    placement: calibPlacement,
    applyPlacement: applyCalibPlacement,
  });
} else {
  console.warn('[dev.js] #dsp-tab-calib が見つかりません。dev.htmlに検証タブの追加が必要です。');
}

/* ============================================================
   キャラクター読み込み・切替（チップボタン式）
   ------------------------------------------------------------
   以前はCHARACTERS[0](かなた)を固定で読み込むだけで、dev.htmlには
   「別のキャラクターを選ぶ手段」自体が存在しなかった(音乃瀬奏が
   表示されない不具合の実体はこれだった)。
   ============================================================ */
let activeCharacter = null;
let activeCharacterId = null;
let loadGeneration = 0;

// ADR-017: ポーズ調整の自動保存・名前付きプリセット(dev.js専用、localStorage)。
const presetStore = createPosePresetStore();

/** 現在のキャラクター×ポーズの差分を自動保存する(スライダー操作のたびに軽量に呼ぶ)。 */
function autosaveCurrentPose() {
  if (!activeCharacter || !activeCharacterId) return;
  const diff = poseTuner.buildDiffObject();
  presetStore.saveAutosave(activeCharacterId, activeCharacter.activePoseKey, diff);
}

/** 現在のキャラクター×ポーズに自動保存があれば復元する(キャラ読み込み直後・ポーズ切替直後に呼ぶ)。 */
function applyAutosaveIfAny() {
  if (!activeCharacter || !activeCharacterId) return;
  const saved = presetStore.loadAutosave(activeCharacterId, activeCharacter.activePoseKey);
  if (!saved) return;
  Object.entries(saved).forEach(([name, xyz]) => activeCharacter.setBoneDelta(name, xyz));
}

/** プリセットのselect optionを、現在のキャラクターのものに差し替える。 */
function refreshPresetSelect() {
  tunePresetSelect.innerHTML = '<option value="">(プリセットなし)</option>';
  if (!activeCharacterId) return;
  presetStore.listPresetNames(activeCharacterId).forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    tunePresetSelect.appendChild(opt);
  });
}

const LOAD_TIMEOUT_MS = 15000;
let loadTimeoutId = null;

function loadAndActivateCharacter(def) {
  const myGeneration = ++loadGeneration;
  activeCharacterId = def.id;
  updateCharacterChips();

  loadingOverlay.classList.remove('hide');
  loadingOverlay.style.pointerEvents = '';
  loadingText.textContent = '推しを読み込み中…';

  clearTimeout(loadTimeoutId);
  loadTimeoutId = setTimeout(() => {
    if (myGeneration === loadGeneration && !loadingOverlay.classList.contains('hide')) {
      console.warn('モデル読み込みが15秒以内に完了しませんでした。読み込み画面を強制的に閉じます。');
      hideLoadingOverlay();
    }
  }, LOAD_TIMEOUT_MS);

  loadCharacterCore(def, { MMDLoader, scene: characterScene }, {
    onLoad: (character) => {
      if (myGeneration !== loadGeneration) {
        disposeCharacter(character, characterScene);
        return;
      }
      clearTimeout(loadTimeoutId);
      if (activeCharacter) disposeCharacter(activeCharacter, characterScene);
      activeCharacter = character;
      // 較正ツールが動かしたplacementを引き継いで初期表示する
      // (通常時はcalibPlacementは原点のままなので見た目は従来通り)
      character.setTransform(calibPlacement);
      // ADR-017: 前回このキャラクター×ポーズで調整した内容があれば復元する。
      applyAutosaveIfAny();
      refreshPresetSelect();
      buildExpressionBar(expressionBar, def, () => activeCharacter, (label) => showPoseToast(`表情: ${label}`));
      buildPoseBar(poseBar, def, () => activeCharacter, (label) => {
        // ADR-017: ポーズを切り替えた直後、そのポーズ用の自動保存があれば復元してから表示する。
        applyAutosaveIfAny();
        poseTuner.refresh();
        showPoseToast(`ポーズ: ${label}`);
      });
      poseTuner.refresh();
      hideLoadingOverlay();
    },
    onProgress: (xhr) => {
      if (myGeneration !== loadGeneration) return;
      if (xhr.lengthComputable) {
        const pct = Math.round((xhr.loaded / xhr.total) * 100);
        loadingText.textContent = `推しを読み込み中… ${pct}%`;
      }
    },
    onError: (err) => {
      if (myGeneration !== loadGeneration) return;
      clearTimeout(loadTimeoutId);
      console.error('MMD load error', err);
      loadingText.textContent = 'モデルの読み込みに失敗しました。ローカルサーバー経由で開いているか確認してください。';
      hideLoadingOverlay();
    },
  });
}

function updateCharacterChips() {
  characterSwitchBar.querySelectorAll('.char-chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.id === activeCharacterId);
  });
}

CHARACTERS.forEach((c) => {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'char-chip';
  chip.dataset.id = c.id;
  chip.innerHTML = `<span class="chip-thumb">${c.thumb || '★'}</span><span>${c.name}</span>`;
  chip.addEventListener('click', () => {
    if (c.id === activeCharacterId) return;
    loadAndActivateCharacter(c);
  });
  characterSwitchBar.appendChild(chip);
});

loadAndActivateCharacter(CHARACTERS[0]);

const poseTuner = createPoseTuner({
  select: tuneBoneSelect,
  xSlider: tuneX, ySlider: tuneY, zSlider: tuneZ,
  xVal: tuneXVal, yVal: tuneYVal, zVal: tuneZVal,
  hint: posePanelHint,
  search: tuneBoneSearch,
  boneResetBtn: tuneBoneResetBtn,
}, () => activeCharacter);

tuneResetBtn.addEventListener('click', () => { poseTuner.resetToDefault(); autosaveCurrentPose(); });
tuneCopyBtn.addEventListener('click', () => poseTuner.copyJSON());
// ADR-017: スライダー操作・ボーン単体リセットのたびに自動保存する
// (pose-ui.js側の内部リスナーとは別に、dev.js側からも同じイベントへ
// 追加でリスナーを張るだけなので、既存挙動には影響しない)。
[tuneX, tuneY, tuneZ].forEach((slider) => slider.addEventListener('input', autosaveCurrentPose));
tuneBoneResetBtn.addEventListener('click', autosaveCurrentPose);

tunePresetSaveBtn.addEventListener('click', () => {
  if (!activeCharacter || !activeCharacterId) return;
  const diff = poseTuner.buildDiffObject();
  if (Object.keys(diff).length === 0) {
    showPoseToast('初期値から変更したボーンがありません');
    return;
  }
  const name = window.prompt('プリセット名を入力してください:', '');
  if (!name) return;
  presetStore.savePreset(activeCharacterId, name, activeCharacter.activePoseKey, diff);
  refreshPresetSelect();
  tunePresetSelect.value = name;
  showPoseToast(`プリセット「${name}」を保存しました`);
});
tunePresetApplyBtn.addEventListener('click', () => {
  const name = tunePresetSelect.value;
  if (!name || !activeCharacter || !activeCharacterId) return;
  const preset = presetStore.getPreset(activeCharacterId, name);
  if (!preset) return;
  // プリセットは保存時のポーズ名も持っているので、違うポーズ用のものを
  // 誤って適用しないよう、まず該当ポーズへ切り替える。pose-bar側の
  // ボタン表示(active状態)も揃えるため、character.setPose()を直接
  // 呼ぶのではなく、対応するボタン(data-pose-key)を探してクリックさせる。
  if (activeCharacter.activePoseKey !== preset.poseKey) {
    const poseBtn = poseBar.querySelector(`.pose-btn[data-pose-key="${preset.poseKey}"]`);
    if (poseBtn) poseBtn.click(); else activeCharacter.setPose(preset.poseKey);
  }
  Object.entries(preset.bones).forEach(([boneName, xyz]) => activeCharacter.setBoneDelta(boneName, xyz));
  poseTuner.refresh();
  autosaveCurrentPose();
  showPoseToast(`プリセット「${name}」を適用しました`);
});
tunePresetDeleteBtn.addEventListener('click', () => {
  const name = tunePresetSelect.value;
  if (!name || !activeCharacterId) return;
  if (!window.confirm(`プリセット「${name}」を削除しますか？`)) return;
  presetStore.deletePreset(activeCharacterId, name);
  refreshPresetSelect();
  showPoseToast(`プリセット「${name}」を削除しました`);
});

/* ============================================================
   キーボードショートカット(ADR-017新規、PC専用なのでdev.js限定)
   ------------------------------------------------------------
   R: 視点リセット / G: グリッド切替 / 矢印キー: 選択中ボーンの微調整
   (←→=X、↑↓=Y、Shift+↑↓=Z、1回の押下で1度)。
   テキスト入力中(検索欄など)は奪わないよう、フォーカスが
   input/select/textareaの時は無効化する。
   ============================================================ */
const NUDGE_STEP_DEG = 1;
function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
}
function nudgeSelectedBone(axis, deltaDeg) {
  const slider = axis === 'x' ? tuneX : axis === 'y' ? tuneY : tuneZ;
  if (slider.disabled) return;
  const next = THREE.MathUtils.clamp(Number(slider.value) + deltaDeg, Number(slider.min), Number(slider.max));
  slider.value = String(next);
  slider.dispatchEvent(new Event('input', { bubbles: true }));
}
window.addEventListener('keydown', (e) => {
  // 検索欄・ボーン選択(select)にフォーカスがある間は、矢印キーの
  // ネイティブな挙動(カーソル移動・選択肢の切り替え)を優先し、
  // ショートカットは一切発火させない。
  if (isTypingTarget(document.activeElement)) return;
  switch (e.key) {
    case 'r': case 'R':
      resetViewBtn.click();
      break;
    case 'g': case 'G':
      gridBtn.click();
      break;
    case 'ArrowLeft':
      e.preventDefault(); nudgeSelectedBone('x', -NUDGE_STEP_DEG); break;
    case 'ArrowRight':
      e.preventDefault(); nudgeSelectedBone('x', NUDGE_STEP_DEG); break;
    case 'ArrowUp':
      e.preventDefault(); nudgeSelectedBone(e.shiftKey ? 'z' : 'y', NUDGE_STEP_DEG); break;
    case 'ArrowDown':
      e.preventDefault(); nudgeSelectedBone(e.shiftKey ? 'z' : 'y', -NUDGE_STEP_DEG); break;
    default:
      return;
  }
});

/* ============================================================
   レンダーループ
   ============================================================ */
let lastTime = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  controls.update();
  if (activeCharacter) activeCharacter.update(dt);
  bgRenderer.render(backgroundScene, camera);
  effect.render(characterScene, camera);
}
animate();
