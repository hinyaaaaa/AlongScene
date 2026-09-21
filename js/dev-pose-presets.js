/* ============================================================
   js/dev-pose-presets.js — ポーズ調整の自動保存・名前付きプリセット(新規)
   ------------------------------------------------------------
   ADR-017: dev.js(PC開発者モード)専用。main.js/スマホ側の実行には
   一切関わらない(importされるのはdev.jsのみ)。

   これまでdev.jsのポーズ調整は「JSONをコピーしてClaudeに送る」until
   手動フローのみで、うっかりリロードすると調整が全て消えていた。
   ここではキャラクターID×ポーズ名をキーに、初期値からの差分ボーンだけを
   localStorageへ保存する(全ボーンではなく差分のみにすることで、
   将来ボーン構成が変わっても壊れにくくする)。

   保存形式:
   - 自動保存: { [characterId]: { [poseKey]: { boneName: [x,y,z], ... } } }
   - 名前付きプリセット: { [characterId]: { [presetName]: { poseKey, bones: {...} } } }
   ============================================================ */
const AUTOSAVE_KEY = 'alongscene_dev_pose_autosave_v1';
const PRESET_KEY = 'alongscene_dev_pose_presets_v1';

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.warn(`[dev-pose-presets] ${key} の読み込みに失敗`, e);
    return fallback;
  }
}
function writeJSON(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) {
    console.warn(`[dev-pose-presets] ${key} の保存に失敗`, e);
  }
}

export function createPosePresetStore() {
  function saveAutosave(characterId, poseKey, diffObj) {
    if (!characterId || !poseKey) return;
    const all = readJSON(AUTOSAVE_KEY, {});
    all[characterId] = all[characterId] || {};
    all[characterId][poseKey] = diffObj;
    writeJSON(AUTOSAVE_KEY, all);
  }
  function loadAutosave(characterId, poseKey) {
    const all = readJSON(AUTOSAVE_KEY, {});
    return (all[characterId] && all[characterId][poseKey]) || null;
  }

  function listPresetNames(characterId) {
    const all = readJSON(PRESET_KEY, {});
    return Object.keys(all[characterId] || {});
  }
  function savePreset(characterId, name, poseKey, diffObj) {
    if (!characterId || !name) return;
    const all = readJSON(PRESET_KEY, {});
    all[characterId] = all[characterId] || {};
    all[characterId][name] = { poseKey, bones: diffObj };
    writeJSON(PRESET_KEY, all);
  }
  function getPreset(characterId, name) {
    const all = readJSON(PRESET_KEY, {});
    return (all[characterId] && all[characterId][name]) || null;
  }
  function deletePreset(characterId, name) {
    const all = readJSON(PRESET_KEY, {});
    if (all[characterId]) {
      delete all[characterId][name];
      writeJSON(PRESET_KEY, all);
    }
  }

  return { saveAutosave, loadAutosave, listPresetNames, savePreset, getPreset, deletePreset };
}
