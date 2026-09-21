/* ============================================================
   pose-ui.js — ポーズ/表情バー・調整パネルの共有UIロジック
   ------------------------------------------------------------
   main.js(カメラ本体)とdev.js(PC開発者モード)の両方で同じ
   ポーズ調整ロジックを使うことで、片方で追い込んだ数値がもう片方でも
   そのまま通用することを保証する。
   ============================================================ */
import { GLOBAL_OFFSET_PARAMS } from './character.js';

export function buildExpressionBar(expressionBar, def, getCharacter, onSelect) {
  expressionBar.innerHTML = '';
  if (!def.expressions) return;
  const buttons = {};
  Object.entries(def.expressions).forEach(([key, preset]) => {
    const btn = document.createElement('button');
    btn.className = 'expr-btn' + (key === 'normal' ? ' active' : '');
    btn.textContent = preset.emoji;
    btn.title = preset.label;
    btn.addEventListener('click', () => {
      const character = getCharacter();
      if (!character) return;
      character.setExpression(key);
      Object.values(buttons).forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      if (onSelect) onSelect(preset.label);
    });
    buttons[key] = btn;
    expressionBar.appendChild(btn);
  });
}

/**
 * @param {HTMLElement} poseBar
 * @param {object} def
 * @param {() => object|null} getCharacter
 * @param {(label:string)=>void} [onSelect] トースト表示用
 * @param {()=>void} [onPoseChange] ポーズ切替後に呼ばれる。character.setPose()内で
 *   全体オフセットが自動的に0へ戻るため、buildGlobalOffsetPanel()の
 *   syncFromCharacter()をここで呼んでスライダー表示も追従させるのに使う。
 */
export function buildPoseBar(poseBar, def, getCharacter, onSelect, onPoseChange) {
  poseBar.innerHTML = '';
  if (!def.poses) return;
  const buttons = {};
  Object.entries(def.poses).forEach(([key, preset]) => {
    const btn = document.createElement('button');
    btn.className = 'pose-btn' + (key === 'standing' ? ' active' : '');
    btn.dataset.poseKey = key;
    btn.textContent = preset.emoji;
    btn.title = preset.label;
    btn.addEventListener('click', () => {
      const character = getCharacter();
      if (!character) return;
      character.setPose(key);
      Object.values(buttons).forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      if (onSelect) onSelect(preset.label);
      if (onPoseChange) onPoseChange();
    });
    buttons[key] = btn;
    poseBar.appendChild(btn);
  });
}

/**
 * ポーズ調整パネル(ボーン選択+X/Y/Zスライダー+JSONコピー)の共通ロジック。
 * @param {object} els DOM要素一式 { select, xSlider, ySlider, zSlider, xVal, yVal, zVal, hint,
 *   search?, boneResetBtn? } search/boneResetBtnはdev.js専用の追加UI(ADR-017)。
 *   未指定でも従来通り動く(オプショナル)。
 * @param {() => object|null} getCharacter 現在のキャラクターインスタンスを返す関数
 */
