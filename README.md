# kibo-pickup-tool

「[きぼうを見よう](https://lookup.kibo.space/)」の「[みんなが見たきぼう](https://lookup.kibo.space/posts/)」ページ更新作業を効率化するTampermonkeyユーザースクリプトです。

Xで「#きぼうを見よう」を期間指定で検索し、画像・動画が付いた投稿だけをサムネイル一覧で確認 → 採用したい投稿にチェック → URLをまとめてコピーできます。コピーしたURLは[スプレッドシート「きぼうを見ようTweet更新」](https://docs.google.com/spreadsheets/d/1xRaBhaAE0zZYqpchysRTzXNMTDdZODJKC7rDhqvLPIM/edit?gid=0#gid=0)のURL列に貼り付けて使います。

## 初回セットアップ

1. [Tampermonkey](https://www.tampermonkey.net/)をブラウザにインストールする（Chrome Web Storeで「Chromeに追加」）
2. 以下のリンクを開く → Tampermonkeyが「インストールしますか？」と聞いてくるので「インストール」をクリック
   - https://raw.githubusercontent.com/ichimura-eng/kibo-pickup-tool/main/kibo-pickup.user.js
3. これで準備完了。x.com（またはtwitter.com）を開くと、画面右上にツールのパネルが表示されます。

## 使い方

1. パネルの「開始日」「終了日」を指定して「検索して収集開始」を押す（期間は最大1ヶ月程度）
2. 自動でX検索結果のページに移動し、自動スクロールしながら投稿を収集する（画像・動画が付いた投稿のみが対象）
3. 収集が終わると、サムネイルのグリッドで一覧表示される。動画にマウスを乗せるとその場で再生できる
4. 採用したい投稿のサムネイルをクリックしてチェックを付ける
5. 「選択したURLをコピー」を押すと、選択した投稿のURLが改行区切りでコピーされる
6. コピーしたURLをスプレッドシートのURL列に貼り付ける

## 更新について

Tampermonkeyはデフォルトで1日1回、このリポジトリ上のスクリプトを自動チェックして最新版に更新します。すぐに最新化したい場合はTampermonkeyのダッシュボードで対象スクリプトの「最終更新日」をクリックしてください。

## 動かなくなったら

X側の仕様変更でスクリプトが動かなくなることがあります。気づいたら開発担当（Claude Codeへの依頼）に連絡してください。調査・修正はこちら側で行うので、利用者側でのコード修正は不要です。

詳しい仕様・設計判断は開発側の資料（Bascule社内Obsidianの `01_Projects/P006_X投稿ピックアップシステム/仕様書_草案.md`）を参照してください。
