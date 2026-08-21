/* ============================================================================
   ※ このファイルの正本は ponkey-midi リポジトリの web/ponkey.js。
     修正はまず正本に入れて、このコピーへ同期すること (直接編集しない)。
   ========================================================================= */
/* ============================================================================
   ponkey.js — PONKEY Control Protocol クライアント (v0.1, 2026-08-21)

   FW柔軟化メモ Phase 4 の「1本書いて100アプリ全てこれ経由」の種。
   対応 FW: v4.5.68+ (能力ネゴ)。旧 FW にも接続はできる (caps.protocol = 0 になる)。

   プロトコルの正本はファームのヘッダ:
     - CC 番号 / FEAT ビット: PONKEY_V2_DATA_STRUCTURES.h
     - デバッグサービス / SONG_CMD: PONKEY_V2_DEBUG.h と .ino の SONG_CMD_* 定義
   人間向けの説明: PONKEY_CONTROL_PROTOCOL.md

   使い方 (プレーンな <script src="../ponkey.js"> で window.Ponkey が生える):
     const p = new Ponkey();
     p.on('caps',    c => console.log('FW', c.version, c.features));
     p.on('keydown', e => console.log('grid key', e.key, e.ts));
     await p.connect();                      // MIDI + デバッグ両サービスに接続
     if (p.hasFeature('LED_RGB_FRAME')) p.ledSet(0, 255, 0, 0);
   ========================================================================= */
