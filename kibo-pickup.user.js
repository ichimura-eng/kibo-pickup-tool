// ==UserScript==
// @name         きぼうを見よう ピックアップツール
// @namespace    https://github.com/ichimura-eng/kibo-pickup-tool
// @version      0.1.0
// @description  「#きぼうを見よう」のX投稿を期間指定で収集し、画像・動画付きの投稿だけをサムネイル一覧で確認してURLをまとめてコピーできるツール
// @author       ichimura-eng
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/ichimura-eng/kibo-pickup-tool/main/kibo-pickup.user.js
// @downloadURL  https://raw.githubusercontent.com/ichimura-eng/kibo-pickup-tool/main/kibo-pickup.user.js
// ==/UserScript==

/*
 * 壊れたときの調査メモ（保守担当向け）
 * ---------------------------------------------------
 * このスクリプトはXの内部DOM構造（data-testid属性）に依存しています。
 * Xの仕様変更で動かなくなった場合は、まず以下のセレクタが現在も存在するか
 * ブラウザの検証ツール（Elements）で確認してください。
 *
 *   - ツイート本体          : article[data-testid="tweet"]
 *   - ツイート本文          : [data-testid="tweetText"]
 *   - 画像                  : [data-testid="tweetPhoto"] 内の img
 *   - 動画プレイヤー        : [data-testid="videoPlayer"]
 *   - ログイン済み判定      : [data-testid="SideNav_AccountSwitcher_Button"]
 *
 * data-testid が変わっていたら、CONFIG.selectors を新しい値に書き換えれば
 * 大部分は復旧するはず。
 */

