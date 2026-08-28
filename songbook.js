/* ============================================================================
   songbook.js — SONGBOOK (うたのほん) のデータとエンジン

   PONKEY の16鍵は「C3〜D5 の白鍵16本」= 全音階のはしご。黒鍵は物理的に無い。
   なので、この本に入る曲はすべて次の形に落ちている:
     度数 0-15 (0 = C3 … 15 = D5) の並び + 長さ(16分音符いくつぶん)

   ここが持っているもの:
     ・SONGS        著作権の切れた曲のうた本 (音符は手書き。notation の書き方は下のコメント)
     ・parseNotation()  notation 文字列 → イベント配列
     ・importMIDI()     MIDI ファイル → 白鍵16音へ落とし込む (移調・寄せ・折り返し)
     ・toNotation()     イベント配列 → notation 文字列 (取り込んだ曲を書き出す用)

   鍵番号の表は写経しない。ponkey.js の NOTE_TABLE_NORMAL から逆引きする。

   ── notation の書き方 ──────────────────────────────────────────────
     小文字 c d e f g a b   = オクターブ3 (C3=48 … B3=59)
     大文字 C D E F G A B   = オクターブ4 (C4=60 … B4=71)
     ^C ^D                  = オクターブ5 (C5=72 / D5=74)  ※ここが上限
     R または -             = 休み
     うしろの数字           = 長さ (16分音符いくつぶん。省略時は 4 = 4分音符)
                              2=8分 3=付点8分 4=4分 6=付点4分 8=2分 12=付点2分 16=全音符
     |                      = 小節の区切り (読みやすさのためだけ。無視される)
     例) "C4 C4 G4 G4 | A4 A4 G8"  = ドドソソ ララソー (きらきら星のあたま)
   ========================================================================= */