(function (global) {
'use strict';

// ---- UUID (正本: PONKEY_V2_DEBUG.h) ----
const UUID_MIDI_SERVICE  = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
const UUID_MIDI_CHAR     = '7772e5db-3868-4112-a1a9-f2669d106bf3';
const UUID_DEBUG_SERVICE = '504f4e4b-4559-4442-5047-445342000001';
const UUID_DEBUG_LOG     = '504f4e4b-4559-4442-5047-445442000002';
const UUID_DEBUG_CMD     = '504f4e4b-4559-4442-5047-445443000003';

// ---- CC 番号 (正本: PONKEY_V2_DATA_STRUCTURES.h) ----
const CC = {
  VOICE_SELECT: 0x30, LOOP_LENGTH: 0x31, OCTAVE: 0x32, PART_VOLUME: 0x33,
  MASTER_VOLUME: 0x34, GROOVE_SWING: 0x35, GROOVE_ACCENT: 0x36,
  SYNTH_SCALE: 0x37, KEY: 0x38, LED_PAINT: 0x39,
  PROTOCOL: 0x3a, FEATURES: 0x3b, FEATURES2: 0x3c, FEATURES3: 0x3d,
  PLAY_STOP: 0x40, BPM: 0x41, SLOT_SELECT: 0x20,
  STATE_REQUEST: 0x50, STATE_SYNC_START: 0x51, HEARTBEAT: 0x52, BAR_SYNC: 0x54,
};

// ---- 機能ビット (ページ0 = CC_FEATURES / ページ1 = CC_FEATURES2) ----
const FEAT_P0 = {
  GROOVE: 1 << 0, SYNTH_SCALE: 1 << 1, CH16_PASSTHRU: 1 << 2,
  LED_PAINT: 1 << 3, SCALE_UNIFIED: 1 << 4, SONG_DUMP: 1 << 5, COMMIT_SLOT: 1 << 6,
};
const FEAT_P1 = {
  LED_RGB_FRAME: 1 << 0, SOL_API: 1 << 1, PASSTHRU_DECL: 1 << 2,
  KEY_EVENTS: 1 << 3, TABLES: 1 << 4, CLAIM: 1 << 5,
  UI_STATE: 1 << 6,   // v4.5.72: DBG_EV_MODE_UI + SONG_META 拡張
};
const FEAT_P2 = {   // v4.5.73 (CC_FEATURES3 0x3D)
  LED32: 1 << 0, SOL_SING: 1 << 1,
};

// ---- デバッグサービスのパケット/コマンド (正本: PONKEY_V2_DEBUG.h) ----
const DBG_PACKET_MAGIC = 0xa5, DBG_PACKET_HEADER_LEN = 11;
const DBG_CMD_MAGIC = 0xa6;
const DBG_CMD = { LOG_ENABLE_ALL: 0x01, LOG_DISABLE_ALL: 0x02, LOG_ENABLE_CAT: 0x03,
                  LOG_DISABLE_CAT: 0x04, GET_FW_VERSION: 0x06, GET_CAPS: 0x07 };
const DBG_CAT = { SYSTEM: 0x00, MODE: 0x01, KEY: 0x02, SONG: 0x09 };
const SYS_EV  = { BOOT: 0x01, READY: 0x02, CAPS: 0x03, CLAIM: 0x04 };
const MODE_EV = { UI: 0x10 };   // v4.5.72
const KEY_EV  = { GRID_DOWN: 0x01, GRID_UP: 0x02, PART_DOWN: 0x03, PART_UP: 0x04,
                  FN_DOWN: 0x05, FN_UP: 0x06 };
const SONG_EV = { SLOT_DUMP: 0x09, META: 0x0a, COMMIT: 0x0b };

// ---- SONG_MAGIC コマンド (正本: .ino の SONG_CMD_*) ----
const SONG_MAGIC = 0x5a;
const SONG_CMD = { ENTER: 0x01, EXIT: 0x02, LOAD_SLOT: 0x04, SET_SEQUENCE: 0x05,
                   SET_MUTE: 0x06, DUMP_SLOT: 0x07, COMMIT_SLOT: 0x08,
                   LED_FRAME: 0x09, SOL: 0x0a, PASSTHRU: 0x0b, TABLE: 0x0c, CLAIM: 0x0d,
                   LED32: 0x0e };

class Ponkey {
  constructor() {
    this.device = null;
    this.midiChar = null;
    this.dbgCmdChar = null;
    this.caps = { protocol: 0, features: 0, features2: 0, features3: 0, version: null };
    this._handlers = {};
    this._sendQueue = Promise.resolve();   // GATT write は直列化する
  }

  on(ev, cb) { (this._handlers[ev] = this._handlers[ev] || []).push(cb); return this; }
  _emit(ev, arg) { (this._handlers[ev] || []).forEach(cb => { try { cb(arg); } catch (e) { console.error(e); } }); }

  hasFeature(name) {
    if (name in FEAT_P0) return !!(this.caps.features  & FEAT_P0[name]);
    if (name in FEAT_P1) return !!(this.caps.features2 & FEAT_P1[name]);
    if (name in FEAT_P2) return !!(this.caps.features3 & FEAT_P2[name]);
    return false;
  }

  // ---- 接続 --------------------------------------------------------------
  async connect({ namePrefix = 'PONKEY', debug = true, keyEvents = false } = {}) {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix }],
      optionalServices: [UUID_MIDI_SERVICE, UUID_DEBUG_SERVICE],
    });
    this.device.addEventListener('gattserverdisconnected', () => this._emit('disconnect'));
    const server = await this.device.gatt.connect();

    const midiSvc = await server.getPrimaryService(UUID_MIDI_SERVICE);
    this.midiChar = await midiSvc.getCharacteristic(UUID_MIDI_CHAR);
    await this.midiChar.startNotifications();
    this.midiChar.addEventListener('characteristicvaluechanged',
      ev => this._onMidi(new Uint8Array(ev.target.value.buffer)));

    if (debug) {
      try {
        const dbgSvc = await server.getPrimaryService(UUID_DEBUG_SERVICE);
        const logChar = await dbgSvc.getCharacteristic(UUID_DEBUG_LOG);
        this.dbgCmdChar = await dbgSvc.getCharacteristic(UUID_DEBUG_CMD);
        await logChar.startNotifications();
        logChar.addEventListener('characteristicvaluechanged',
          ev => this._onDbg(new Uint8Array(ev.target.value.buffer)));
        // 購読開始 (FW は最初のコマンドで「クライアントが居る」と判断し SYS_CAPS を自己紹介してくる)
        await this._dbgCmd(DBG_CMD.LOG_DISABLE_ALL);
        await this._dbgCmd(DBG_CMD.LOG_ENABLE_CAT, [DBG_CAT.SYSTEM]);
        await this._dbgCmd(DBG_CMD.LOG_ENABLE_CAT, [DBG_CAT.SONG]);
        await this._dbgCmd(DBG_CMD.LOG_ENABLE_CAT, [DBG_CAT.MODE]);   // v4.5.72: モードUI通知
        if (keyEvents) await this.subscribeKeys();
        await this._dbgCmd(DBG_CMD.GET_CAPS);
      } catch (e) {
        console.warn('ponkey.js: debug service unavailable', e);
      }
    }
    return this;
  }
  disconnect() { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); }

  // ---- 受信: BLE-MIDI ----------------------------------------------------
  _onMidi(buf) {
    // FW の実形式 (sendMIDIOverBLE / bleBatch): [header(0x80|ts_hi)] のあと、
    // イベントごとに [tsLow(0x80|ts_lo)][status][d1][d2] が続く (バッチで複数連結)。
    // running status は使われない。PC/ChPressure (2バイト系) にも念のため対応。
    let i = 1;                                     // buf[0] = header
    while (i < buf.length) {
      let b = buf[i];
      if (b & 0x80) {                              // timestamp byte を1つ読み飛ばす
        i++;
        if (i >= buf.length) break;
        b = buf[i];
      }
      if (!(b & 0x80)) { i++; continue; }          // status でない迷子バイトは読み飛ばして回復
      const status = b, cmd = status & 0xf0, ch = status & 0x0f;
      const nData = (cmd === 0xc0 || cmd === 0xd0) ? 1 : 2;
      const d1 = (i + 1 < buf.length) ? buf[i + 1] : 0;
      const d2 = (nData === 2 && i + 2 < buf.length) ? buf[i + 2] : 0;
      if (cmd === 0xb0) {
        if (d1 === CC.PROTOCOL)       { this.caps.protocol  = d2; }
        else if (d1 === CC.FEATURES)  { this.caps.features  = d2; }
        else if (d1 === CC.FEATURES2) { this.caps.features2 = d2; this._emit('caps', this.caps); }
        else if (d1 === CC.FEATURES3) { this.caps.features3 = d2; }
        this._emit('cc', { cc: d1, val: d2, ch });
      } else if (cmd === 0x90 || cmd === 0x80) {
        this._emit('note', { on: cmd === 0x90 && d2 > 0, ch, note: d1, vel: d2 });
      }
      i += 1 + nData;
    }
  }

  // ---- 受信: デバッグサービス ---------------------------------------------
  _onDbg(p) {
    if (p.length < DBG_PACKET_HEADER_LEN || p[0] !== DBG_PACKET_MAGIC) return;
    const ts = p[4] | (p[5] << 8) | (p[6] << 16) | (p[7] << 24);
    const cat = p[8], ev = p[9], len = p[10];
    const d = p.slice(DBG_PACKET_HEADER_LEN, DBG_PACKET_HEADER_LEN + len);
    if (cat === DBG_CAT.SYSTEM && ev === SYS_EV.CAPS) {
      this.caps.protocol  = d[0] || 0;
      this.caps.features  = d[1] || 0;
      this.caps.features2 = d[2] || 0;
      this.caps.version   = new TextDecoder().decode(d.slice(3));
      this._emit('caps', this.caps);
    } else if (cat === DBG_CAT.SYSTEM && ev === SYS_EV.CLAIM) {
      this._emit('claim', { grid: !!(d[0] & 1), partKeys: !!(d[0] & 2) });
    } else if (cat === DBG_CAT.KEY) {
      const map = { [KEY_EV.GRID_DOWN]: 'keydown', [KEY_EV.GRID_UP]: 'keyup',
                    [KEY_EV.PART_DOWN]: 'partdown', [KEY_EV.PART_UP]: 'partup',
                    [KEY_EV.FN_DOWN]: 'fndown', [KEY_EV.FN_UP]: 'fnup' };
      if (map[ev]) this._emit(map[ev], { key: d[0], ts });
    } else if (cat === DBG_CAT.MODE && ev === MODE_EV.UI) {
      // v4.5.72: モードUI通知。アプリはこれを正とし、キーイベントからの状態推定をやめてよい
      this._emit('modeui', {
        fnSubmode: d[0], currentMode: d[1], previousMode: d[2],
        fx: !!(d[3] & 0x01), interior: !!(d[3] & 0x02), test: !!(d[3] & 0x04),
        silent: !!(d[3] & 0x08), recording: !!(d[3] & 0x10),
        interiorSong: d[4] === 0xff ? null : d[4], ts,
      });
    } else if (cat === DBG_CAT.SONG && ev === SONG_EV.COMMIT) {
      this._emit('commit', { mask: d[0] | (d[1] << 8) });
    } else if (cat === DBG_CAT.SONG && ev === SONG_EV.META) {
      this._emit('songmeta', d);
    } else if (cat === DBG_CAT.SONG && ev === SONG_EV.SLOT_DUMP) {
      this._emit('slotdump', d);
    }
    this._emit('dbg', { cat, ev, ts, data: d });
  }

  // ---- 送信 (直列化) ------------------------------------------------------
  _write(char, bytes) {
    this._sendQueue = this._sendQueue.then(() =>
      char.writeValueWithoutResponse
        ? char.writeValueWithoutResponse(new Uint8Array(bytes))
        : char.writeValue(new Uint8Array(bytes)));
    return this._sendQueue;
  }
  sendMIDI(status, d1, d2) { return this._write(this.midiChar, [0x80, 0x80, status, d1, d2]); }
  sendCC(cc, val, ch = 0)  { return this.sendMIDI(0xb0 | ch, cc & 0x7f, val & 0x7f); }
  noteOn(ch, note, vel = 100) { return this.sendMIDI(0x90 | ch, note & 0x7f, vel & 0x7f); }
  noteOff(ch, note)           { return this.sendMIDI(0x80 | ch, note & 0x7f, 0); }
  _dbgCmd(cmd, payload = []) {
    if (!this.dbgCmdChar) return Promise.resolve();
    return this._write(this.dbgCmdChar, [DBG_CMD_MAGIC, cmd, payload.length, ...payload]);
  }
  _song(cmd, payload = []) {
    if (!this.dbgCmdChar) throw new Error('ponkey.js: debug service not connected');
    return this._write(this.dbgCmdChar, [SONG_MAGIC, cmd, 0 /*deviceId*/, ...payload]);
  }

  // ---- 高レベル API -------------------------------------------------------
  subscribeKeys() { return this._dbgCmd(DBG_CMD.LOG_ENABLE_CAT, [DBG_CAT.KEY]); }   // 聞き耳 (Phase 2-④)

  // 光 (Phase 2-①): frame = 16要素の [r,g,b] 配列
  ledFrame(frame) {
    const p = [];
    for (let k = 0; k < 16; k++) { const c = frame[k] || [0, 0, 0]; p.push(c[0] & 0xff, c[1] & 0xff, c[2] & 0xff); }
    return this._song(SONG_CMD.LED_FRAME, p);
  }
  ledSet(key, r, g, b) { return this._song(SONG_CMD.LED_FRAME, [key & 15, r & 0xff, g & 0xff, b & 0xff]); }
  ledClear()           { return this.ledFrame([]); }

  // 動き (Phase 2-③)
  solFire(key, vel = 0)      { return this._song(SONG_CMD.SOL, [0, key & 15, vel & 0x7f]); }
  // v4.5.73: hold 中のバーを可聴 PWM で歌わせる (50-2000Hz、共有タイマーなのでユニゾン)。
  //   使い方: solHold(...) で上げてから solSing(freq)。全 hold 解放か solSingStop() で無音に戻る
  solSing(freqHz)            { const f = Math.max(50, Math.min(2000, Math.round(freqHz))); return this._song(SONG_CMD.SOL, [4, f & 0xff, (f >> 8) & 0xff]); }
  solSingStop()              { return this._song(SONG_CMD.SOL, [4, 0, 0]); }
  // v4.5.73: 32 LED 個別 (led = key*2 + which)。frame32 = 32要素の [r,g,b]
  led32Frame(frame32) {
    const p = [];
    for (let l = 0; l < 32; l++) { const c = frame32[l] || [0, 0, 0]; p.push(c[0] & 0xff, c[1] & 0xff, c[2] & 0xff); }
    return this._song(SONG_CMD.LED32, p);
  }
  led32Set(led, r, g, b)     { return this._song(SONG_CMD.LED32, [led & 31, r & 0xff, g & 0xff, b & 0xff]); }
  solHold(key, ms = 2000)    { return this._song(SONG_CMD.SOL, [1, key & 15, Math.min(200, Math.round(ms / 10)) & 0xff]); }
  solRelease(key)            { return this._song(SONG_CMD.SOL, [2, key & 15]); }
  solAllOff()                { return this._song(SONG_CMD.SOL, [3, 0]); }

  // 音 (Phase 2-②): channels = 1始まりの ch 番号配列 (例 [16])。ch1 は FW 側で拒否される
  passthru(channels) {
    let m = 0; channels.forEach(ch => { if (ch >= 2 && ch <= 16) m |= 1 << (ch - 1); });
    return this._song(SONG_CMD.PASSTHRU, [m & 0xff, (m >> 8) & 0xff]);
  }

  // テーブル持ち込み (Phase 3)。part: 'BASS'|'LEAD'|'PAD' または 0-2 / P1-P3 は 3-5
  _partIdx(part) { return typeof part === 'number' ? part : { BASS: 0, LEAD: 1, PAD: 2, P1: 3, P2: 4, P3: 5 }[part]; }
  uploadNoteTable(part, notes16) { return this._song(SONG_CMD.TABLE, [0, this._partIdx(part), ...notes16.slice(0, 16).map(n => n & 0x7f)]); }
  clearNoteTable(part)           { return this._song(SONG_CMD.TABLE, [0, this._partIdx(part)]); }
  uploadVelocityTable(pct16)     { return this._song(SONG_CMD.TABLE, [1, 0, ...pct16.slice(0, 16).map(v => Math.min(200, v) & 0xff)]); }
  clearVelocityTable()           { return this._song(SONG_CMD.TABLE, [1, 0]); }
  uploadSwingCurve(pct4)         { return this._song(SONG_CMD.TABLE, [2, 0, ...pct4.slice(0, 4).map(v => Math.min(200, v) & 0xff)]); }
  clearSwingCurve()              { return this._song(SONG_CMD.TABLE, [2, 0]); }

  // 入力 claim (Phase 3)。切断か Fn 2秒長押しで必ず解放される
  claim({ grid = false, partKeys = false } = {}) { return this._song(SONG_CMD.CLAIM, [(grid ? 1 : 0) | (partKeys ? 2 : 0)]); }
  release()                                      { return this._song(SONG_CMD.CLAIM, [0]); }

  // 保存 (§3): 明示コミット / 読み出し
  commitSlot(slot = 0xff) { return this._song(SONG_CMD.COMMIT_SLOT, [slot & 0xff]); }
  commitAll()             { return this._song(SONG_CMD.COMMIT_SLOT, [0xfe]); }
  dumpSlot(slot = 0xff)   { return this._song(SONG_CMD.DUMP_SLOT, [slot & 0xff]); }

  // ソングモード (SEQUENCE / song 系アプリ用)
  songEnter()             { return this._song(SONG_CMD.ENTER); }
  songExit()              { return this._song(SONG_CMD.EXIT); }
  loadSlot(slot, bytes)   { return this._song(SONG_CMD.LOAD_SLOT, [slot & 15, ...bytes]); }
  setSequence(slotIds)    { return this._song(SONG_CMD.SET_SEQUENCE, [slotIds.length & 0xff, ...slotIds.map(x => x & 15)]); }
  setMute(muteMask, soloMask = 0) { return this._song(SONG_CMD.SET_MUTE, [muteMask & 0x7f, soloMask & 0x7f]); }

  // 生の低レベル送信 (移行期のアプリ固有処理用。新規コードは上の高レベル API を使うこと)
  songRaw(cmd, payload = [])   { return this._song(cmd, payload); }
  dbgRaw(cmd, payload = [])    { return this._dbgCmd(cmd, payload); }
}

Ponkey.CC = CC; Ponkey.FEAT_P0 = FEAT_P0; Ponkey.FEAT_P1 = FEAT_P1; Ponkey.FEAT_P2 = FEAT_P2;
Ponkey.SONG_CMD = SONG_CMD; Ponkey.DBG_CAT = DBG_CAT;
global.Ponkey = Ponkey;
})(typeof window !== 'undefined' ? window : globalThis);
