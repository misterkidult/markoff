/**
 * markoff — 在活的網頁上標記，標完就結束
 *
 * 設計師打開已部署的預覽網址，點畫面上任何元素、打字、按留言，
 * 意見就帶著「當時是在什麼裝置、什麼寬度看的」一起留下來。
 *
 * 「送出」就是按下留言的那一刻，沒有第二次確認的動作——
 * 額外一顆送出鈕最容易被漏掉，標了一下午關掉分頁才發現什麼都沒送出去。
 *
 * 不依賴任何框架，只認 DOM，單檔可直接放進任何專案。
 *
 * 用法：在 </body> 前加一行
 *   <script src="markoff.js" defer></script>
 * 然後開 https://你的網址/?comment=1
 *
 * 正常訪客（沒有 ?comment=1）完全看不到任何東西，可以跟正式站一起部署。
 *
 * 留言預設只存在瀏覽器裡，隨時可以匯出成 JSON。
 * 要把留言送到自己的後端（Sheets、Notion、Slack、任何 API），
 * 掛一個 markoff.onSubmit 就好，見 README。
 *
 * MIT License
 */
(function () {
  'use strict';

  // ── 開關：沒有 ?comment=1 就整個不啟動 ───────────────────────────
  const params = new URLSearchParams(location.search);
  if (params.get('comment') !== '1') return;
  if (window.__markoffLoaded) return;
  window.__markoffLoaded = true;

  // ── 設定 ──────────────────────────────────────────────────────
  const SELF = document.currentScript
    || document.querySelector('script[src*="markoff.js"]');

  const CONFIG = {
    // 標記歸在哪個案子底下，會一起送出／匯出方便篩選。沒給就用網站網域。
    project: SELF?.dataset.project || location.hostname,
    // 有給 data-endpoint 才會走網路；沒給就是純本機模式。
    endpoint: SELF?.dataset.endpoint || null,
  };

  const STORAGE_KEY = 'markoff:' + location.pathname;
  const Z = 2147483000; // 蓋過頁面上任何東西

  /**
   * 留言要送去哪，由這裡決定。三種情況：
   *
   *   1. 什麼都沒設 → 純本機模式。留言存在瀏覽器，靠匯出 JSON 帶走。
   *   2. 設了 data-endpoint → 用內建的 fetch 送 JSON 到那個網址。
   *   3. 掛了 markoff.onSubmit → 完全交給你，想送去哪都行。
   *
   * onSubmit 收到 (payload) 回傳 Promise：
   * resolve 表示送成功（pin 變實心），reject 表示失敗（之後自動重試）。
   *
   * payload.action 是 'create' | 'update' | 'delete'，
   * 三種都要處理才能支援改與刪；只實作 create 也能動，
   * 改與刪會一直重試不成功。
   */
  const api = {
    onSubmit: null,
    /** 目前有幾則留言（給外部讀，不要改） */
    get comments() { return comments.map(toPublic); },
    /** 手動觸發匯出 JSON */
    export: () => exportJson(),
    /** 把送失敗的重送一次 */
    retry: () => flushPending(),
  };
  window.markoff = api;

  /** 有地方可以送嗎？沒有的話留言按下去就直接算完成，不轉圈也不重試 */
  function hasTransport() {
    return typeof api.onSubmit === 'function' || !!CONFIG.endpoint;
  }

  /** @type {Array<Comment>} 累積的標註 */
  let comments = [];
  let active = false; // 是否在留言模式
  let seq = 0;

  // ══════════════════════════════════════════════════════════════
  // 元素定位：產生一組「換人也找得回同一個元素」的線索
  // ══════════════════════════════════════════════════════════════

  /** 為單一元素產生穩定的 CSS 選擇器（由 id / class / nth-of-type 逐層退讓） */
  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    if (el.id) return '#' + CSS.escape(el.id);

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      let seg = node.tagName.toLowerCase();
      const classes = Array.from(node.classList)
        .filter((c) => !/^(is-|js-|aos)/.test(c) && !c.startsWith('dcmt-'))
        .slice(0, 3);
      if (classes.length) seg += '.' + classes.map((c) => CSS.escape(c)).join('.');

      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) seg += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(seg);
      node = node.parentElement;
      if (node === document.body) break;
    }
    return parts.join(' > ');
  }

  /** 收集元素的可辨識資訊：選擇器不夠時，文字與尺寸能幫前端對上是哪一個 */
  function describeElement(el) {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    return {
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: Array.from(el.classList).filter((c) => !c.startsWith('dcmt-')),
      text: text || null,
      rect: {
        x: Math.round(rect.left + scrollX),
        y: Math.round(rect.top + scrollY),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      // 最常被抱怨的幾個屬性先收著，省得前端回頭問「現在幾 px」
      computed: {
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        color: cs.color,
        backgroundColor: cs.backgroundColor,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════
  // 樣式（全部前綴 dcmt- 避免撞到專案自己的 class）
  // ══════════════════════════════════════════════════════════════

  const style = document.createElement('style');
  style.textContent = `
    .dcmt-fab{position:fixed;left:16px;bottom:var(--dcmt-bottom,16px);z-index:${Z};
      display:flex;gap:8px;align-items:center;transition:bottom .2s;
      flex-direction:row-reverse;
      font:14px/1.5 -apple-system,"PingFang TC","Noto Sans TC",sans-serif}
    .dcmt-btn{border:0;border-radius:999px;padding:12px 20px;cursor:pointer;
      background:#111;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.28);
      font:inherit;font-weight:600;white-space:nowrap;transition:transform .12s}
    .dcmt-btn:active{transform:scale(.96)}
    .dcmt-btn[data-on="1"]{background:#c8102e}
    .dcmt-btn.dcmt-ghost{background:#fff;color:#111;font-weight:500;
      box-shadow:0 2px 12px rgba(0,0,0,.18)}

    /* 留言模式下的 hover／點按外框 */
    .dcmt-hl{position:absolute;pointer-events:none;z-index:${Z - 2};
      outline:2px solid #c8102e;outline-offset:1px;background:rgba(200,16,46,.08);
      border-radius:3px;transition:all .08s}

    /* 已標註元素的持續外框：一眼看出哪些地方標過了 */
    .dcmt-mark{position:absolute;pointer-events:none;z-index:${Z - 4};
      outline:2px dashed rgba(200,16,46,.75);outline-offset:2px;
      background:rgba(200,16,46,.06);border-radius:3px}
    .dcmt-mark[data-open="1"]{outline-style:solid;background:rgba(200,16,46,.14)}

    /* 編號 pin：Figma 式水滴形，尖角指向被標註的位置 */
    .dcmt-pin{position:absolute;z-index:${Z - 1};width:28px;height:28px;
      border-radius:50% 50% 2px 50%;background:#c8102e;color:#fff;
      font-size:12px;font-weight:700;display:flex;align-items:center;
      justify-content:center;cursor:pointer;border:2px solid #fff;
      box-shadow:0 2px 10px rgba(0,0,0,.35);
      font-family:-apple-system,"PingFang TC",sans-serif;transition:transform .12s}
    .dcmt-pin:hover,.dcmt-pin[data-open="1"]{transform:scale(1.15)}
    .dcmt-pin[data-open="1"]{background:#111}
    /* 元素目前不在頁面上（輪播換頁、動態內容），標記位置僅供參考 */
    .dcmt-pin[data-lost="1"]{background:#999}
    /* 還沒送出去：空心表示「這則還在路上」，送成功後才填滿 */
    .dcmt-pin[data-pending="1"]{background:#fff;color:#c8102e;
      border-color:#c8102e;border-style:dashed}
    .dcmt-pin[data-pending="1"]::after{content:'';position:absolute;
      inset:-2px;border-radius:inherit;border:2px solid transparent;
      border-top-color:#c8102e;animation:dcmt-spin .8s linear infinite}
    .dcmt-pin[data-pending="failed"]::after{animation:none;border-top-color:transparent}
    @keyframes dcmt-spin{to{transform:rotate(360deg)}}

    /* 遮罩：modal 出現時壓暗頁面，點它關閉 */
    .dcmt-scrim{position:fixed;inset:0;z-index:${Z - 1};background:rgba(0,0,0,.28)}

    /* 輸入／檢視 modal：位置固定，不隨點擊處跳動 */
    .dcmt-bubble{position:fixed;z-index:${Z};width:340px;
      left:16px;bottom:calc(var(--dcmt-bottom,16px) + 58px);
      background:#fff;border-radius:14px;box-shadow:0 12px 48px rgba(0,0,0,.34);
      padding:16px;font:14px/1.6 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;
      color:#111}
    .dcmt-bubble textarea{width:100%;min-height:78px;border:1px solid #e0e0e0;
      border-radius:9px;padding:9px;font:inherit;resize:vertical;box-sizing:border-box}
    .dcmt-bubble textarea:focus{outline:2px solid #c8102e;outline-offset:-1px;
      border-color:transparent}
    .dcmt-target{font-size:11px;color:#8a8a8a;margin-bottom:9px;line-height:1.45;
      word-break:break-all;max-height:34px;overflow:hidden}
    .dcmt-acts{display:flex;gap:6px;margin-top:10px;justify-content:flex-end;
      align-items:center}
    .dcmt-acts button{border:0;border-radius:8px;padding:8px 15px;cursor:pointer;
      font:inherit;font-size:13px}
    .dcmt-ok{background:#c8102e;color:#fff;font-weight:600}
    .dcmt-no{background:#f0f0f0;color:#555}
    .dcmt-tip{font-size:11px;color:#aaa;margin-right:auto}
    .dcmt-read{white-space:pre-wrap;margin:0 0 4px}
    .dcmt-in{width:100%;border:1px solid #e0e0e0;border-radius:9px;padding:10px;
      font:inherit;box-sizing:border-box;margin-bottom:8px}
    .dcmt-in:focus{outline:2px solid #c8102e;outline-offset:-1px;border-color:transparent}
    .dcmt-err{color:#c8102e;font-size:12px;margin-bottom:6px}
    .dcmt-btn:disabled{opacity:.6;cursor:default}

    /* 清單抽屜 */
    .dcmt-list{position:fixed;left:16px;bottom:calc(var(--dcmt-bottom,16px) + 58px);
      z-index:${Z};width:320px;max-height:52vh;overflow-y:auto;background:#fff;
      border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.3);padding:8px;
      font:13px/1.55 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;color:#111}
    .dcmt-item{display:flex;gap:9px;padding:9px;border-bottom:1px solid #f2f2f2;
      cursor:pointer;border-radius:8px}
    .dcmt-item:last-child{border-bottom:0}
    .dcmt-item:hover{background:#fafafa}
    .dcmt-item-n{flex:0 0 21px;height:21px;border-radius:50%;background:#c8102e;
      color:#fff;font-size:11px;font-weight:700;display:flex;
      align-items:center;justify-content:center}
    .dcmt-item-body{flex:1;min-width:0}
    .dcmt-item-sel{font-size:11px;color:#9a9a9a;overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
    .dcmt-bp{background:#f0f0f0;color:#666;border-radius:4px;padding:1px 5px;
      font-size:10px;font-weight:600}
    .dcmt-sync{border-radius:4px;padding:1px 5px;font-size:10px;font-weight:600}
    .dcmt-sync[data-s="pending"]{background:#fff4e5;color:#a05a00}
    .dcmt-sync[data-s="failed"]{background:#fde8ec;color:#c8102e}
    .dcmt-item[data-s="synced"] .dcmt-item-n{background:#c8102e}
    .dcmt-item[data-s="pending"] .dcmt-item-n,
    .dcmt-item[data-s="failed"] .dcmt-item-n{background:#fff;color:#c8102e;
      box-shadow:inset 0 0 0 1.5px #c8102e}
    .dcmt-del{border:0;background:none;color:#c8102e;cursor:pointer;font-size:17px;
      line-height:1;padding:0 5px;align-self:flex-start}
    .dcmt-empty{color:#aaa;text-align:center;padding:18px 0}

    /* 手機：加大觸控尺寸，泡泡改成貼底抽屜避開虛擬鍵盤 */
    @media (max-width: 640px){
      .dcmt-fab{left:12px;bottom:var(--dcmt-bottom,12px)}
      .dcmt-btn{padding:13px 20px;font-size:15px}
      .dcmt-bubble{left:12px;right:12px;bottom:12px;top:auto;width:auto;padding:16px}
      .dcmt-bubble textarea,.dcmt-in{min-height:44px;font-size:16px} /* 16px 防 iOS 自動放大 */
      .dcmt-bubble textarea{min-height:92px}
      .dcmt-acts button{padding:11px 18px;font-size:15px}
      .dcmt-list{left:12px;right:12px;width:auto;max-height:44vh}
      .dcmt-pin{width:30px;height:30px;font-size:13px}
    }
  `;
  document.head.appendChild(style);

  function isOurs(el) {
    return el && el.closest && el.closest('[class^="dcmt-"],[class*=" dcmt-"]');
  }

  // ══════════════════════════════════════════════════════════════
  // 裝置情境：同一句「這裡太擠」在手機與桌機是兩個問題，
  // 所以每則留言都要帶著「當時是在什麼寬度看的」。
  // ══════════════════════════════════════════════════════════════

  const BREAKPOINTS = [
    { max: 479, name: 'mobile', label: '手機' },
    { max: 767, name: 'mobile-lg', label: '大手機' },
    { max: 1023, name: 'tablet', label: '平板' },
    { max: 1439, name: 'desktop', label: '桌機' },
    { max: Infinity, name: 'desktop-lg', label: '大桌機' },
  ];

  /**
   * 從 userAgent 認出作業系統、瀏覽器與裝置型號。認不出就留空，不亂猜。
   *
   * ⚠ iPhone 抓不到型號：Apple 自 iOS 12 起把所有 iPhone 的 UA 統一，
   * 分不出 15 或 16。Android 反而在 UA 裡帶了型號字串。
   * 想知道是哪支 iPhone 只能靠螢幕解析度反推，那是猜測不是事實，
   * 所以這裡只回報「iPhone」，解析度另外記在 screen 欄位供人工判讀。
   */
  function parseUA(ua) {
    const os =
      /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
      /Android/.test(ua) ? 'Android' :
      /Mac OS X/.test(ua) ? 'macOS' :
      /Windows/.test(ua) ? 'Windows' :
      /Linux/.test(ua) ? 'Linux' : '';

    // 順序有意義：Edge/Opera/Chrome 的 UA 都含 Safari，Safari 必須放最後
    const browser =
      /Edg\//.test(ua) ? 'Edge' :
      /OPR\//.test(ua) ? 'Opera' :
      /Chrome\//.test(ua) ? 'Chrome' :
      /Firefox\//.test(ua) ? 'Firefox' :
      /Safari\//.test(ua) ? 'Safari' : '';

    // 版本號：只取主版號，夠用來判斷「舊版瀏覽器才有的問題」
    const vMatch = ua.match(/(?:Edg|OPR|Chrome|Firefox|Version)\/(\d+)/);
    const browserVersion = vMatch ? vMatch[1] : '';

    let model = '';
    if (/iPhone/.test(ua)) model = 'iPhone';
    else if (/iPad/.test(ua)) model = 'iPad';
    else if (/Android/.test(ua)) {
      // Android UA 形如 "...; SM-G991B Build/..." ——分號與 Build 之間就是型號
      const m = ua.match(/;\s*([^;)]+?)\s+Build\//) || ua.match(/Android[^;]*;\s*([^;)]+)/);
      model = m ? m[1].trim() : 'Android 裝置';
    } else if (/Macintosh/.test(ua)) model = 'Mac';
    else if (/Windows/.test(ua)) model = 'PC';

    return { os, browser, browserVersion, model };
  }

  function deviceContext() {
    const w = innerWidth;
    const bp = BREAKPOINTS.find((b) => w <= b.max);
    const coarse = matchMedia('(pointer: coarse)').matches;
    const { os, browser, browserVersion, model } = parseUA(navigator.userAgent);
    const dpr = devicePixelRatio || 1;
    return {
      // 視窗（可縮放）與螢幕（實體解析度）分開記：
      // 「27 吋螢幕把視窗縮到 1200px」和「筆電本來就 1200px」是兩種情境，
      // 只看 viewport 分不出來。
      viewport: { w, h: innerHeight },
      screen: {
        w: screen.width,
        h: screen.height,
        // 視窗佔螢幕多少，一眼看出是不是刻意縮窄測試
        ratio: screen.width ? Math.round((w / screen.width) * 100) : null,
      },
      breakpoint: bp.name,
      breakpointLabel: bp.label,
      orientation: innerWidth >= innerHeight ? 'landscape' : 'portrait',
      // 觸控與否比寬度更能分辨「真手機」和「把視窗縮窄的桌機」
      input: coarse ? 'touch' : 'mouse',
      dpr,
      // dpr ≥ 2 就是高解析螢幕（Apple 叫 Retina）。1x 螢幕上看起來
      // 銳利的線條，在 2x 上可能顯得過細——這類回饋要看得出來源。
      retina: dpr >= 2,
      os,
      browser,
      browserVersion,
      model,
    };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ══════════════════════════════════════════════════════════════
  // 選取高亮
  // ══════════════════════════════════════════════════════════════

  const hl = document.createElement('div');
  hl.className = 'dcmt-hl';
  hl.style.display = 'none';
  document.body.appendChild(hl);

  function highlight(el) {
    if (!el || isOurs(el) || el === document.body || el === document.documentElement) {
      hl.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = r.left + scrollX + 'px';
    hl.style.top = r.top + scrollY + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';
  }

  document.addEventListener('mouseover', (e) => {
    if (active) highlight(e.target);
  }, true);

  // 觸控裝置沒有 hover：手指按下時先畫框，讓她看見會選到誰
  document.addEventListener('touchstart', (e) => {
    if (active && !isOurs(e.target)) highlight(e.target);
  }, { capture: true, passive: true });

  // 留言模式下攔掉連結與表單，避免標註時誤觸導航
  document.addEventListener('pointerdown', (e) => {
    if (!active || isOurs(e.target)) return;
    const interactive = e.target.closest &&
      e.target.closest('a[href],button,input,select,textarea,label,summary');
    if (interactive) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // 有泡泡開著時，第一次點擊只用來關閉它，不會順手開一個新的
  let swallowNextClick = false;

  document.addEventListener('click', (e) => {
    if (!active || isOurs(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (swallowNextClick) { swallowNextClick = false; return; }
    openCompose(e.target, { x: e.pageX, y: e.pageY });
  }, true);

  // ══════════════════════════════════════════════════════════════
  // 泡泡：新增與檢視共用同一個容器
  // ══════════════════════════════════════════════════════════════

  let bubble = null;
  let scrim = null;
  let openPinId = null;

  function closeBubble() {
    if (bubble) { bubble.remove(); bubble = null; }
    if (scrim) { scrim.remove(); scrim = null; }
    if (openPinId != null) {
      const p = pins.find((x) => x._n === openPinId);
      if (p) p.dataset.open = '0';
      const m = marks.find((x) => x._n === openPinId);
      if (m) m.dataset.open = '0';
      openPinId = null;
    }
  }

  /**
   * modal 的位置由 CSS 固定（桌機右下、手機貼底），不隨點擊處移動。
   * 這裡只負責掛遮罩，讓使用者知道現在有東西等著他處理。
   */
  function mountBubble(el) {
    scrim = document.createElement('div');
    scrim.className = 'dcmt-scrim';
    scrim.onclick = closeBubble;
    document.body.appendChild(scrim);
    document.body.appendChild(el);
  }

  /**
   * 新增留言。按下「留言」就是送出，沒有第二段確認動作。
   * 送出中不擋著畫面——泡泡立刻關掉、pin 立刻出現（空心表示還在送），
   * 她可以繼續標下一個地方，不必等網路。
   */
  function openCompose(target, anchor) {
    closeBubble();
    const element = describeElement(target);

    bubble = document.createElement('div');
    bubble.className = 'dcmt-bubble';
    const dev = deviceContext();
    bubble.innerHTML = `
      <div class="dcmt-target">${esc(element.tag)}${element.id ? '#' + esc(element.id) : ''}
        · ${esc(element.text ? element.text.slice(0, 40) : element.selector)}</div>
      <textarea placeholder="要改成什麼？"></textarea>
      <div class="dcmt-acts">
        <span class="dcmt-tip">${esc(dev.breakpointLabel)} ${dev.viewport.w}px<br>
          <span style="opacity:.7">${esc([
            dev.model,
            dev.browser,
            `螢幕 ${dev.screen.w}×${dev.screen.h}`,
            dev.retina ? 'Retina' : '',
          ].filter(Boolean).join(' · '))}</span></span>
        <button class="dcmt-no" type="button">取消</button>
        <button class="dcmt-ok" type="button">留言</button>
      </div>`;
    mountBubble(bubble);

    const ta = bubble.querySelector('textarea');
    ta.focus();

    const submit = () => {
      const note = ta.value.trim();
      if (!note) { ta.focus(); return; }
      addComment({ note, element, anchor });
      closeBubble();
    };
    bubble.querySelector('.dcmt-ok').onclick = submit;
    bubble.querySelector('.dcmt-no').onclick = closeBubble;
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
      if (e.key === 'Escape') closeBubble();
    });
  }

  /**
   * 檢視既有留言：直接就是可編輯的輸入框，不用先按「編輯」。
   * 改了才會送出更新，沒改就只是關掉。
   */
  function openRead(c) {
    closeBubble();
    bubble = document.createElement('div');
    bubble.className = 'dcmt-bubble';
    const state = SYNC_LABEL[c.sync] || '';
    bubble.innerHTML = `
      <div class="dcmt-target">#${c.n} · ${esc(c.element ? c.element.selector : '')}</div>
      <textarea>${esc(c.note)}</textarea>
      <div class="dcmt-err" style="display:none"></div>
      <div class="dcmt-acts">
        <span class="dcmt-tip">${esc(state)}</span>
        <button class="dcmt-no dcmt-remove" type="button">刪除</button>
        <button class="dcmt-ok" type="button">完成</button>
      </div>`;
    mountBubble(bubble);
    openPinId = c.n;
    const pin = pins.find((x) => x._n === c.n);
    if (pin) pin.dataset.open = '1';
    const mark = marks.find((x) => x._n === c.n);
    if (mark) mark.dataset.open = '1';

    const ta = bubble.querySelector('textarea');
    const errEl = bubble.querySelector('.dcmt-err');

    const done = () => {
      const note = ta.value.trim();
      if (!note) {
        errEl.textContent = '留言不能是空的。要拿掉請按「刪除」。';
        errEl.style.display = 'block';
        ta.focus();
        return;
      }
      if (note !== c.note) editComment(c.n, note);
      closeBubble();
    };
    bubble.querySelector('.dcmt-ok').onclick = done;
    bubble.querySelector('.dcmt-remove').onclick = () => { removeComment(c.n); closeBubble(); };
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') done();
      if (e.key === 'Escape') closeBubble();
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 資料
  // ══════════════════════════════════════════════════════════════

  /**
   * 每則留言的唯一編號。後端靠它認出是哪一則，才有辦法回頭改或刪。
   * 用亂數而非流水號：她可能同時開兩個分頁標註，流水號會撞。
   */
  function makeUid() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return 'c-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 10);
  }

  /**
   * sync 有四種值，決定 pin 長什麼樣：
   *   synced   已送達（實心）；純本機模式下按下留言就是這個狀態
   *   pending  正在送或排隊等送（空心＋轉圈）
   *   failed   送過但失敗，等下次重試（空心，不轉）
   *   local    只存在本機，永遠不送（目前沒用到，保留給離線模式）
   */
  const SYNC_LABEL = {
    pending: '傳送中…',
    failed: '尚未送出，稍後自動重試',
    synced: '已送出',
  };

  function addComment({ note, element, anchor }) {
    seq += 1;
    const c = {
      n: seq,
      uid: makeUid(),
      note,
      element,
      anchor: { x: Math.round(anchor.x), y: Math.round(anchor.y) },
      // 逐則記錄，因為她可能先用手機標一輪、再轉桌機標一輪
      device: deviceContext(),
      at: new Date().toISOString(),
      // 沒有地方可以送時，存進瀏覽器就是完成了，pin 直接實心
      sync: hasTransport() ? 'pending' : 'synced',
    };
    comments.push(c);
    save();
    render();
    // 不 await：泡泡已經關了，網路慢不該卡住她標下一個地方
    if (hasTransport()) pushCreate(c);
  }

  function editComment(n, note) {
    const c = comments.find((x) => x.n === n);
    if (!c || note === c.note) return;
    c.note = note;
    // 還沒送出去的，改本機就好——等它送出時送的就是新內容
    if (c.sync === 'synced' && hasTransport()) {
      c.sync = 'pending';
      c.pendingOp = 'update';
      save();
      render();
      pushUpdate(c);
    } else {
      save();
      render();
    }
  }

  /**
   * 刪除會送出 action: 'delete'，怎麼處理由後端決定。
   * 建議標記作廢而不是真的刪除——多人同時操作時，
   * 真刪會讓後面的資料位移，改到別人的留言。
   */
  function removeComment(n) {
    const c = comments.find((x) => x.n === n);
    if (!c) return;
    if (c.sync === 'synced' && hasTransport()) {
      c.sync = 'pending';
      c.pendingOp = 'delete';
      save();
      render();
      pushDelete(c);
    } else {
      // 還沒送出去的直接從本機拿掉，後端根本沒有它
      comments = comments.filter((x) => x.n !== n);
      save();
      render();
    }
  }

  // 暫存格式版本：結構改變時遞增，舊資料自動作廢而不是混進來
  // v5：拿掉登入，純本機模式的留言直接記為已完成
  const SCHEMA = 5;

  // 用 localStorage 而非 sessionStorage：設計師標到一半接電話、
  // 切 App、關瀏覽器再回來，標註都還在。
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ schema: SCHEMA, seq, comments }));
    } catch (_) { /* 隱私模式或超額，放棄持久化即可 */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      // 舊版留下的資料（含畫記 strokes）結構不同，直接丟棄免得混淆
      if (data.schema !== SCHEMA) { localStorage.removeItem(STORAGE_KEY); return; }
      comments = data.comments || [];
      seq = data.seq || comments.length;
    } catch (_) { /* 壞掉就當作沒有 */ }
  }

  // ══════════════════════════════════════════════════════════════
  // Pin
  // ══════════════════════════════════════════════════════════════

  let pins = [];
  let marks = [];

  /**
   * 標註的位置以「元素現在在哪」為準，不是留言當下的座標。
   * 頁面捲動、動畫、RWD 換行都會讓元素移動，釘死座標會對不上。
   * 找不到元素時（頁面改版、動態內容還沒載入）退回原始座標。
   */
  function locate(c) {
    if (c.element?.selector) {
      try {
        const el = document.querySelector(c.element.selector);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width || r.height) {
            return {
              found: true,
              x: r.left + scrollX, y: r.top + scrollY,
              w: r.width, h: r.height,
            };
          }
        }
      } catch (_) { /* 選擇器語法在極少數情況會拋錯，當作找不到 */ }
    }
    return { found: false, x: c.anchor.x, y: c.anchor.y, w: 0, h: 0 };
  }

  /**
   * badge 掛在標註框的左上角，尖角要指進框裡，不是指向框外的空處。
   *
   * 尖角做在 badge 的右下角（border-radius 第三個值），
   * 所以把 badge 整個往左上推，右下角就會壓在框的左上角上。
   * 推的量是「整個 badge 的寬高，減掉要壓進框裡的深度，再補回框的外擴量」。
   * 靠邊時往內收，避免 badge 被畫面切掉。
   */
  const MARK_OFFSET = 2;   // .dcmt-mark 的 outline-offset
  const PIN_OVERLAP = 8;   // badge 壓在框線上的深度，讓它看起來咬住邊角

  function placePin(pin, pos) {
    // 手機的 badge 是 30px、桌機 28px，用實際尺寸算才不會兩邊都差一點
    const size = pin.offsetWidth || 28;
    const x = pos.x - MARK_OFFSET - size + PIN_OVERLAP;
    const y = pos.y - MARK_OFFSET - size + PIN_OVERLAP;
    pin.style.left = Math.max(2, x) + 'px';
    pin.style.top = Math.max(2, y) + 'px';
  }

  function render() {
    pins.forEach((p) => p.remove());
    marks.forEach((m) => m.remove());
    pins = [];
    marks = [];

    comments.forEach((c) => {
      const pos = locate(c);

      // 元素還在頁面上，就框出來讓人一眼看到「這裡標過了」
      if (pos.found) {
        const mark = document.createElement('div');
        mark.className = 'dcmt-mark';
        mark._n = c.n;
        mark.style.left = pos.x + 'px';
        mark.style.top = pos.y + 'px';
        mark.style.width = pos.w + 'px';
        mark.style.height = pos.h + 'px';
        document.body.appendChild(mark);
        marks.push(mark);
      }

      const pin = document.createElement('div');
      pin.className = 'dcmt-pin';
      pin._n = c.n;
      pin.textContent = c.n;
      pin.dataset.lost = pos.found ? '0' : '1';
      // 空心＝還沒送達。轉圈表示正在送，不轉表示等重試。
      if (c.sync === 'pending') pin.dataset.pending = '1';
      else if (c.sync === 'failed') pin.dataset.pending = 'failed';
      pin.title = c.note + (c.sync !== 'synced' ? `（${SYNC_LABEL[c.sync] || ''}）` : '');
      pin.onclick = (e) => { e.stopPropagation(); openRead(c); };
      // 先進 DOM 才量得到實際尺寸（手機 30px／桌機 28px），再定位
      document.body.appendChild(pin);
      placePin(pin, pos);
      pins.push(pin);
    });

    updateFab();
    if (listEl) renderList();
  }

  /** 元素會隨捲動、動畫、視窗變化而移動，標記要跟著重新定位 */
  let repositionTimer = null;
  function scheduleReposition() {
    if (repositionTimer) return;
    repositionTimer = requestAnimationFrame(() => {
      repositionTimer = null;
      comments.forEach((c, i) => {
        const pos = locate(c);
        const pin = pins[i];
        if (pin) placePin(pin, pos);
        const mark = marks.find((m) => m._n === c.n);
        if (mark && pos.found) {
          mark.style.left = pos.x + 'px';
          mark.style.top = pos.y + 'px';
          mark.style.width = pos.w + 'px';
          mark.style.height = pos.h + 'px';
        }
      });
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 清單
  // ══════════════════════════════════════════════════════════════

  let listEl = null;

  function toggleList() {
    if (listEl) { listEl.remove(); listEl = null; return; }
    listEl = document.createElement('div');
    listEl.className = 'dcmt-list';
    document.body.appendChild(listEl);
    renderList();
  }

  function renderList() {
    if (!listEl) return;
    if (!comments.length) {
      listEl.innerHTML = '<div class="dcmt-empty">還沒有留言</div>';
      return;
    }
    listEl.innerHTML = comments.map((c) => `
      <div class="dcmt-item" data-n="${c.n}" data-s="${esc(c.sync || 'synced')}">
        <div class="dcmt-item-n">${c.n}</div>
        <div class="dcmt-item-body">
          <div>${esc(c.note)}</div>
          <div class="dcmt-item-sel">
            ${c.sync && c.sync !== 'synced'
              ? `<span class="dcmt-sync" data-s="${esc(c.sync)}">${esc(SYNC_LABEL[c.sync] || '')}</span> · `
              : ''}
            <span class="dcmt-bp">${esc(c.device?.breakpointLabel || '')} ${c.device?.viewport?.w || ''}px</span>
            · ${esc(c.element ? c.element.selector : '')}</div>
        </div>
        <button class="dcmt-del" data-del="${c.n}" type="button" title="刪除">×</button>
      </div>`).join('');

    listEl.querySelectorAll('.dcmt-del').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); removeComment(Number(b.dataset.del)); };
    });
    // 點清單項目捲到該留言的位置（Figma 也是這個行為）
    listEl.querySelectorAll('.dcmt-item').forEach((row) => {
      row.onclick = () => {
        const c = comments.find((x) => x.n === Number(row.dataset.n));
        if (!c) return;
        scrollTo({ top: Math.max(0, c.anchor.y - innerHeight / 2), behavior: 'smooth' });
        setTimeout(() => openRead(c), 380);
      };
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 送出
  // ══════════════════════════════════════════════════════════════

  /**
   * 每則留言送出去長什麼樣。這個形狀是對外承諾，
   * onSubmit 拿到的、POST 出去的、匯出 JSON 的都是它，不會有第二種。
   */
  function toPublic(c) {
    return {
      id: c.uid,          // 唯一編號，改與刪都靠它認人
      n: c.n,             // 畫面上看到的編號，同一頁內從 1 開始
      note: c.note,       // 留言內容
      element: c.element, // 選擇器、標籤、文字、位置、字級顏色
      anchor: c.anchor,   // 點擊當下的頁面座標
      device: c.device,   // 斷點、視窗、螢幕、瀏覽器、作業系統
      at: c.at,           // ISO 時間
    };
  }

  /** 送出時附上的頁面資訊，三種 action 都會帶 */
  function pageInfo() {
    return {
      url: location.href.replace(/[?&]comment=1/, ''),
      path: location.pathname,
      title: document.title,
    };
  }

  /**
   * 內建的 HTTP transport：有設 data-endpoint 時用它。
   * 收到非 2xx 就當失敗，之後自動重試。
   */
  async function httpSubmit(payload) {
    const res = await fetch(CONFIG.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json().catch(() => ({}));
  }

  /**
   * 送出的唯一出口。三條路：自訂 onSubmit → 內建 HTTP → 純本機。
   * 純本機時直接 resolve，pin 立刻變實心，不會有轉圈或重試。
   */
  async function submit(payload) {
    if (typeof api.onSubmit === 'function') return api.onSubmit(payload);
    if (CONFIG.endpoint) return httpSubmit(payload);
    return null; // 純本機模式：存在瀏覽器就算完成
  }

  /** 送出結果統一收在這：成功標 synced，失敗標 failed 等重試 */
  function settle(c, ok) {
    if (ok) {
      if (c.pendingOp === 'delete') {
        comments = comments.filter((x) => x.n !== c.n);
      } else {
        c.sync = 'synced';
        c.pendingOp = null;
      }
    } else {
      c.sync = 'failed';
    }
    save();
    render();
  }

  async function push(c, payload) {
    try {
      await submit({ project: CONFIG.project, page: pageInfo(), ...payload });
      settle(c, true);
    } catch (err) {
      console.warn('[markoff] 送出失敗，稍後重試', err);
      settle(c, false);
    }
  }

  const pushCreate = (c) => push(c, { action: 'create', comment: toPublic(c) });
  const pushUpdate = (c) => push(c, { action: 'update', id: c.uid, note: c.note });
  const pushDelete = (c) => push(c, { action: 'delete', id: c.uid });

  /**
   * 把所有沒送成功的重送一次。
   * 三個時機會叫它：網路恢復、分頁切回前景、頁面載入。
   * 逐則序列送而非併發：後端多半要先找到是哪一列才改得動，
   * 併發會讀到彼此改到一半的狀態。
   */
  let flushing = false;
  let flushFailures = 0;
  async function flushPending() {
    if (flushing || !hasTransport()) return;
    const queue = comments.filter((c) => c.sync === 'failed' || c.sync === 'pending');
    if (!queue.length) { flushFailures = 0; return; }

    flushing = true;
    try {
      for (const c of queue) {
        // 迴圈跑到一半可能已經被刪掉（她手動刪了待送的那則）
        if (!comments.includes(c)) continue;
        c.sync = 'pending';
        render();
        if (c.pendingOp === 'delete') await pushDelete(c);
        else if (c.pendingOp === 'update') await pushUpdate(c);
        else await pushCreate(c);
      }
    } finally {
      flushing = false;
    }

    // 連續三輪都送不出去，多半不是暫時的網路問題。
    // 給她一條把標註帶走的路，別讓一下午的工作卡在這裡。
    const stillStuck = comments.some((c) => c.sync === 'failed');
    flushFailures = stillStuck ? flushFailures + 1 : 0;
    if (flushFailures >= 3) {
      flushFailures = 0;
      if (confirm('留言一直送不出去，可能是服務暫時不通。\n\n要先下載成檔案備份嗎？（留言不會消失，之後還會繼續嘗試）')) {
        exportJson();
      }
    }
  }

  /**
   * 把標註存成檔案帶走。純本機模式下這是唯一出口，按鈕常駐；
   * 有後端時它只是備份，重試連續失敗才會主動問要不要下載。
   */
  function exportJson() {
    if (!comments.length) { alert('還沒有任何留言'); return; }
    const payload = {
      _format: 'markoff/v1',
      page: {
        url: location.href.replace(/[?&]comment=1/, ''),
        path: location.pathname,
        title: document.title,
      },
      env: {
        exportedFrom: deviceContext(),
        userAgent: navigator.userAgent,
        exportedAt: new Date().toISOString(),
        // 這批留言涵蓋哪些斷點：前端一眼看出是單一裝置的問題還是通案
        breakpointsCovered: [...new Set(
          comments.map((c) => c.device?.breakpointLabel).filter(Boolean)
        )],
      },
      comments: comments.map(toPublic),
    };

    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const slug = location.pathname.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'index';
    const name = `markoff_${slug}_${stamp}.json`;
    const text = JSON.stringify(payload, null, 2);

    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ══════════════════════════════════════════════════════════════
  // 浮動按鈕
  // ══════════════════════════════════════════════════════════════

  // 沒有「送出」鈕：按下留言就已經送出去了。
  // dcmt-retry 只在有東西沒送成功時才出現；純本機模式下永遠不會。
  // dcmt-export 反過來——純本機模式下它是留言唯一的出口，一有留言就常駐。
  const fab = document.createElement('div');
  fab.className = 'dcmt-fab';
  fab.innerHTML = `
    <button class="dcmt-btn dcmt-ghost dcmt-export" type="button" style="display:none">匯出</button>
    <button class="dcmt-btn dcmt-ghost dcmt-list-btn" type="button" style="display:none">
      清單 <b class="dcmt-num">0</b></button>
    <button class="dcmt-btn dcmt-ghost dcmt-retry" type="button" style="display:none"></button>
    <button class="dcmt-btn dcmt-toggle" type="button">留言</button>`;
  document.body.appendChild(fab);

  const btnToggle = fab.querySelector('.dcmt-toggle');
  const btnList = fab.querySelector('.dcmt-list-btn');
  const btnRetry = fab.querySelector('.dcmt-retry');
  const btnExport = fab.querySelector('.dcmt-export');

  function setActive(next) {
    active = next;
    btnToggle.dataset.on = active ? '1' : '0';
    btnToggle.textContent = active ? '✓ 留言中' : '留言';
    if (!active) { hl.style.display = 'none'; closeBubble(); }
    updateFab();
  }

  function updateFab() {
    fab.querySelector('.dcmt-num').textContent = comments.length;
    btnList.style.display = comments.length ? '' : 'none';

    // 有東西沒送成功才顯示重試鈕。一切正常時不需要看到任何送出相關的東西。
    const stuck = comments.filter((c) => c.sync === 'failed').length;
    btnRetry.style.display = stuck ? '' : 'none';
    if (stuck) btnRetry.textContent = `${stuck} 則待送，點此重試`;

    // 純本機模式：匯出是唯一出口，一有留言就顯示。
    // 有後端時留言已經在伺服器上了，匯出只是備份，不佔畫面。
    btnExport.style.display = (comments.length && !hasTransport()) ? '' : 'none';

    if (!comments.length && listEl) toggleList();
  }

  btnToggle.onclick = () => setActive(!active);
  btnList.onclick = toggleList;
  btnRetry.onclick = flushPending;
  btnExport.onclick = exportJson;

  /**
   * 頁面自己可能有貼底的固定元素（訂閱 bar、cookie 提示、浮動 CTA）。
   * 按鈕疊上去會互相誤觸，所以量出它們的高度後把自己往上抬。
   * 靠 computed position 判斷，不綁任何專案的 class 名稱。
   */
  function avoidBottomFurniture() {
    let maxH = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (isOurs(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0 || r.width === 0) continue;
      const gapFromBottom = innerHeight - r.bottom;
      if (gapFromBottom > 8 || r.top > innerHeight) continue;
      if (r.height > innerHeight * 0.5) continue; // 半屏以上多半是遮罩，不是列
      maxH = Math.max(maxH, r.height);
    }
    const base = innerWidth <= 640 ? 12 : 16;
    document.documentElement.style.setProperty(
      '--dcmt-bottom', (maxH > 0 ? maxH + base + 6 : base) + 'px'
    );
  }

  // ── 啟動 ────────────────────────────────────────────────────────
  let avoidTimer = null;
  const scheduleAvoid = () => {
    if (avoidTimer) return;
    avoidTimer = setTimeout(() => { avoidTimer = null; avoidBottomFurniture(); }, 250);
  };
  addEventListener('resize', () => { scheduleAvoid(); scheduleReposition(); });
  addEventListener('scroll', () => { scheduleAvoid(); scheduleReposition(); }, { passive: true });
  new MutationObserver(() => { scheduleAvoid(); scheduleReposition(); }).observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'],
  });

  // 版面變動（圖片載入、字型套用、輪播換頁）會讓元素位置整批改變
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(scheduleReposition);
    ro.observe(document.body);
  }
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBubble(); });

  // modal 開著時由遮罩接收所有頁面點擊（見 mountBubble），
  // 這裡只負責避免遮罩關閉後的同一次點擊又開一個新 modal。
  document.addEventListener('pointerdown', (e) => {
    if (bubble && e.target.classList?.contains('dcmt-scrim')) swallowNextClick = true;
  }, true);

  // 網路回來就把待送的補上。她不用知道自己剛才斷線過。
  addEventListener('online', flushPending);

  // 分頁切回前景時也補一次：手機切 App 期間常常斷線又復原，
  // 而背景分頁的 online 事件不一定送得到。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flushPending();
  });

  // 還有東西沒送出去就攔一下。理論上重試機制會處理掉，
  // 但關掉分頁就沒有下次了——這是最後一道防線。
  addEventListener('beforeunload', (e) => {
    if (comments.some((c) => c.sync === 'failed' || c.sync === 'pending')) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  load();
  avoidBottomFurniture();
  render();
  setActive(false);
  // 上次沒送成功的（關瀏覽器前斷網、服務暫時不通）在這裡補送
  flushPending();
  console.info('[markoff] 已啟動。按「留言」後點畫面任一處即可留下意見。'
    + (hasTransport() ? '' : '（純本機模式：留言存在瀏覽器，可匯出 JSON）'));
})();
