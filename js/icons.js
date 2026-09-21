/* ============================================================
   js/icons.js — 自作の線画SVGアイコン集(ADR-017)
   ------------------------------------------------------------
   絵文字(📷🧭📳◎◐⏱⟲🐛✕☀)はOSやブラウザによって太さ・見た目が
   バラバラで、黒×金のブランドトーンからも浮いていた。
   ここでは1色の線画(stroke=currentColor)に統一し、ボタン側の
   color指定(--ink/--gold)をそのまま継承できるようにする。
   画像ファイルを追加しないノービルド方針は維持(インラインSVG文字列)。

   使い方: HTML側に <span class="icon-svg" data-icon="camera"></span>
   のようなプレースホルダを置き、injectIcons()を1回呼べば
   data-icon名に対応するSVGがinnerHTMLとして差し込まれる。
   ============================================================ */

const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';

export const ICONS = {
  camera: `<svg viewBox="0 0 24 24" ${STROKE}>
    <path d="M4 8.5a2 2 0 0 1 2-2h1.2l.9-1.5a1.5 1.5 0 0 1 1.3-.75h5.2a1.5 1.5 0 0 1 1.3.75l.9 1.5H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8.5Z"/>
    <circle cx="12" cy="13" r="3.4"/>
  </svg>`,

  // 撮影モード切替(写真↔動画)の動画側アイコン(旧: 🎥)。main.jsのupdateModeBtnLabelから使う。
  video: `<svg viewBox="0 0 24 24" ${STROKE}>
    <rect x="3.5" y="6.5" width="12" height="11" rx="2"/>
    <path d="M15.5 10.2 20.5 7v10l-5-3.2Z"/>
  </svg>`,

  compass: `<svg viewBox="0 0 24 24" ${STROKE}>
    <circle cx="12" cy="12" r="8.5"/>
    <path d="M14.5 9.5 13 13l-3.5 1.5L11 11l3.5-1.5Z"/>
  </svg>`,

  motion: `<svg viewBox="0 0 24 24" ${STROKE}>
    <rect x="8" y="3" width="8" height="18" rx="2"/>
    <path d="M4 9v6M20 9v6"/>
  </svg>`,

  // 配置/再配置(旧: ◎)。クロスヘア(照準)で「ここに置く」を表現。
  target: `<svg viewBox="0 0 24 24" ${STROKE}>
    <circle cx="12" cy="12" r="7.5"/>
    <circle cx="12" cy="12" r="2.2"/>
    <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3"/>
  </svg>`,

  // 影の向き・長さ調整(旧: ◐)。半分だけ塗った円で「影」を表現。
  shadow: `<svg viewBox="0 0 24 24" ${STROKE}>
    <circle cx="12" cy="12" r="8"/>
    <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none"/>
  </svg>`,

  // セルフタイマー(旧: ⏱)。
  timer: `<svg viewBox="0 0 24 24" ${STROKE}>
    <circle cx="12" cy="13" r="7.5"/>
    <path d="M9.5 3.5h5"/>
    <path d="M12 9v4l2.6 1.6"/>
  </svg>`,

  // 推しを選び直す(旧: ⟲)。
  reset: `<svg viewBox="0 0 24 24" ${STROKE}>
    <path d="M4.5 12a7.5 7.5 0 1 1 2.4 5.5"/>
    <path d="M4.5 17v-4h4"/>
  </svg>`,

  // デバッグログ(旧: 🐛)。「ログ」の意味に合わせてターミナル風の記号に変更。
  log: `<svg viewBox="0 0 24 24" ${STROKE}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2"/>
    <path d="M7 9.5 9.5 12 7 14.5M12 14.5h5"/>
  </svg>`,

  // 閉じる(旧: ✕)。
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
    <path d="M6 6l12 12M18 6 6 18"/>
  </svg>`,

  // 影ダイヤルの太陽ハンドル(旧: ☀)。
  sun: `<svg viewBox="0 0 24 24" ${STROKE}>
    <circle cx="12" cy="12" r="4.2"/>
    <path d="M12 2.5v2.4M12 19.1v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/>
  </svg>`,
};

/** data-icon属性を持つ要素へ、対応するSVGを差し込む。存在しない名前は無視する。 */
export function injectIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const svg = ICONS[el.dataset.icon];
    if (svg) el.innerHTML = svg;
  });
}