export function createPoseTuner(els, getCharacter) {
  const { select, xSlider, ySlider, zSlider, xVal, yVal, zVal, hint, search, boneResetBtn } = els;
  // ADR-017: 検索欄で絞り込んでも「今どのボーンを触っているか」を保持するため、
  // <select>のoptionを毎回作り直すrefresh()とは別に、フルネームの一覧を保持する。
  let allBoneNames = [];

  // 値がプリセット既定値からどれだけ動いているかの判定しきい値(度)。
  // 浮動小数の誤差程度では「変更あり」と誤判定しないための遊び。
  const CHANGED_EPS = 0.05;

  function isBoneChanged(character, name) {
    if (!character || !character.presetBoneValues) return false;
    const base = character.presetBoneValues[name] || [0, 0, 0];
    const cur = character.poseTargets[name] || [0, 0, 0];
    return Math.abs(cur[0] - base[0]) > CHANGED_EPS ||
           Math.abs(cur[1] - base[1]) > CHANGED_EPS ||
           Math.abs(cur[2] - base[2]) > CHANGED_EPS;
  }

  /** <select>のoption一覧に、変更済みボーンの目印(●)を付けて再構築する。 */
  function renderOptions(filterText = '') {
    const character = getCharacter();
    const prevValue = select.value;
    select.innerHTML = '';
    const needle = filterText.trim().toLowerCase();
    const visible = needle
      ? allBoneNames.filter((n) => n.toLowerCase().includes(needle))
      : allBoneNames;
    if (visible.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = needle ? '(一致するボーンがありません)' : '(このポーズには調整可能なボーンがありません)';
      opt.disabled = true;
      select.appendChild(opt);
      return;
    }
    visible.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = (character && isBoneChanged(character, name) ? '● ' : '') + name;
      select.appendChild(opt);
    });
    // 絞り込み後も、直前に選んでいたボーンが結果に残っていればそれを維持する。
    if (visible.includes(prevValue)) select.value = prevValue;
  }

  function loadSliders(name) {
    const character = getCharacter();
    if (!character) return;
    const v = character.poseTargets[name] || [0, 0, 0];
    xSlider.value = v[0]; ySlider.value = v[1]; zSlider.value = v[2];
    xVal.textContent = Math.round(v[0]);
    yVal.textContent = Math.round(v[1]);
    zVal.textContent = Math.round(v[2]);
    const changed = isBoneChanged(character, name);
    [xVal, yVal, zVal].forEach((el) => el.classList.toggle('tune-val-changed', changed));
    if (boneResetBtn) boneResetBtn.disabled = !changed;
  }

  function refresh() {
    const character = getCharacter();
    if (!character) { select.innerHTML = ''; return; }
    allBoneNames = character.getCurrentPoseBoneNames();
    if (search) search.value = '';
    if (allBoneNames.length === 0) {
      renderOptions();
      xSlider.disabled = ySlider.disabled = zSlider.disabled = true;
      if (boneResetBtn) boneResetBtn.disabled = true;
      return;
    }
    xSlider.disabled = ySlider.disabled = zSlider.disabled = false;
    renderOptions();
    loadSliders(allBoneNames[0]);
  }

  function onSliderInput() {
    const character = getCharacter();
    if (!character) return;
    const name = select.value;
    if (!name) return;
    const xyz = [Number(xSlider.value), Number(ySlider.value), Number(zSlider.value)];
    character.setBoneDelta(name, xyz);
    xVal.textContent = Math.round(xyz[0]);
    yVal.textContent = Math.round(xyz[1]);
    zVal.textContent = Math.round(xyz[2]);
    const changed = isBoneChanged(character, name);
    [xVal, yVal, zVal].forEach((el) => el.classList.toggle('tune-val-changed', changed));
    if (boneResetBtn) boneResetBtn.disabled = !changed;
    // 一覧の●マークは値確定のたびに軽く同期しておく(選択自体は保持される)。
    renderOptions(search ? search.value : '');
  }
  xSlider.addEventListener('input', onSliderInput);
  ySlider.addEventListener('input', onSliderInput);
  zSlider.addEventListener('input', onSliderInput);
  select.addEventListener('change', () => loadSliders(select.value));
  if (search) {
    search.addEventListener('input', () => renderOptions(search.value));
  }

  function showHint(text, ms = 1500) {
    if (!hint) return;
    hint.textContent = text;
    setTimeout(() => { hint.textContent = ''; }, ms);
  }

  function resetToDefault() {
    const character = getCharacter();
    if (!character) return;
    character.resetPoseToDefault();
    loadSliders(select.value);
    renderOptions(search ? search.value : '');
    showHint('初期値に戻しました');
  }

  /** ADR-017新規: 選択中の1ボーンだけを既定値へ戻す(全体リセットより手軽な微修正用)。 */
  function resetSelectedBone() {
    const character = getCharacter();
    if (!character) return;
    const name = select.value;
    if (!name || !character.presetBoneValues) return;
    const base = character.presetBoneValues[name] || [0, 0, 0];
    character.setBoneDelta(name, base);
    loadSliders(name);
    renderOptions(search ? search.value : '');
    showHint(`${name} を初期値に戻しました`);
  }
  if (boneResetBtn) boneResetBtn.addEventListener('click', resetSelectedBone);

  /**
   * ADR-017: 全ボーンではなく「既定値から動かしたボーンだけ」を出力する。
   * 差分のみになることで、Claudeへ貼り付ける際のノイズを減らす。
   */
  function buildDiffObject() {
    const character = getCharacter();
    if (!character) return {};
    const names = character.getCurrentPoseBoneNames();
    const obj = {};
    names.forEach((n) => {
      if (!isBoneChanged(character, n)) return;
      const v = character.poseTargets[n] || [0, 0, 0];
      obj[n] = v.map((x) => Math.round(x * 10) / 10);
    });
    return obj;
  }

  async function copyJSON() {
    const character = getCharacter();
    if (!character) return;
    const obj = buildDiffObject();
    if (Object.keys(obj).length === 0) {
      showHint('既定値から変更したボーンがありません');
      return;
    }
    const json = JSON.stringify(obj, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      showHint('差分をコピーしました。Claudeに貼り付けて送ってください');
    } catch (e) {
      window.prompt('コピーしてClaudeに送ってください(既定値からの差分のみ):', json);
    }
  }

  return { refresh, loadSliders, resetToDefault, resetSelectedBone, copyJSON, buildDiffObject, isBoneChanged };
}