(function (global) {
'use strict';

// ---- 白鍵16音のはしご -------------------------------------------------------
// 度数 0-15 が実際に鳴らす MIDI ノート。ファーム既定の白鍵モードと同じ並び。
const DEG_NOTE = [48,50,52,53, 55,57,59,60, 62,64,65,67, 69,71,72,74];
const DEG_NAME = ['ド','レ','ミ','ファ','ソ','ラ','シ','ド','レ','ミ','ファ','ソ','ラ','シ','ド','レ'];
const DEG_ABC  = ['C3','D3','E3','F3','G3','A3','B3','C4','D4','E4','F4','G4','A4','B4','C5','D5'];
// ponkey.js が無い場面 (単体テスト等) 用のフォールバック。通常はこちらを使わない
const FALLBACK_TABLE = [69,71,72,74, 62,64,65,67, 55,57,59,60, 48,50,52,53];

// 度数 0-15 → 本体の鍵番号 0-15。表の正本は ponkey.js の NOTE_TABLE_NORMAL
function degKeyTable() {
  const t = (global.Ponkey && global.Ponkey.NOTE_TABLE_NORMAL) || FALLBACK_TABLE;
  return DEG_NOTE.map(n => {
    const k = t.indexOf(n);
    return k < 0 ? 0 : k;
  });
}

// 音名(ピッチクラス) → 白鍵の度数。黒鍵は null
const PC_DEG = [0, null, 1, null, 2, 3, null, 4, null, 5, null, 6];
const LETTER_DEG = { C:0, D:1, E:2, F:3, G:4, A:5, B:6 };

// MIDI ノート → 白鍵はしごの通し度数 (C3=0)。黒鍵は null
function noteToDeg(n) {
  const d = PC_DEG[((n % 12) + 12) % 12];
  if (d == null) return null;
  return (Math.floor(n / 12) - 4) * 7 + d;
}

// ---- notation → イベント ----------------------------------------------------
// 返り値: { events:[{deg,t,dur}], len }  t/dur の単位は16分音符
function parseNotation(str) {
  const events = [];
  let t = 0;
  for (const tok of String(str).replace(/\|/g, ' ').split(/\s+/)) {
    if (!tok) continue;
    const m = /^(\^?)([A-Ga-gRr-])(\d*)$/.exec(tok);
    if (!m) throw new Error('よめない音: ' + tok);
    const dur = m[3] ? parseInt(m[3], 10) : 4;
    const L = m[2];
    if (L === 'R' || L === 'r' || L === '-') { t += dur; continue; }
    const up = L === L.toUpperCase();
    const deg = LETTER_DEG[L.toUpperCase()] + (up ? 7 : 0) + (m[1] === '^' ? 7 : 0);
    if (deg < 0 || deg > 15) throw new Error('16鍵の外の音: ' + tok);
    events.push({ deg, t, dur });
    t += dur;
  }
  return { events, len: t };
}

// ---- イベント → notation ----------------------------------------------------
function toNotation(events) {
  const out = [];
  let t = 0;
  for (const e of events) {
    if (e.t > t) out.push('R' + (e.t - t));
    const oct = Math.floor(e.deg / 7), idx = e.deg % 7;
    const L = 'CDEFGAB'[idx];
    out.push((oct === 0 ? L.toLowerCase() : oct === 2 ? '^' + L : L) + e.dur);
    t = e.t + e.dur;
  }
  return out.join(' ');
}

// ============================================================================
//  うた本 (著作権の切れた曲だけ)
//  pd = パブリックドメインの根拠。ここが書けない曲は入れない。
//  ★ 音符は記憶から書き起こしたもの。アプリの「たしかめた」で耳で確認してから信用すること。
// ============================================================================
const SONGS = [
  // ── おとだめし ──────────────────────────────────────────────
  { id:'scale16', ja:'ドレミ ぜんぶ', kana:'どれみぜんぶ', en:'All 16 keys',
    cat:'おとだめし', bpm:120, pd:'音階そのもの',
    memo:'16鍵をぜんぶ下から上へ、そして下へ。ソレノイドが全部動くかの確認に。',
    notes:'c4 d4 e4 f4 | g4 a4 b4 C4 | D4 E4 F4 G4 | A4 B4 ^C4 ^D8 | ^C4 B4 A4 G4 | F4 E4 D4 C4 | b4 a4 g4 f4 | e4 d4 c8' },

  // ── どうよう ────────────────────────────────────────────────
  { id:'twinkle', ja:'きらきら星', kana:'きらきらぼし', en:'Twinkle, Twinkle, Little Star',
    cat:'どうよう', bpm:108, pd:'フランス民謡 (18世紀)',
    memo:'ABC のうた・ロンドン橋…と並ぶ最初の1曲。ぜんぶ白鍵。',
    notes:'C4 C4 G4 G4 | A4 A4 G8 | F4 F4 E4 E4 | D4 D4 C8 | G4 G4 F4 F4 | E4 E4 D8 | G4 G4 F4 F4 | E4 E4 D8 | C4 C4 G4 G4 | A4 A4 G8 | F4 F4 E4 E4 | D4 D4 C8' },

  { id:'chocho', ja:'ちょうちょう', kana:'ちょうちょう', en:'Lightly Row',
    cat:'どうよう', bpm:112, pd:'ドイツ民謡 (原曲 Hänschen klein / Lightly Row)',
    memo:'',
    notes:'G4 E4 E8 | F4 D4 D8 | C4 D4 E4 F4 | G4 G4 G8 | G4 E4 E8 | F4 D4 D8 | C4 E4 G4 G4 | E4 C4 C8 | D4 D4 D4 D4 | D4 E4 F8 | E4 E4 E4 E4 | E4 F4 G8 | G4 E4 E8 | F4 D4 D8 | C4 E4 G4 G4 | E4 C4 C8' },

  { id:'kaeru', ja:'かえるの合唱', kana:'かえるのがっしょう', en:'Frog Chorus',
    cat:'どうよう', bpm:116, pd:'ドイツ民謡',
    memo:'輪唱できる。2台あれば片方を遅らせて重ねると輪唱になる。',
    notes:'C4 D4 E4 F4 | E4 D4 C8 | E4 F4 G4 A4 | G4 F4 E8 | C4 R4 C4 R4 | C4 R4 C4 R4 | C2 C2 D2 D2 | E2 E2 F2 F2 | E4 D4 C8' },

  { id:'mary', ja:'メリーさんのひつじ', kana:'めりーさんのひつじ', en:'Mary Had a Little Lamb',
    cat:'どうよう', bpm:112, pd:'アメリカ (1830年代)',
    memo:'',
    notes:'E4 D4 C4 D4 | E4 E4 E8 | D4 D4 D8 | E4 G4 G8 | E4 D4 C4 D4 | E4 E4 E4 E4 | D4 D4 E4 D4 | C16' },

  { id:'london', ja:'ロンドンばし', kana:'ろんどんばし', en:'London Bridge',
    cat:'どうよう', bpm:116, pd:'イギリス伝承歌',
    memo:'',
    notes:'G2 A2 G2 F2 | E4 F4 G8 | D4 E4 F8 | E4 F4 G8 | G2 A2 G2 F2 | E4 F4 G8 | D8 G8 | E4 C12' },

  { id:'row', ja:'ボートのうた', kana:'ぼーとのうた', en:'Row, Row, Row Your Boat',
    cat:'どうよう', bpm:104, pd:'アメリカ伝承歌 (1852)',
    memo:'これも輪唱の定番。',
    notes:'C6 C6 | C4 D2 E6 | E4 D2 E4 F2 | G12 | ^C2 ^C2 ^C2 G2 G2 G2 | E2 E2 E2 C2 C2 C2 | G4 F2 E4 D2 | C12' },

  { id:'frere', ja:'かねがなる', kana:'かねがなる', en:'Frère Jacques',
    cat:'どうよう', bpm:108, pd:'フランス伝承歌 (18世紀)',
    memo:'「グーチョキパーでなにつくろう」と同じ曲。輪唱の元祖。',
    notes:'C4 D4 E4 C4 | C4 D4 E4 C4 | E4 F4 G8 | E4 F4 G8 | G2 A2 G2 F2 E4 C4 | G2 A2 G2 F2 E4 C4 | C4 g4 C8 | C4 g4 C8' },

  { id:'macdonald', ja:'ゆかいな牧場', kana:'ゆかいなまきば', en:'Old MacDonald Had a Farm',
    cat:'どうよう', bpm:120, pd:'アメリカ伝承歌 (1917年以前)',
    memo:'いち・れつ・だんだん…の「アイアイアイオー」の曲。',
    notes:'C4 C4 C4 g4 | A4 A4 g8 | E4 E4 D4 D4 | C16 | C4 C4 C4 g4 | A4 A4 g8 | E4 E4 D4 D4 | C16' },

  { id:'alps', ja:'アルプス一万尺', kana:'あるぷすいちまんじゃく', en:'Yankee Doodle',
    cat:'どうよう', bpm:126, pd:'アメリカ伝承歌 (18世紀)',
    memo:'',
    notes:'C4 C4 D4 E4 | C4 E4 D8 | C4 C4 D4 E4 | C8 b8 | C4 C4 D4 E4 | F4 E4 D4 C4 | b4 g4 a4 b4 | C8 R8' },

  { id:'hotcross', ja:'ホット・クロス・バンズ', kana:'ほっとくろすばんず', en:'Hot Cross Buns',
    cat:'どうよう', bpm:100, pd:'イギリス伝承歌 (1798)',
    memo:'3つの音だけ。いちばん最初に弾ける曲。',
    notes:'E4 D4 C8 | E4 D4 C8 | C2 C2 C2 C2 | D2 D2 D2 D2 | E4 D4 C8' },

  // ── せかいのうた ─────────────────────────────────────────────
  { id:'saints', ja:'聖者の行進', kana:'せいじゃのこうしん', en:'When the Saints Go Marching In',
    cat:'せかいのうた', bpm:120, pd:'アメリカ黒人霊歌 (1896年以前)',
    memo:'',
    notes:'R4 C4 E4 F4 | G16 | R4 C4 E4 F4 | G16 | R4 C4 E4 F4 | G8 E8 | C8 E8 | D16 | R4 E4 E4 D4 | C8 E8 | G8 G8 | F8 E8 | C8 D8 | C16' },

  { id:'susanna', ja:'おおスザンナ', kana:'おおすざんな', en:'Oh! Susanna',
    cat:'せかいのうた', bpm:126, pd:'フォスター (1848)',
    memo:'',
    notes:'C2 D2 | E4 G4 G4 A4 | G4 E4 C4 D4 | E4 E4 D4 C4 | D12 C2 D2 | E4 G4 G4 A4 | G4 E4 C4 D4 | E4 E4 D4 D4 | C16 | F4 F4 A4 A4 | G4 G4 E8 | C4 D4 E4 E4 | D4 D4 C8' },

  { id:'jingle', ja:'ジングルベル', kana:'じんぐるべる', en:'Jingle Bells',
    cat:'せかいのうた', bpm:132, pd:'ピアポント (1857)',
    memo:'いちばん有名なサビの部分。',
    notes:'E4 E4 E8 | E4 E4 E8 | E4 G4 C4 D4 | E16 | F4 F4 F4 F4 | F4 E4 E4 E4 | E4 D4 D4 E4 | D8 G8' },

  { id:'silent', ja:'きよしこの夜', kana:'きよしこのよる', en:'Silent Night',
    cat:'せかいのうた', bpm:96, pd:'グルーバー (1818)',
    memo:'6/8拍子。16鍵に収まるよう低めの位置に置いてある。',
    notes:'g4 a2 g6 | e12 | g4 a2 g6 | e12 | D4 D2 b6 | C4 C2 g6 | a4 a2 C6 | b4 a2 g6 | a4 a2 C6 | b4 a2 g6 | D4 D2 F6 | D6 b6 | C4 E2 C6 | g6 e6 | C12' },

  { id:'joyworld', ja:'もろびとこぞりて', kana:'もろびとこぞりて', en:'Joy to the World',
    cat:'せかいのうた', bpm:112, pd:'ヘンデル/メイソン (1839)',
    memo:'あたまが「ドシラソファミレド」の下り階段。16鍵の上から下までを一気に使う。',
    notes:'^C6 B2 A4 G4 | F6 E2 D4 C4 | G4 G4 A4 A4 | B4 B4 ^C8 | ^C4 ^C4 ^C4 ^C4 | B4 B4 B4 B4 | A4 A4 A4 A4 | G8 G8' },

  // ── クラシック ──────────────────────────────────────────────
  { id:'ode', ja:'よろこびのうた', kana:'よろこびのうた', en:'Ode to Joy (Beethoven)',
    cat:'クラシック', bpm:120, pd:'ベートーヴェン (1824)',
    memo:'第九の主題。となりの音しか動かないので16鍵に完璧に収まる。',
    notes:'E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | E6 D2 D8 | E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D6 C2 C8' },

  { id:'largo', ja:'家路', kana:'いえじ', en:'Largo from “New World” (Dvořák)',
    cat:'クラシック', bpm:76, pd:'ドヴォルザーク (1893)',
    memo:'「遠き山に日は落ちて」。ゆっくりなのでソレノイドの音がよく聞こえる。',
    notes:'E6 G2 G8 | E6 D2 C8 | D4 E4 G4 E4 | D16 | E6 G2 G8 | E6 D2 C8 | D4 E4 D4 C4 | C16' },
];

// ============================================================================
//  MIDI 取り込み — ここが「白鍵16個で弾けるように作りなおす」本体
//   ① MIDI を読む  ② 旋律のパートを選ぶ  ③ 和音を1本にする (上の音を採る)
//   ④ 調をさがして ハ長調 へ移す  ⑤ 残った黒鍵を隣の白鍵へ寄せる
//   ⑥ 16鍵の高さへ折り返す  ⑦ 16分音符に丸める
//  何音を寄せたか・折り返したかは report で返して画面に出す (黙って捨てない)
// ============================================================================

// ---- ① SMF パーサ (最小限) --------------------------------------------------
function parseSMF(buf) {
  const d = new DataView(buf);
  let p = 0;
  const str4 = () => String.fromCharCode(d.getUint8(p++), d.getUint8(p++), d.getUint8(p++), d.getUint8(p++));
  if (str4() !== 'MThd') throw new Error('MIDI ファイルではないみたい');
  const hdrLen = d.getUint32(p); p += 4;
  const format = d.getUint16(p); p += 2;
  const ntrk   = d.getUint16(p + 0 + 0); p += 2;
  const div    = d.getUint16(p); p += 2;
  p += hdrLen - 6;
  if (div & 0x8000) throw new Error('SMPTE 形式の MIDI は読めません');
  const tpb = div;

  const notes = [];            // {track, ch, note, start(tick), dur(tick)}
  const tempos = [{ tick: 0, uspq: 500000 }];

  for (let tr = 0; tr < ntrk; tr++) {
    if (p + 8 > d.byteLength) break;
    if (str4() !== 'MTrk') break;
    const len = d.getUint32(p); p += 4;
    const end = p + len;
    let tick = 0, status = 0;
    const open = new Map();    // (ch<<8|note) → 開始 tick
    while (p < end) {
      // 可変長 delta
      let dt = 0, b;
      do { b = d.getUint8(p++); dt = (dt << 7) | (b & 0x7f); } while (b & 0x80);
      tick += dt;
      let s = d.getUint8(p);
      if (s & 0x80) { status = s; p++; } else { s = status; }   // ランニングステータス
      const hi = s & 0xf0, ch = s & 0x0f;
      if (s === 0xff) {                                          // メタ
        const type = d.getUint8(p++);
        let l = 0; do { b = d.getUint8(p++); l = (l << 7) | (b & 0x7f); } while (b & 0x80);
        if (type === 0x51 && l === 3) {
          tempos.push({ tick, uspq: (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2) });
        }
        p += l;
      } else if (s === 0xf0 || s === 0xf7) {                     // SysEx
        let l = 0; do { b = d.getUint8(p++); l = (l << 7) | (b & 0x7f); } while (b & 0x80);
        p += l;
      } else if (hi === 0x90 || hi === 0x80) {
        const note = d.getUint8(p++), vel = d.getUint8(p++);
        const k = (ch << 8) | note;
        if (hi === 0x90 && vel > 0) {
          if (!open.has(k)) open.set(k, tick);
        } else if (open.has(k)) {
          const st = open.get(k); open.delete(k);
          if (tick > st) notes.push({ track: tr, ch, note, start: st, dur: tick - st });
        }
      } else if (hi === 0xc0 || hi === 0xd0) { p += 1; }
      else { p += 2; }
    }
    p = end;
  }
  notes.sort((a, b) => a.start - b.start || b.note - a.note);
  return { tpb, format, notes, tempos };
}

// ---- ② パート候補 -----------------------------------------------------------
// (track, ch) ごとにまとめる。ch10 (index 9) はドラムなので外す。
function midiParts(smf) {
  const g = new Map();
  for (const n of smf.notes) {
    if (n.ch === 9) continue;
    const k = n.track + ':' + n.ch;
    if (!g.has(k)) g.set(k, { key: k, track: n.track, ch: n.ch, notes: [] });
    g.get(k).notes.push(n);
  }
  const parts = [...g.values()].map(p => {
    const sum = p.notes.reduce((a, n) => a + n.note, 0);
    return Object.assign(p, { count: p.notes.length, avg: sum / p.notes.length });
  }).filter(p => p.count >= 4);
  parts.sort((a, b) => b.count - a.count);
  // 旋律らしさ = 音数が十分あるものの中でいちばん高い声部
  const maxCount = parts.length ? parts[0].count : 0;
  let best = null;
  for (const p of parts) if (p.count >= maxCount * 0.25 && (!best || p.avg > best.avg)) best = p;
  return { parts, best };
}

// ---- ③〜⑦ 白鍵16音へ落とす --------------------------------------------------
// opts: { part:'track:ch', quantize:4|2|1 (1拍を何分割するか→16分基準に換算), transpose:度数 }
function fitToPonkey(smf, opts) {
  opts = opts || {};
  const sel = opts.part;
  let src = smf.notes.filter(n => n.ch !== 9 && (!sel || (n.track + ':' + n.ch) === sel));
  if (!src.length) throw new Error('音が見つかりません');

  // ③ 和音を1本にする — 同時に鳴っている中でいちばん高い音を採る (スカイライン)
  const grid = Math.max(1, Math.round(smf.tpb / 4));      // 16分音符ぶんの tick
  const byStep = new Map();
  for (const n of src) {
    const step = Math.round(n.start / grid);
    const cur = byStep.get(step);
    if (!cur || n.note > cur.note) byStep.set(step, n);
  }
  let mono = [...byStep.entries()].sort((a, b) => a[0] - b[0])
    .map(([step, n]) => ({ step, note: n.note, dur: Math.max(1, Math.round(n.dur / grid)) }));
  // 次の音の頭までで切る (重なりを消す)
  for (let i = 0; i < mono.length - 1; i++) mono[i].dur = Math.min(mono[i].dur, mono[i + 1].step - mono[i].step);
  mono = mono.filter(m => m.dur > 0);

  // ④ 調をさがす — 音の長さで重みづけした音名ヒストグラム × 長調12通り
  const hist = new Array(12).fill(0);
  for (const m of mono) hist[m.note % 12] += m.dur;
  const MAJOR = [0, 2, 4, 5, 7, 9, 11];
  let bestKey = 0, bestScore = -1;
  for (let k = 0; k < 12; k++) {
    let s = 0;
    for (const d of MAJOR) s += hist[(k + d) % 12];
    s += hist[k] * 0.5 + hist[(k + 7) % 12] * 0.25;      // 主音と属音に少し重み
    if (s > bestScore) { bestScore = s; bestKey = k; }
  }
  const shift = -bestKey;                                 // 主音を C へ

  // ⑤ 黒鍵を隣の白鍵へ寄せる
  let snapped = 0;
  const degs = mono.map(m => {
    let n = m.note + shift;
    if (PC_DEG[((n % 12) + 12) % 12] == null) {
      snapped++;
      n = (PC_DEG[((n - 1) % 12 + 12) % 12] != null) ? n - 1 : n + 1;
    }
    return { step: m.step, dur: m.dur, deg: noteToDeg(n) };
  });

  // ⑥ 16鍵 (度数0-15) の高さへ。まずオクターブ単位でいちばん収まる位置を探す
  // 収まる音がいちばん多いオクターブ。同点なら16鍵の真ん中に寄る位置を選ぶ
  let bestOct = 0, bestIn = -1, bestDist = Infinity;
  for (let o = -6; o <= 6; o++) {
    let inRange = 0, sum = 0;
    for (const d of degs) { const v = d.deg + o * 7; if (v >= 0 && v <= 15) inRange++; sum += v; }
    const dist = Math.abs(sum / degs.length - 7.5);
    if (inRange > bestIn || (inRange === bestIn && dist < bestDist)) { bestIn = inRange; bestDist = dist; bestOct = o; }
  }
  let folded = 0;
  const events = degs.map(d => {
    let v = d.deg + bestOct * 7;
    if (v < 0 || v > 15) {
      folded++;
      while (v < 0) v += 7;
      while (v > 15) v -= 7;
    }
    return { deg: v, t: d.step, dur: d.dur };
  });

  // ⑦ 頭の休みを詰める + 移調 (度数単位。白鍵の上を上下するだけなので黒鍵は出ない)
  const t0 = events.length ? events[0].t : 0;
  const tr = opts.transpose | 0;
  for (const e of events) {
    e.t -= t0;
    if (tr) { let v = e.deg + tr; e.deg = Math.max(0, Math.min(15, v)); }
  }

  const KEYNAME = ['ハ','変ニ','ニ','変ホ','ホ','ヘ','嬰ヘ','ト','変イ','イ','変ロ','ロ'];
  return {
    events,
    len: events.length ? events[events.length - 1].t + events[events.length - 1].dur : 0,
    report: {
      total: mono.length, snapped, folded,
      key: KEYNAME[bestKey] + '調あたり → ハ長調へ移しました',
      bpm: Math.round(60000000 / (smf.tempos[smf.tempos.length - 1].uspq || 500000)),
    },
  };
}

// ---- 公開 ------------------------------------------------------------------
global.Songbook = {
  DEG_NOTE, DEG_NAME, DEG_ABC, degKeyTable, noteToDeg,
  SONGS, parseNotation, toNotation,
  parseSMF, midiParts, fitToPonkey,
};
})(typeof window !== 'undefined' ? window : globalThis);
