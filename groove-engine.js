/* PONKEY GROOVE ENGINE — 打ち込みパターンの解析とグルーブ提案 (純粋関数・BLE 非依存)
 * ---------------------------------------------------------------------------
 * 使い方:
 *   const score = GrooveEngine.scoreFromLoop(loop)         // SEQUENCE の loop 形式から
 *   const score = GrooveEngine.decodeSlotV2(bytes)         // 本体 DUMP(v2) から
 *   const meta  = GrooveEngine.decodeMeta(bytes)           // 本体 META から
 *   const f     = GrooveEngine.analyze(score, meta)         // 特徴量
 *   const props = GrooveEngine.propose(f)                   // 提案 3 案 (保守/標準/大胆) + 説明
 *
 * 設計 (PONKEY_GROOVE_CONCEPT.md 参照):
 *   ①正規化 → ②特徴量 → ③スタイル推定(事前分布を選ぶだけ。ユーザーには押し付けない)
 *   → ④提案生成 = 「効くものだけ」を選ぶ (スイングは 16分裏に音が無ければ効かない、
 *      アクセント型は実際のヒットに倍率差が出るものだけ) → ⑤試聴はアプリ側 (CC 0x35/0x36)
 *
 * ファーム契約 (v4.5.63, ../ponkey-midi/ponkey-firmware/PONKEY_PT2_v4_5_34 が正):
 *   CC_GROOVE_SWING 0x35 = 0..7 (0=OFF, 50/53/56/59/62/66/70/75%)
 *   CC_GROOVE_ACCENT 0x36 = 0..7 (0=OFF, 拍頭弱/拍頭強/裏拍押し/バックビート/ゴースト16/うねり/ヒューマナイズ)
 */