/**
 * 「基本ポーズ＋全体オフセット」調整パネル。
 * ------------------------------------------------------------
 * ボーンを個別に選ぶ精密調整(createPoseTuner)とは別の、スマホでも
 * 素早く扱える少数パラメータ版。「体の向き/傾き」「顔の向き/首かしげ」の
 * 4本のスライダーで、現在のポーズプリセットに対する差分だけを
 * その場限りで調整する(保存はしない。ポーズプリセット切替で自動的に0へ戻る)。
 *
 * パラメータの定義(対象ボーン・可動域)はcharacter.jsのGLOBAL_OFFSET_PARAMS/
 * GLOBAL_OFFSET_BONESが唯一の定義元。ここではUIの生成・同期のみを行う。
 *
 * @param {HTMLElement} container スライダー行を生成して差し込むDOM要素
 * @param {() => object|null} getCharacter
 * @returns {{ syncFromCharacter: () => void, resetAll: () => void }}
 */
export function buildGlobalOffsetPanel(container, getCharacter) {
  container.innerHTML = '';
  const rows = {};
  GLOBAL_OFFSET_PARAMS.forEach(({ key, label, range }) => {
    const row = document.createElement('div');
    row.className = 'offset-row';

    const lbl = document.createElement('span');
    lbl.className = 'offset-label';
    lbl.textContent = label;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'offset-slider';
    slider.min = String(-range);
    slider.max = String(range);
    slider.step = '1';
    slider.value = '0';

    const val = document.createElement('span');
    val.className = 'offset-val';
    val.textContent = '0';

    slider.addEventListener('input', () => {
      const character = getCharacter();
      if (!character) return;
      const deg = Number(slider.value);
      character.setGlobalOffset(key, deg);
      val.textContent = String(Math.round(deg));
    });

    row.appendChild(lbl);
    row.appendChild(slider);
    row.appendChild(val);
    container.appendChild(row);
    rows[key] = { slider, val };
  });

  // ポーズプリセット切替時など、character側の値が外部要因で変わった時に
  // スライダーの見た目だけを追従させる(例: buildPoseBarのonPoseChangeから呼ぶ)。
  function syncFromCharacter() {
    const character = getCharacter();
    if (!character) return;
    GLOBAL_OFFSET_PARAMS.forEach(({ key }) => {
      const v = (character.globalOffset && character.globalOffset[key]) || 0;
      rows[key].slider.value = String(v);
      rows[key].val.textContent = String(Math.round(v));
    });
  }

  function resetAll() {
    const character = getCharacter();
    if (!character) return;
    character.resetGlobalOffset();
    syncFromCharacter();
  }

  return { syncFromCharacter, resetAll };
}