(function () {
  'use strict';

  // =========================================================
  // 設定
  // =========================================================
  const CONFIG = {
    defaultHashtag: '#きぼうを見よう',
    maxRangeDays: 31, // 収集の安定性のため期間は最大1ヶ月程度に制限
    scrollIntervalMs: 1200, // 自動スクロールの間隔
    stableRoundsToFinish: 6, // 新規投稿が増えない状態が何回続いたら完了とみなすか
    hardTimeoutMs: 120000, // 念のための最大タイムアウト（2分）
    stateKey: 'kibo_pickup_pending_search',
    selectors: {
      tweetArticle: 'article[data-testid="tweet"]',
      tweetText: '[data-testid="tweetText"]',
      tweetPhoto: '[data-testid="tweetPhoto"]',
      videoPlayer: '[data-testid="videoPlayer"]',
      loggedInMarker: '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"]',
      progressBar: '[role="progressbar"]',
    },
  };

  // =========================================================
  // ユーティリティ
  // =========================================================
  function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function todayStr() {
    return formatDate(new Date());
  }

  function addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return formatDate(d);
  }

  function daysBetween(a, b) {
    const d1 = new Date(a + 'T00:00:00');
    const d2 = new Date(b + 'T00:00:00');
    return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  }

  function buildSearchUrl(hashtag, since, until) {
    // until: は「その日の0時より前」を意味するため、指定した終了日を
    // 含めるために1日足す
    const untilExclusive = addDays(until, 1);
    const query = `${hashtag} since:${since} until:${untilExclusive}`;
    const params = new URLSearchParams({ q: query, src: 'typed_query', f: 'live' });
    return `https://x.com/search?${params.toString()}`;
  }

  function copyText(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text, 'text');
      return Promise.resolve();
    }
    return navigator.clipboard.writeText(text);
  }

  function isLoggedIn() {
    return !!document.querySelector(CONFIG.selectors.loggedInMarker);
  }

  function isPromotedTweet(article) {
    const t = article.innerText || '';
    return t.includes('プロモーション') || /(^|\s)Promoted(\s|$)/.test(t);
  }

  function getTweetPermalink(article) {
    const timeEl = article.querySelector('time');
    if (!timeEl) return null;
    const link = timeEl.closest('a');
    if (!link) return null;
    const href = link.getAttribute('href');
    if (!href || !/\/status\/\d+/.test(href)) return null;
    return { url: `https://x.com${href}`, id: href.match(/\/status\/(\d+)/)[1] };
  }

  function extractMedia(article) {
    const video = article.querySelector(CONFIG.selectors.videoPlayer);
    if (video) {
      const videoTag = video.querySelector('video');
      const posterImg = video.querySelector('img');
      const thumb = (videoTag && videoTag.getAttribute('poster')) || (posterImg && posterImg.src) || '';
      return { type: 'video', thumb };
    }
    const photoDiv = article.querySelector(CONFIG.selectors.tweetPhoto);
    if (photoDiv) {
      const img = photoDiv.querySelector('img');
      return { type: 'photo', thumb: img ? img.src : '' };
    }
    return null;
  }

  function extractText(article) {
    const el = article.querySelector(CONFIG.selectors.tweetText);
    return el ? el.innerText.trim() : '';
  }

  function collectVisibleTweets(seenIds) {
    const found = [];
    document.querySelectorAll(CONFIG.selectors.tweetArticle).forEach((article) => {
      const permalink = getTweetPermalink(article);
      if (!permalink || seenIds.has(permalink.id)) return;
      if (isPromotedTweet(article)) return;
      const media = extractMedia(article);
      if (!media) return; // 画像・動画が付いていない投稿は対象外
      found.push({
        id: permalink.id,
        url: permalink.url,
        type: media.type,
        thumb: media.thumb,
        text: extractText(article),
      });
    });
    return found;
  }

  // =========================================================
  // スタイル
  // =========================================================
  GM_addStyle(`
    #kibo-pickup-panel {
      position: fixed;
      top: 12px;
      right: 12px;
      width: 360px;
      max-height: 92vh;
      background: #15181c;
      color: #e7e9ea;
      border: 1px solid #38444d;
      border-radius: 12px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
      font-size: 13px;
      display: flex;
      flex-direction: column;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    }
    #kibo-pickup-panel * { box-sizing: border-box; }
    #kibo-pickup-panel .kp-header {
      padding: 10px 12px;
      border-bottom: 1px solid #2f3336;
      font-weight: bold;
      font-size: 14px;
    }
    #kibo-pickup-panel .kp-body {
      padding: 10px 12px;
      overflow-y: auto;
      flex: 1;
    }
    #kibo-pickup-panel .kp-row {
      display: flex;
      gap: 6px;
      align-items: center;
      margin-bottom: 8px;
    }
    #kibo-pickup-panel label { font-size: 11px; color: #8b98a5; display: block; margin-bottom: 2px; }
    #kibo-pickup-panel input[type="text"],
    #kibo-pickup-panel input[type="date"] {
      background: #1e2226;
      border: 1px solid #38444d;
      color: #e7e9ea;
      border-radius: 6px;
      padding: 6px;
      width: 100%;
      font-size: 12px;
    }
    #kibo-pickup-panel button {
      background: #1d9bf0;
      color: #fff;
      border: none;
      border-radius: 999px;
      padding: 7px 14px;
      font-size: 12px;
      font-weight: bold;
      cursor: pointer;
    }
    #kibo-pickup-panel button.kp-secondary {
      background: transparent;
      border: 1px solid #536471;
      color: #e7e9ea;
    }
    #kibo-pickup-panel button:disabled { opacity: 0.5; cursor: default; }
    #kibo-pickup-panel .kp-status { font-size: 12px; color: #8b98a5; margin: 6px 0; }
    #kibo-pickup-panel .kp-warn {
      background: #4a2b0c; color: #ffcf8b; border: 1px solid #7a4a12;
      border-radius: 6px; padding: 8px; font-size: 12px; margin-bottom: 8px;
    }
    #kibo-pickup-panel .kp-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
    }
    #kibo-pickup-panel .kp-thumb {
      position: relative;
      aspect-ratio: 1 / 1;
      border-radius: 6px;
      overflow: hidden;
      cursor: pointer;
      background: #1e2226;
      border: 2px solid transparent;
    }
    #kibo-pickup-panel .kp-thumb.kp-selected { border-color: #1d9bf0; }
    #kibo-pickup-panel .kp-thumb img,
    #kibo-pickup-panel .kp-thumb video {
      width: 100%; height: 100%; object-fit: cover; display: block;
    }
    #kibo-pickup-panel .kp-thumb iframe {
      width: 100%; height: 100%; border: 0; display: block; background: #000;
    }
    #kibo-pickup-panel .kp-check {
      position: absolute; top: 4px; right: 4px;
      width: 20px; height: 20px; border-radius: 50%;
      background: rgba(0,0,0,0.55); border: 1.5px solid #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; color: #fff;
    }
    #kibo-pickup-panel .kp-thumb.kp-selected .kp-check {
      background: #1d9bf0; border-color: #1d9bf0;
    }
    #kibo-pickup-panel .kp-play {
      position: absolute; top: 4px; left: 4px;
      background: rgba(0,0,0,0.55); border-radius: 50%;
      width: 20px; height: 20px; display: flex; align-items: center; justify-content: center;
      font-size: 10px; color: #fff; pointer-events: none;
    }
    #kibo-pickup-panel .kp-caption {
      position: absolute; left: 0; right: 0; bottom: 0;
      background: linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0));
      color: #fff; font-size: 10px; line-height: 1.3;
      padding: 10px 4px 4px;
      max-height: 100%;
      overflow: hidden;
      opacity: 0;
      transition: opacity 0.15s;
      pointer-events: none;
    }
    #kibo-pickup-panel .kp-thumb:hover .kp-caption { opacity: 1; }
    #kibo-pickup-panel .kp-footer {
      border-top: 1px solid #2f3336;
      padding: 10px 12px;
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px;
    }
    #kibo-pickup-panel .kp-minimize {
      background: transparent; border: none; color: #8b98a5; font-size: 14px; cursor: pointer; padding: 0 4px;
    }
    #kibo-pickup-panel.kp-collapsed .kp-body,
    #kibo-pickup-panel.kp-collapsed .kp-footer { display: none; }
  `);

  // =========================================================
  // パネルUI構築
  // =========================================================
  let panelEl = null;
  let bodyEl = null;
  let footerEl = null;

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.id = 'kibo-pickup-panel';
    panelEl.innerHTML = `
      <div class="kp-header">
        きぼうを見よう ピックアップツール
        <button class="kp-minimize" title="最小化/展開">▁</button>
      </div>
      <div class="kp-body"></div>
      <div class="kp-footer"></div>
    `;
    document.body.appendChild(panelEl);
    bodyEl = panelEl.querySelector('.kp-body');
    footerEl = panelEl.querySelector('.kp-footer');
    panelEl.querySelector('.kp-minimize').addEventListener('click', () => {
      panelEl.classList.toggle('kp-collapsed');
    });
    return panelEl;
  }

  function renderSearchForm() {
    ensurePanel();
    footerEl.innerHTML = '';
    const since = addDays(todayStr(), -6);
    const until = todayStr();
    bodyEl.innerHTML = `
      <div class="kp-row">
        <div style="flex:1">
          <label>ハッシュタグ</label>
          <input type="text" id="kp-hashtag" value="${CONFIG.defaultHashtag}">
        </div>
      </div>
      <div class="kp-row">
        <div style="flex:1">
          <label>開始日</label>
          <input type="date" id="kp-since" value="${since}">
        </div>
        <div style="flex:1">
          <label>終了日</label>
          <input type="date" id="kp-until" value="${until}">
        </div>
      </div>
      <div class="kp-row">
        <button id="kp-search-btn" style="width:100%">検索して収集開始</button>
      </div>
      <div class="kp-status">期間は最大${CONFIG.maxRangeDays}日程度までにしてください（収集の安定性のため）。</div>
    `;
    bodyEl.querySelector('#kp-search-btn').addEventListener('click', () => {
      const hashtag = bodyEl.querySelector('#kp-hashtag').value.trim() || CONFIG.defaultHashtag;
      const s = bodyEl.querySelector('#kp-since').value;
      const u = bodyEl.querySelector('#kp-until').value;
      if (!s || !u) {
        alert('開始日と終了日を入力してください。');
        return;
      }
      if (daysBetween(s, u) < 0) {
        alert('終了日は開始日以降にしてください。');
        return;
      }
      if (daysBetween(s, u) > CONFIG.maxRangeDays) {
        alert(`期間は最大${CONFIG.maxRangeDays}日程度にしてください。`);
        return;
      }
      GM_setValue(CONFIG.stateKey, JSON.stringify({ hashtag, since: s, until: u, autostart: true }));
      window.location.href = buildSearchUrl(hashtag, s, u);
    });
  }

  function renderWarning(message) {
    ensurePanel();
    bodyEl.innerHTML = `<div class="kp-warn">${message}</div>`;
    const backBtn = document.createElement('button');
    backBtn.className = 'kp-secondary';
    backBtn.textContent = '検索フォームに戻る';
    backBtn.addEventListener('click', renderSearchForm);
    bodyEl.appendChild(backBtn);
    footerEl.innerHTML = '';
  }

  // =========================================================
  // 収集フェーズ
  // =========================================================
  function startCollecting(hashtag, since, until) {
    ensurePanel();
    if (!isLoggedIn()) {
      renderWarning('Xにログインしてから実行してください。（ログイン状態を検知できませんでした）');
      return;
    }

    const seenIds = new Set();
    const items = []; // 収集順を保持
    let stableRounds = 0;
    let stopped = false;
    const startedAt = Date.now();

    function renderProgress() {
      bodyEl.innerHTML = `
        <div class="kp-status">
          期間: ${since} 〜 ${until}<br>
          収集中... 現在 <b>${items.length}</b> 件（画像・動画付きのみ）
        </div>
        <div class="kp-row">
          <button id="kp-stop-btn" class="kp-secondary" style="width:100%">収集をここで終了して確認する</button>
        </div>
      `;
      bodyEl.querySelector('#kp-stop-btn').addEventListener('click', finish);
      footerEl.innerHTML = '';
    }

    function tick() {
      if (stopped) return;

      const found = collectVisibleTweets(seenIds);
      if (found.length > 0) {
        found.forEach((f) => {
          seenIds.add(f.id);
          items.push(f);
        });
        stableRounds = 0;
      } else if (!document.querySelector(CONFIG.selectors.progressBar)) {
        stableRounds += 1;
      }
      renderProgress();

      if (stableRounds >= CONFIG.stableRoundsToFinish) {
        finish();
        return;
      }
      if (Date.now() - startedAt >= CONFIG.hardTimeoutMs) {
        finish();
        return;
      }
      window.scrollTo(0, document.body.scrollHeight);
      setTimeout(tick, CONFIG.scrollIntervalMs);
    }

    function finish() {
      stopped = true;
      GM_setValue(CONFIG.stateKey, '');
      renderResults(items, since, until);
    }

    renderProgress();
    setTimeout(tick, 300);
  }

  // =========================================================
  // 結果一覧（選定パネル）フェーズ
  // =========================================================
  function renderResults(items, since, until) {
    ensurePanel();
    const selected = new Set();

    bodyEl.innerHTML = `
      <div class="kp-status">
        期間: ${since} 〜 ${until} ／ 画像・動画付きの投稿のみ表示中（収集${items.length}件）
      </div>
      <div class="kp-grid" id="kp-grid"></div>
    `;
    const grid = bodyEl.querySelector('#kp-grid');

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'kp-status';
      empty.textContent = '該当する投稿が見つかりませんでした。期間を変えて再検索してください。';
      grid.appendChild(empty);
    }

    items.forEach((item) => {
      const cell = document.createElement('div');
      cell.className = 'kp-thumb';
      cell.dataset.id = item.id;

      const img = document.createElement('img');
      img.src = item.thumb || '';
      img.loading = 'lazy';
      cell.appendChild(img);

      if (item.type === 'video') {
        const play = document.createElement('div');
        play.className = 'kp-play';
        play.textContent = '▶';
        cell.appendChild(play);

        // マウスオーバーで埋め込み再生（X公式の埋め込みウィジェットを利用）
        let hoverTimer = null;
        cell.addEventListener('mouseenter', () => {
          hoverTimer = setTimeout(() => {
            if (cell.querySelector('iframe')) return;
            const iframe = document.createElement('iframe');
            iframe.src = `https://platform.twitter.com/embed/Tweet.html?id=${item.id}&theme=dark&hideCard=false&hideThread=true`;
            iframe.setAttribute('allow', 'autoplay; encrypted-media');
            img.style.display = 'none';
            cell.insertBefore(iframe, cell.firstChild);
          }, 250);
        });
        cell.addEventListener('mouseleave', () => {
          clearTimeout(hoverTimer);
          const iframe = cell.querySelector('iframe');
          if (iframe) {
            iframe.remove();
            img.style.display = '';
          }
        });
      }

      const check = document.createElement('div');
      check.className = 'kp-check';
      check.textContent = '✓';
      cell.appendChild(check);

      if (item.text) {
        const caption = document.createElement('div');
        caption.className = 'kp-caption';
        caption.textContent = item.text.length > 60 ? item.text.slice(0, 60) + '…' : item.text;
        cell.appendChild(caption);
      }

      cell.addEventListener('click', (e) => {
        // 動画再生中(iframe表示中)にクリックしても選択トグルは効かせる
        if (selected.has(item.id)) {
          selected.delete(item.id);
          cell.classList.remove('kp-selected');
        } else {
          selected.add(item.id);
          cell.classList.add('kp-selected');
        }
        updateFooter();
      });

      grid.appendChild(cell);
    });

    function updateFooter() {
      footerEl.innerHTML = `
        <span>選択中: <b>${selected.size}</b>件</span>
        <span style="display:flex; gap:6px;">
          <button class="kp-secondary" id="kp-reset-btn">やり直す</button>
          <button id="kp-copy-btn">選択したURLをコピー</button>
        </span>
      `;
      footerEl.querySelector('#kp-copy-btn').addEventListener('click', () => {
        const urls = items.filter((i) => selected.has(i.id)).map((i) => i.url);
        if (urls.length === 0) {
          alert('選択された投稿がありません。');
          return;
        }
        copyText(urls.join('\n')).then(() => {
          const btn = footerEl.querySelector('#kp-copy-btn');
          const original = btn.textContent;
          btn.textContent = 'コピーしました！';
          setTimeout(() => { btn.textContent = original; }, 1500);
        });
      });
      footerEl.querySelector('#kp-reset-btn').addEventListener('click', renderSearchForm);
    }

    updateFooter();
  }

  // =========================================================
  // 起動
  // =========================================================
  function init() {
    ensurePanel();
    let pending = null;
    try {
      const raw = GM_getValue(CONFIG.stateKey, '');
      pending = raw ? JSON.parse(raw) : null;
    } catch (e) {
      pending = null;
    }

    const onSearchPage = location.pathname === '/search';

    if (pending && pending.autostart && onSearchPage) {
      // 検索ページへの遷移後、自動で収集を開始する
      startCollecting(pending.hashtag, pending.since, pending.until);
    } else {
      renderSearchForm();
    }
  }

  // Xはページ内遷移(SPA)が多いため、DOM準備を少し待ってから初期化
  setTimeout(init, 500);
})();