(function (root) {
  'use strict';

  const SWING_NAMES  = ['OFF', '53%', '56%', '59%', '62%', '66% (3連)', '70%', '75%'];
  const ACCENT_NAMES = ['OFF', '拍頭 (弱)', '拍頭 (強)', '裏拍押し', 'バックビート', 'ゴースト16', 'うねり', 'ヒューマナイズ'];
  // ファームの GROOVE_ACCENT_TPL と同一 (倍率 %)
  const ACCENT_TPL = [
    [100,100,100,100, 100,100,100,100, 100,100,100,100, 100,100,100,100],
    [110, 80, 95, 80, 110, 80, 95, 80, 110, 80, 95, 80, 110, 80, 95, 80],
    [120, 60, 90, 60, 120, 60, 90, 60, 120, 60, 90, 60, 120, 60, 90, 60],
    [100, 70,118, 70, 100, 70,118, 70, 100, 70,118, 70, 100, 70,118, 70],
    [ 95, 65, 85, 65, 125, 65, 85, 65,  95, 65, 85, 65, 125, 65, 85, 65],
    [112, 45,100, 45, 112, 45,100, 45, 112, 45,100, 45, 112, 45,100, 45],
    [ 70, 60, 75, 65,  85, 72, 90, 80, 100, 85,105, 92, 118,100,125,108],
    [105, 90, 98, 90, 105, 90, 98, 90, 105, 90, 98, 90, 105, 90, 98, 90],
  ];
  // v4.6: P1 = ドラムキット1パート (16打楽器)。**列 = 系統**なので `key % 4` で
  //   キック/スネア/ハット/パーカッションの4系統に束ねられる。
  //   この束ね方のおかげで、旧来の「キックは1拍目・ハットは8分」という分析がそのまま生きる。
  const DRUM_FAMILIES = ['キック', 'スネア', 'ハット', 'パーカス'];
  const MEL_NAMES = ['けんばん', 'リード', 'ベース', 'わおん', 'ベル', 'こえ'];
  const PART_NAMES = [...DRUM_FAMILIES, ...MEL_NAMES];
  const NMEL = MEL_NAMES.length;             // 6
  const IDX_BASS = 4 + 2;                    // parts[] 上のベースの位置 (P4 = メロディ index2)
  const SCALE_NAMES = ['メジャー', 'マイナー', 'ペンタ', 'マイナーペンタ', 'ドリアン', 'ブルース', '琉球', 'ハーモニックマイナー'];
  // Longuet-Higgins & Lee 風メトリック重み (16分16ステップ)
  const METRIC_W = [5,1,2,1, 3,1,2,1, 4,1,2,1, 3,1,2,1];

  // ─────────────────────────────────────────── ① 正規化
  // Score = { loopLen(substep), steps, rect:{row,col}, oct:[6],
  //           drums:[{part,step,keys:[..]}], synth:[{part,key,sub,dur,layer}] }
  function scoreFromLoop(L) {
    // loop 形式のドラムは [サウンド, ステップ] (v4.6: 1バイトが (サウンド<<4)|ステップ と同じ意味)
    const drums = (L.drums || []).map(([k, s]) => ({ step: s, keys: [k] }));
    const synth = (L.synth || []).map(([l, k, sub, du]) => ({ part: l, key: k, sub, dur: (du & 0x7f) || 1, layer: (du >> 7) & 1 }));
    return { loopLen: L.loopLen || 64, steps: Math.max(1, Math.round((L.loopLen || 64) / 4)),
             rect: { row: 4, col: 4 }, oct: (L.oct || new Array(NMEL).fill(0)).slice(), drums, synth, slot: null };
  }
  // 本体 DUMP v2: [0xF2][slot][loopLen][**oct×6**][rectRow][rectCol][dc]{(p<<4)|s,maskLo,maskHi}[sc]{(l<<4)|k,sub,raw}
  //   ⚠ v4.6.0 でオクターブ欄が 3→6 要素になった。ここを間違えると以降のバイトが全部ずれる。
  //   ドラムは part が常に 0 で、マスクのビット k = キット音 k (= キー k)。
  function decodeSlotV2(d) {
    let i = 0;
    if (d[i++] !== 0xF2) return null;
    const slot = d[i++], loopLen = d[i++] || 64;
    const oct = []; for (let n = 0; n < NMEL; n++) oct.push((d[i++] << 24) >> 24);
    let rr = d[i++], rc = d[i++]; if (!rr) rr = 4; if (!rc) rc = 4;
    const dc = d[i++], drums = [];
    for (let n = 0; n < dc; n++) {
      const b = d[i++], mask = d[i++] | (d[i++] << 8);
      const keys = []; for (let k = 0; k < 16; k++) if ((mask >> k) & 1) keys.push(k);
      drums.push({ step: b & 0xf, keys });
    }
    const sc = d[i++], synth = [];
    for (let n = 0; n < sc; n++) {
      const b = d[i++], sub = d[i++], raw = d[i++];
      synth.push({ part: (b >> 4) & 0xf, key: b & 0xf, sub, dur: (raw & 0x7f) || 1, layer: (raw >> 7) & 1 });
    }
    return { loopLen, steps: Math.max(1, Math.round(loopLen / 4)), rect: { row: rr, col: rc }, oct, drums, synth, slot };
  }
  // 本体 META: [bpm-60][curSlot][playing][0][0][0][0][root][swing][accent][voice×7][hasLo][hasHi]
  //   v4.6.0: 旧 scaleEnabledBits / scaleIdx の欄はドラムのスケールモード廃止で常に 0 (形式長は維持)
  function decodeMeta(d) {
    return { bpm: 60 + d[0], currentSlot: d[1], playing: !!d[2],
             root: d[7], swing: d[8], accent: d[9],
             voices: Array.from(d.slice(10, 17)), hasData: d[17] | (d[18] << 8) };
  }
  // Score → SEQUENCE の loop 形式 (書き戻し/表示用)。矩形は線形に展開しない(そのまま)。
  function loopFromScore(sc) {
    const drums = [], synth = [];
    // v4.6: 立っているキット音をそのまま [サウンド, ステップ] で並べる (対角の制約はもう無い)
    for (const h of sc.drums) for (const k of h.keys) drums.push([k, h.step]);
    for (const n of sc.synth) synth.push([n.part, n.key, n.sub, (n.dur & 0x7f) | (n.layer ? 0x80 : 0)]);
    return { name: '', loopLen: sc.loopLen, oct: sc.oct.slice(), drums, synth };
  }

  // ─────────────────────────────────────────── ② 特徴量
  // 矩形ループ: 時間軸上の並びに展開する (rect 3×3 なら 9 ステップ周期)。
  function timeline(sc) {
    const rr = sc.rect.row, rc = sc.rect.col;
    const useRect = !(rr === 4 && rc === 4);
    const n = useRect ? rr * rc : sc.steps;
    const map = [];   // 時間位置 t → 実グリッド番号
    for (let t = 0; t < n; t++) map.push(useRect ? Math.floor(t / rc) * 4 + (t % rc) : t);
    return { n, map };
  }
  function analyze(sc, meta) {
    meta = meta || {};
    const tl = timeline(sc);
    const N = tl.n;                                  // 時間ステップ数 (通常 16)
    const gridToT = {}; tl.map.forEach((g, t) => { gridToT[g] = t; });
    // v4.6: ドラムは1パート16音。**列 (key % 4) = 系統**なので4系統に束ねて数える。
    //   こうすると「キックは1拍目 / スネアはバックビート / ハットは8分」という
    //   従来の見立てがそのまま成立する (束ね方だけが変わり、音楽的な読みは変わらない)。
    const hits = [new Set(), new Set(), new Set(), new Set()];
    const keyHits = [[], [], [], []];                // {t,key} — その系統で叩かれた打楽器
    for (const h of sc.drums) {
      const t = gridToT[h.step]; if (t == null) continue;
      for (const k of h.keys) { const fam = k % 4; hits[fam].add(t); keyHits[fam].push({ t, key: k }); }
    }
    // メロディ: t(16分) と細分 sub%4
    const syn = Array.from({ length: NMEL }, () => []);
    for (const nt of sc.synth) {
      const g = Math.floor(nt.sub / 4), t = gridToT[g]; if (t == null) continue;
      syn[nt.part].push({ t, fine: nt.sub % 4, key: nt.key, dur: nt.dur, layer: nt.layer, sub: nt.sub });
    }
    const w = t => METRIC_W[t % 16];
    const isDown = t => t % 4 === 0, isEighth = t => t % 4 === 2, isOdd = t => t % 2 === 1;

    const parts = [];
    for (let p = 0; p < 4; p++) {
      const H = [...hits[p]].sort((a, b) => a - b);
      const c = H.length;
      const down = H.filter(isDown).length, eighth = H.filter(isEighth).length, odd = H.filter(isOdd).length;
      parts.push({ name: PART_NAMES[p], count: c, density: c / N * 16, down, eighth, odd,
                   pos: H, syncopation: syncIndex(H, N),
                   sounds: [...new Set(keyHits[p].map(x => x.key))].sort((a, b) => a - b) });
    }
    for (let l = 0; l < NMEL; l++) {
      const S = syn[l];
      const ts = [...new Set(S.map(x => x.t))].sort((a, b) => a - b);
      const keys = S.map(x => x.key);
      const long = S.filter(x => x.dur > 4).length;
      const offGrid = S.filter(x => x.fine !== 0).length;
      const lockKick = ts.length ? ts.filter(t => hits[0].has(t)).length / ts.length : 0;
      parts.push({ name: PART_NAMES[4 + l], count: S.length, density: ts.length / N * 16,
                   down: ts.filter(isDown).length, eighth: ts.filter(isEighth).length, odd: ts.filter(isOdd).length,
                   pos: ts, syncopation: syncIndex(ts, N),
                   range: keys.length ? Math.max(...keys) - Math.min(...keys) : 0,
                   longRatio: S.length ? long / S.length : 0, offGrid, lockKick,
                   layers: S.some(x => x.layer) ? 2 : (S.length ? 1 : 0) });
    }
    const K = parts[0], SN = parts[1], HT = parts[2];
    const fourOnFloor = [0, 4, 8, 12].every(t => hits[0].has(t)) && K.count <= 6;
    const backbeat = hits[1].has(4) && hits[1].has(12);
    let hatSub = 'none';
    if (HT.count >= 12) hatSub = '16th';
    else if (HT.count >= 4 && HT.odd <= 1) hatSub = '8th';
    else if (HT.count >= 3) hatSub = 'sparse';
    const drumHits = K.count + SN.count + HT.count + parts[3].count;
    const oddHitsAll = parts.reduce((a, p) => a + p.odd, 0);
    // スイングが「聞こえる」素材: 16分裏(奇数ステップ)の音、または細分位置が後半(sub%8>=4)のシンセ音
    const swingMaterial = oddHitsAll + syn.flat().filter(x => x.sub % 8 >= 4).length;
    // 総合シンコペーション (キック+スネア+ベース、ヒット数で正規化)
    const syncTotal = (K.syncopation + SN.syncopation + parts[IDX_BASS].syncopation);
    const syncPerHit = syncTotal / Math.max(1, K.count + SN.count + parts[IDX_BASS].count);
    // アクセント型ごとの「効き」= 実ヒットにかかる倍率の標準偏差 (0 なら何も変わらない)
    const accentEffect = ACCENT_TPL.map(tpl => {
      const v = [];
      for (const p of parts) for (const t of p.pos) v.push(tpl[t % 16]);
      if (v.length < 2) return 0;
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length);
    });
    return { N, parts, drum: parts.slice(0, 4), mel: parts.slice(4), bass: parts[IDX_BASS],
             fourOnFloor, backbeat, hatSub, drumHits, oddHitsAll, swingMaterial,
             syncTotal, syncPerHit, accentEffect, bpm: meta.bpm || 120,
             root: meta.root, current: { swing: meta.swing || 0, accent: meta.accent || 0 } };
  }
  // LHL 風シンコペーション指数: 弱拍のヒットで、次に来るより強い位置が空なら (強-弱) を加算
  function syncIndex(H, N) {
    const set = new Set(H); let s = 0;
    for (const t of H) {
      const wt = METRIC_W[t % 16];
      for (let d = 1; d < N; d++) {
        const u = (t + d) % N, wu = METRIC_W[u % 16];
        if (wu > wt) { if (!set.has(u)) s += wu - wt; break; }
      }
    }
    return s;
  }

  // ─────────────────────────────────────────── ③ スタイル推定 (事前分布)
  function inferStyle(f) {
    const bpm = f.bpm, bass = f.bass;
    if (f.drumHits <= 6 && f.mel.reduce((a, p) => a + p.count, 0) <= 8)
      return { key: 'minimal', label: 'ミニマル', swing: 1, accents: [7, 1], why: '音数が少ないので、大きく崩さず"揺らぎ"だけ足すのが合いそうです。' };
    if (f.fourOnFloor && f.hatSub === '16th')
      return { key: 'house16', label: '四つ打ち (16分ハット)', swing: 3, accents: [3, 5, 1], why: '四つ打ち＋16分ハット。裏拍を押すとフロア感が出ます。' };
    if (f.fourOnFloor)
      return { key: 'house', label: '四つ打ち', swing: 2, accents: [3, 1, 2],
               why: f.hatSub === '8th' ? '四つ打ち。ハットが8分なのでスイングは浅めが上品です。' : '四つ打ち。裏拍を少し押すとフロア感が出ます。' };
    if (f.backbeat && bass.count >= 4 && bass.lockKick >= 0.6 && (f.hatSub === '16th' || bass.count >= 6))
      return { key: 'funk', label: 'ファンク寄り', swing: 4, accents: [4, 5, 3], why: 'ベースがキックにロックしています。バックビートを立てると粘ります。' };
    if (f.backbeat && bpm < 108)
      return { key: 'hiphop', label: 'ヒップホップ寄り', swing: 5, accents: [5, 4, 2], why: 'ゆったりしたバックビート。深めのスイングとゴーストが似合います。' };
    if (f.backbeat)
      return { key: 'beat', label: 'ビート', swing: 3, accents: [4, 1, 5], why: '2・4拍にスネア。バックビートを主役にすると締まります。' };
    if (bpm >= 130 && f.drum[2].count >= 8)
      return { key: 'techno', label: 'テクノ/エレクトロ', swing: 1, accents: [2, 3, 7], why: '速くて直線的。スイングは控えめ、拍頭の強弱で推進力を。' };
    return { key: 'straight', label: 'ストレート', swing: 2, accents: [1, 3, 7], why: 'まず拍頭を少し立てるところから。' };
  }

  // ─────────────────────────────────────────── ④ 提案生成
  // 返り値: { style, notes:[説明], proposals:[{key,label,swing,accent,why[]}] } (保守/標準/大胆)
  function propose(f) {
    const st = inferStyle(f);
    const notes = [];
    let base = st.swing;
    // スイングの効き: 16分裏に音が無ければ効かない
    let swingOk = f.swingMaterial > 0;
    if (!swingOk) notes.push('16分裏に音が無いので、スイングは今のところ聞こえません（ハットを16分にすると跳ねます）。');
    else {
      if (f.hatSub === '8th') { base = Math.min(base, 3); notes.push('ハットが8分刻みなのでスイングは浅めに。'); }
      if (f.hatSub === '16th') { base = Math.min(7, base + 1); notes.push('16分ハットがあるのでスイングがよく効きます。'); }
      if (f.drumHits >= 28) { base = Math.max(1, base - 1); notes.push('音数が多いので深いスイングは詰まりがち。少し浅めに。'); }
    }
    // アクセント: 効くものだけを候補に (実ヒットに倍率差が出るテンプレ)
    const eff = f.accentEffect;
    const usable = st.accents.filter(a => eff[a] >= 6);
    if (!usable.length) {
      // 事前分布の型が効かない → 効くものを効き順に
      const ranked = [1, 2, 3, 4, 5, 6].filter(a => eff[a] >= 6).sort((a, b) => eff[b] - eff[a]);
      usable.push(...ranked);
    }
    if (!usable.length) { usable.push(7); notes.push('全部が拍頭に乗っているので型アクセントは差が出ません。ヒューマナイズで揺らぎだけ足します。'); }
    const acc = usable[0], accSoft = softer(acc, usable), accBold = bolder(acc, usable);
    const mk = (key, label, sw, ac, extra) => ({
      key, label, swing: swingOk ? clamp(sw, 0, 7) : 0, accent: ac,
      swingName: SWING_NAMES[swingOk ? clamp(sw, 0, 7) : 0], accentName: ACCENT_NAMES[ac],
      why: [st.why].concat(extra || []) });
    const proposals = [
      mk('soft',  '控えめ', Math.max(swingOk ? 1 : 0, base - 2), accSoft, ['原曲の印象を保ったまま、ほんの少しだけ生っぽく。']),
      mk('std',   '標準',   base, acc, ['このパターンに一番合いそうな組み合わせ。']),
      mk('bold',  '大胆',   Math.min(7, base + 1), accBold, ['ハッキリ変わります。曲によっては別物になるので試してから。']),
    ];
    // 現在値と同じ提案があれば印
    for (const p of proposals) p.same = (p.swing === f.current.swing && p.accent === f.current.accent);
    if (f.syncPerHit >= 1.5) notes.push('もともとシンコペーションが効いています。アクセントを足すと立体的に。');
    else if (f.syncTotal === 0) notes.push('全ての音が表拍に乗っています（PONKEY らしい "まっすぐさ"）。');
    return { style: st, notes, proposals };
  }
  function softer(a, usable) {
    if (a === 2) return 1; if (a === 5) return usable.includes(1) ? 1 : 7; if (a === 4) return usable.includes(1) ? 1 : 4;
    if (a === 3) return 1; if (a === 6) return 1; return a === 7 ? 7 : 1;
  }
  function bolder(a, usable) {
    if (a === 1) return usable.includes(2) ? 2 : (usable.includes(4) ? 4 : a);
    if (a === 3) return usable.includes(5) ? 5 : 2; if (a === 4) return usable.includes(5) ? 5 : 2;
    if (a === 7) return usable.includes(1) ? 1 : 6; return a === 6 ? 6 : (usable.includes(6) ? 6 : a);
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // 人が読む要約 (UI 用)
  function describe(f) {
    const K = f.drum[0], SN = f.drum[1], HT = f.drum[2], B = f.bass;
    const out = [];
    out.push(`${f.bpm} BPM / ドラム ${f.drumHits} 打`);
    if (f.fourOnFloor) out.push('キック: 四つ打ち'); else if (K.count) out.push(`キック: ${K.count}打${K.odd ? '(16分裏あり)' : ''}`);
    if (f.backbeat) out.push('スネア: 2・4拍'); else if (SN.count) out.push(`スネア: ${SN.count}打`);
    out.push('ハット: ' + ({ '16th': '16分', '8th': '8分', 'sparse': 'まばら', 'none': 'なし' })[f.hatSub]);
    if (B.count) out.push(`ベース: ${B.count}音 / キック追従 ${Math.round(B.lockKick * 100)}%`);
    // v4.6: メロディ6パート。音のあるパートだけ並べる
    f.mel.forEach((mp, i) => {
      if (i === 2 || !mp.count) return;                       // ベースは上で B として扱っている
      out.push(`${mp.name}: ${mp.count}音${mp.longRatio > .4 ? '(伸ばし多め)' : ''}`);
    });
    out.push(`シンコペーション指数 ${f.syncTotal}`);
    if (f.swingMaterial === 0) out.push('16分裏の音: なし');
    return out;
  }

  root.GrooveEngine = { scoreFromLoop, decodeSlotV2, decodeMeta, loopFromScore, analyze, propose, describe,
                        SWING_NAMES, ACCENT_NAMES, ACCENT_TPL, PART_NAMES, SCALE_NAMES, METRIC_W };
})(typeof window !== 'undefined' ? window : globalThis);
