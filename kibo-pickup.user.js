// ==UserScript==
// @name         きぼうを見よう ピックアップツール
// @namespace    https://github.com/ichimura-eng/kibo-pickup-tool
// @version      0.2.6
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
    scrollStepRatio: 0.85, // 1回のスクロール量（画面の高さに対する割合）。Xの仮想リスト対策で一気に最下部までは飛ばさない
    stableRoundsToFinish: 6, // 「最下部に到達していて、新規投稿もない」状態が何回続いたら完了とみなすか
    hardTimeoutMs: 180000, // 念のための最大タイムアウト（3分）
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
    // datetime属性（ISO8601）を投稿日時として保持しておく。
    // スプレッドシートには「下の行ほど最新」の並びで貼り付けたいため、
    // コピー時にこれで古い順に並び替える
    const datetime = timeEl.getAttribute('datetime') || '';
    return { url: `https://x.com${href}`, id: href.match(/\/status\/(\d+)/)[1], datetime };
  }

  function extractImageUrl(container) {
    // X側の実装差異（<img>のsrcで持つ場合と、background-imageで持つ場合の両方）に対応
    const img = container.querySelector('img[src]');
    if (img && img.src) return img.src;
    const bgCandidates = container.querySelectorAll('[style*="background-image"]');
    for (const el of bgCandidates) {
      const m = (el.style.backgroundImage || '').match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1]) return m[1];
    }
    return '';
  }

  function extractVideoThumb(video) {
    const videoTag = video.querySelector('video[poster]');
    if (videoTag) {
      const poster = videoTag.getAttribute('poster');
      if (poster) return poster;
    }
    return extractImageUrl(video);
  }

  function extractMedia(article) {
    // 1件の投稿に画像・動画が複数付いている場合があるため、まず全件数を数える
    // （「複数枚あるのに1件だけの投稿に見える」問題に気づけるようにするため）。
    // 取得できた画像・動画サムネイルのURLは全部thumbsに集めておき、
    // 一覧側でマウスオーバー中に切り替え表示するのに使う
    const photoDivs = Array.from(article.querySelectorAll(CONFIG.selectors.tweetPhoto));
    const videoDiv = article.querySelector(CONFIG.selectors.videoPlayer);
    const count = photoDivs.length + (videoDiv ? 1 : 0);
    if (count === 0) return null;

    const type = videoDiv ? 'video' : 'photo';
    const thumbs = [];
    if (videoDiv) {
      const t = extractVideoThumb(videoDiv);
      if (t) thumbs.push(t);
    }
    photoDivs.forEach((div) => {
      const url = extractImageUrl(div);
      if (url) thumbs.push(url);
    });
    return { type, thumb: thumbs[0] || '', count, thumbs };
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
        datetime: permalink.datetime,
        type: media.type,
        thumb: media.thumb,
        count: media.count,
        thumbs: media.thumbs,
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
      width: 440px;
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
    #kibo-pickup-panel input[type="date"] { cursor: pointer; }
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
      grid-template-columns: repeat(2, 1fr);
      gap: 8px;
    }
    #kibo-pickup-panel .kp-card {
      position: relative;
      border-radius: 8px;
      overflow: hidden;
      cursor: pointer;
      background: #1e2226;
      border: 2px solid transparent;
      display: flex;
      flex-direction: column;
    }
    #kibo-pickup-panel .kp-card.kp-selected { border-color: #1d9bf0; }
    #kibo-pickup-panel .kp-thumb {
      position: relative;
      aspect-ratio: 4 / 3;
      overflow: hidden;
      background: #1e2226;
      flex-shrink: 0;
    }
    #kibo-pickup-panel .kp-thumb.kp-no-thumb {
      background: #2f3336;
      display: flex; align-items: center; justify-content: center;
    }
    #kibo-pickup-panel .kp-thumb.kp-no-thumb::after {
      content: 'サムネイル取得失敗\A 右下のリンクから元投稿を確認できます';
      white-space: pre-wrap;
      text-align: center;
      font-size: 10px; color: #8b98a5;
      padding: 0 8px;
    }
    #kibo-pickup-panel .kp-thumb img,
    #kibo-pickup-panel .kp-thumb video {
      position: absolute; inset: 0; z-index: 1;
      width: 100%; height: 100%; object-fit: cover; display: block;
    }
    /* kp-multi / kp-play は操作できない「ラベル」。
       操作できる丸ボタン(kp-check / kp-open)と見た目で区別するため、
       円形・白枠は使わず、平たい角丸タグの見た目にする */
    #kibo-pickup-panel .kp-multi,
    #kibo-pickup-panel .kp-play {
      position: absolute; z-index: 3;
      background: rgba(0,0,0,0.6);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 10px; color: #d7dbdc; pointer-events: none;
      line-height: 1.4;
    }
    #kibo-pickup-panel .kp-multi { bottom: 4px; left: 4px; }
    #kibo-pickup-panel .kp-play { top: 4px; left: 4px; }
    #kibo-pickup-panel .kp-check {
      position: absolute; top: 4px; right: 4px; z-index: 3;
      width: 22px; height: 22px; border-radius: 50%;
      background: rgba(0,0,0,0.55); border: 1.5px solid #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; color: #fff;
    }
    #kibo-pickup-panel .kp-card.kp-selected .kp-check {
      background: #1d9bf0; border-color: #1d9bf0;
    }
    #kibo-pickup-panel .kp-open {
      position: absolute; bottom: 4px; right: 4px; z-index: 3;
      background: rgba(0,0,0,0.55); border-radius: 50%;
      width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
      font-size: 12px; color: #fff; text-decoration: none;
    }
    #kibo-pickup-panel .kp-open:hover { background: rgba(29,155,240,0.85); }
    /* キャプションはサムネイル画像に重ねず、下に別枠で全文表示する
       （画像に重ねると動画のクリック操作を邪魔してしまうため） */
    #kibo-pickup-panel .kp-caption {
      background: #1e2226;
      color: #d7dbdc; font-size: 11px; line-height: 1.4;
      padding: 6px 8px;
      word-break: break-word;
      white-space: pre-wrap;
    }
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

    // 日付欄は「年/月/日」を個別に打つ操作が分かりにくいという指摘があったため、
    // どこをクリックしてもカレンダーが開く形に統一する（対応ブラウザのみ）
    ['kp-since', 'kp-until'].forEach((id) => {
      const el = bodyEl.querySelector('#' + id);
      el.addEventListener('click', () => {
        if (typeof el.showPicker === 'function') {
          try {
            el.showPicker();
          } catch (e) {
            // ユーザー操作外からの呼び出しなど、失敗しても通常入力にフォールバックするだけなので無視
          }
        }
      });
    });

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
      }

      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 100;
      const loading = !!document.querySelector(CONFIG.selectors.progressBar);

      if (found.length === 0 && atBottom && !loading) {
        // 最下部まで到達していて、新規投稿もロード中表示もない → 完了に近づいている
        stableRounds += 1;
      } else {
        // 新規投稿が見つかった場合はもちろん、
        // 「まだ最下部に到達していない」「ロード中」の場合も完了カウントしない
        // （仮想リストで一部がまだ描画されていないだけの可能性があるため）
        stableRounds = 0;
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
      // Xのタイムラインは仮想リスト（画面付近だけ描画・離れると消える）のため、
      // 一気に最下部までジャンプすると間の投稿が描画されずに読み飛ばされる。
      // そのため画面の高さの何割かずつ、少しずつ進める。
      window.scrollBy(0, Math.round(window.innerHeight * CONFIG.scrollStepRatio));
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
      // カード = サムネイル（画像・動画）＋ その下の本文キャプション、という2段構成。
      // 本文を画像に重ねると動画のクリック操作を邪魔するため、あえて分離している。
      const card = document.createElement('div');
      card.className = 'kp-card';
      card.dataset.id = item.id;

      const thumb = document.createElement('div');
      thumb.className = 'kp-thumb';
      card.appendChild(thumb);

      const img = document.createElement('img');
      img.loading = 'lazy';
      if (item.thumb) {
        img.src = item.thumb;
      } else {
        // サムネイル画像を取得できなかった場合、真っ黒に見えないようプレースホルダー表示にする
        thumb.classList.add('kp-no-thumb');
      }
      thumb.appendChild(img);

      if (item.type === 'video') {
        // ボタンに見えないよう、記号(▶)ではなくテキストのラベルにする
        const play = document.createElement('div');
        play.className = 'kp-play';
        play.textContent = '動画';
        thumb.appendChild(play);
      }

      if (item.count > 1) {
        // 複数枚（画像複数、または画像+動画の組み合わせ）の投稿であることが
        // サムネイル1枚だけでは分からないため、件数バッジを付ける
        const multi = document.createElement('div');
        multi.className = 'kp-multi';
        multi.textContent = `複数(${item.count})`;
        thumb.appendChild(multi);
      }

      // 以前はマウスオーバーでX公式の埋め込み(iframe)を表示していたが、
      // X.com自身のCSP(セキュリティポリシー)で外部埋め込みがブロックされ、
      // 壊れた表示になることが判明したため撤去。
      // 代わりに、複数枚取得できている場合はマウスオーバー中にサムネイルを
      // 自動で切り替え表示する（外部埋め込み不要・CSPの影響を受けない）
      if (item.thumbs && item.thumbs.length > 1) {
        let cycleTimer = null;
        let idx = 0;
        thumb.addEventListener('mouseenter', () => {
          cycleTimer = setInterval(() => {
            idx = (idx + 1) % item.thumbs.length;
            img.src = item.thumbs[idx];
          }, 700);
        });
        thumb.addEventListener('mouseleave', () => {
          clearInterval(cycleTimer);
          idx = 0;
          img.src = item.thumbs[0];
        });
      }

      // 動画本体の再生や、取得できなかった画像の確認は元のツイートを
      // 開いてもらうのが一番確実なので、リンクを常に付けておく
      const openLink = document.createElement('a');
      openLink.className = 'kp-open';
      openLink.href = item.url;
      openLink.target = '_blank';
      openLink.rel = 'noopener noreferrer';
      openLink.title = '元のツイートを開く';
      openLink.textContent = '↗';
      openLink.addEventListener('click', (e) => {
        // カード全体のクリック(選択トグル)には巻き込まない
        e.stopPropagation();
      });
      thumb.appendChild(openLink);

      // 未選択時は空の丸枠のみ表示し、選択時にだけ✓を入れる
      // （常に✓を表示すると「全部チェック済み」に見えてしまうため）
      const check = document.createElement('div');
      check.className = 'kp-check';
      thumb.appendChild(check);

      if (item.text) {
        const caption = document.createElement('div');
        caption.className = 'kp-caption';
        caption.textContent = item.text; // 省略せず全文表示する
        card.appendChild(caption);
      }

      card.addEventListener('click', () => {
        if (selected.has(item.id)) {
          selected.delete(item.id);
          card.classList.remove('kp-selected');
          check.textContent = '';
        } else {
          selected.add(item.id);
          card.classList.add('kp-selected');
          check.textContent = '✓';
        }
        updateFooter();
      });

      grid.appendChild(card);
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
        // スプレッドシートは「下の行ほど最新の投稿」の並びのため、
        // コピーするURLも古い日付順（昇順）に並び替えてから渡す
        const urls = items
          .filter((i) => selected.has(i.id))
          .sort((a, b) => (a.datetime || '').localeCompare(b.datetime || ''))
          .map((i) => i.url);
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
