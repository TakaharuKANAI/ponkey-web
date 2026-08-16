# ponkey-web

PONKEY のエンドユーザー向け公開 Web アプリ。**GitHub Pages でデプロイされる**（push = 公開）。PWA 対応。

## 構成

- `index.html` — アプリハブ（PONKEY Web Apps）。各アプリへの入口
- `lesson.html` — LESSON（使い方・作り方のレッスン。ライトテーマ）。**このファイルが唯一の正**。
  残課題・設計メモは `PONKEY_LESSON_課題.md`
- `duet.html` — PONKEY AI Duet
- `dialogue.html` — DIALOGUE
- `sequence.html` — SEQUENCE（＋グルーブパネル）
- `loops.html` — LOOPS（ループ長。ライトテーマ）
- `invaders.html` — STEP INVADERS（4×4 リズムゲーム）
- `groove.html` — GROOVE（ワンボタンでスイング/アクセント。ライトカラー）
- `groove-engine.js` — 解析・提案エンジン（純粋関数、SEQUENCE と GROOVE が共有）。設計は `PONKEY_GROOVE_CONCEPT.md`
- `sync.html` — SYNC
- `trance.html` — TRANCE
- `ponkey-sound-guide.html` — 音の世界観・リスニングガイド
- `manifest.json` / `sw.js` / `icon-*.png` — PWA（インストール・オフライン）
- `PONKEY_SESSION_CONCEPT.md` — 設計思想ドキュメント。**なぜその挙動なのかはここに書いてある**

## 作業ルール

- アプリを追加したら **`index.html` のハブに導線を追加**し、`sw.js` のキャッシュ対象も更新する。
  そのとき **`sw.js` の `CACHE` バージョンも上げる**（上げないと利用者に古い版が残る）。
  全アプリにホーム導線がある設計なので、新規ページも同じ導線を持たせる。
- **エンドユーザーが触るページはここが正。** `../ponkey-midi/web/apps/` は開発・デバッグ専用。
  向こうで作ったものを公開するときは「移す」（コピーを残さない）。二重管理になると、
  こちらにしかない PWA ヘッダとホーム導線が上書きで消える。
- 挙動の「なぜ」を変える変更をする前に `PONKEY_SESSION_CONCEPT.md` を読む。
  ドキュメントと実装が食い違ったら、勝手にどちらかへ寄せずユーザーに確認する。
- **push すると即公開される。** コミット・push はユーザーの指示があるときだけ。
- ファーム側との契約（BLE コマンド等）は `../ponkey-midi/ponkey-firmware/` が正。
  こちらで勝手に仕様を決めない。
- `sync.html` はこのリポジトリのもの。別リポジトリ `../ponkey-sync/` とは**別物**。
