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
- `mood.html` — MOOD（スケール／キー／**鍵盤の物理配置**を切り替えて曲の雰囲気を変える。ライトテーマ）。
  肝は「PONKEY のソレノイド16本が下の鍵盤のどの鍵に乗っているか」をアプリに教えること
  （`白鍵だけ` = ファーム既定の `NOTE_TABLE_NORMAL` と同じ C3-D5 白鍵16本 / `半音階` = 起点から16半音）。
  そこから「そのスケールの音を出せる鍵はどれか」を出し、ピアノロールの行を絞る。
  スケールやキーを変えると、既存の音は最寄りのスケール内の鍵へ寄る（＝同じ曲の雰囲気だけが変わる）。
  出口は2つ: 鍵のクリック＝`NoteOn(鍵番号0-15)` を即送信、フレーズ＝`SONG_CMD_LOAD_SLOT`(slot0)＋`SET_SEQ([0])`
  を250msデバウンスで送って本体に鳴らさせる。再生ヘッドは本体の `CC_BAR_SYNC` に乗せる（アプリで数えない）。
  **ドラムは扱わない** — 本体のドラムは「ステップ位置の鍵」を叩く仕様（`effectiveUserStep`）で、音階の話と噛み合わないため。
  半音階配置のときは本体の内蔵シンセ(SAM2695)だけが白鍵のままズレるので、`CC_SAM_MUTE` で消せるようにしてある。
  **ソレノイドが動くのは1パートだけ** — ファームは `solenoidPartMode == p+4`(= `legacy.currentMode`)の
  パートしか鍵を叩かない。しかも `currentMode` の初期値は 0=KICK なので、**指定しないとシンセは鳴るのに
  ソレノイドが1本も動かない**。`CC(パート番号 4-6)` を接続時と切替時に送って解消している
  (本体の P5-P7 を押すのと同じで、本体側の選択パートも変わる)。
  パートの音の ON/OFF は `SONG_CMD_SET_MUTE`(payload=[muteMask][soloMask]、シンセ p のビットは p+4)。
  ミュートしたパートは本体側で丸ごとスキップされるので音もソレノイドも止まる。
  再生中は `CC_BAR_SYNC` に合わせて「そのステップでソレノイドが落ちる鍵」を鍵盤ストリップ上で光らせる。
- `trance.html` — TRANCE
- `echo.html` — ECHO（その日の演奏を本体から読み出して残す日記＋共有リンク）。
  取り込みは `SONG_CMD_DUMP_SLOT`(0x07, payload 0xFE=中身のある全スロット)。ソングモード不要・副作用なし。
  応答は `DBG_EV_SONG_META` → `DBG_EV_SONG_SLOT_DUMP`（分割・要組み立て）で、スロットは **V2 形式(先頭 0xF2)**。
  **書き戻しは非可逆**: ファームの `LOAD_SLOT`(`parseSlotPayload`) は V1 形式しか受けず、
  ①ドラムの非対角ビット（SCALE 化したドラムパート）と矩形設定、②シンセの重ね録りレイヤー
  （`dur` の bit7。`dur>64` の丸めで消える）が落ちる。保存データ側は V2 のまま無傷なので、
  ファームが V2 受信に対応すれば後から完全復元できる。落ちた件数はログに出す。
  **バックアップは GitHub Gist**（非公開＝secret gist。ただし URL を知る人は見られる＝完全な非公開ではない）。
  トークンは記録本体とは**別の localStorage キー** `ponkey_echo_gist_v01` に置く（`ponkey_echo_v01` と混ぜると
  「書き出し」の JSON にトークンが載ってしまうため）。同期は id で突き合わせる和集合マージだが、
  **削除は墓標 `store.deleted` が必須**（無いと消した記録が次の同期で Gist から蘇る）。
  Gist は 1MB 超で `content` が切り詰められるので `truncated` なら `raw_url` から取り直す
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
