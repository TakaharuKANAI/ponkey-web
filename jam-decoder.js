// PONKEY JAM — 音への変換 (SpectroStream デコーダ) を別スレッドで回す Web Worker。
// 生成 (temporal + depth) と同じ ONNX Runtime で同時に run すると壊れる (WASM が再入できない) ので、
// ランタイムごと分ける。depth が 12 段ぶん GPU⇔CPU 往復している間に、こちらが GPU を使える。
//
// 受け取るもの (順番どおりに処理する):
//   {type:'init', dec:ArrayBuffer(onnx), quant:ArrayBuffer(fp16), dsj:{keys,shapes}}  → {type:'ready'}
//   {type:'reset'}                                                                   状態キャッシュを 0 に
//   {type:'decode', id, codes:[[12]...]}  → {type:'pcm', id, pcm:Float32Array(左右交互), ms}
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/ort.webgpu.min.mjs';
ort.env.wasm.numThreads = 1;
ort.env.webgpu.powerPreference = 'high-performance';

let sess = null, DSJ = null, DSTATE = null, QUANT = null;
const f32 = (a, dims) => new ort.Tensor('float32', a, dims);
const dispose = t => { try { t && t.dispose && t.dispose(); } catch (e) {} };

function f16(u) { const s = (u & 0x8000) >> 15, e = (u & 0x7c00) >> 10, f = u & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : (s ? -1 : 1) * Infinity;
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024); }

function reset() {
  if (DSTATE) Object.values(DSTATE).forEach(dispose);
  DSTATE = {};
  DSJ.keys.forEach((k, i) => { const sh = DSJ.shapes[k]; DSTATE['s_' + i] = f32(new Float32Array(sh.reduce((a, b) => a * b, 1)), sh); });
}

async function decode(frames) {
  const F = frames.length, dd = 256, out = new Float32Array(F * dd);          // 12 段の符号 → 256 次元 (段ごとの表を足す)
  for (let t = 0; t < F; t++) for (let q = 0; q < 12; q++) { const o = (q * 1024 + frames[t][q]) * dd; for (let i = 0; i < dd; i++) out[t * dd + i] += QUANT[o + i]; }
  const feed = { embeddings: f32(out, [1, F, dd]) };
  DSJ.keys.forEach((k, i) => feed['s_' + i] = DSTATE['s_' + i]);
  const r = await sess.run(feed);
  DSJ.keys.forEach((k, i) => { dispose(DSTATE['s_' + i]); DSTATE['s_' + i] = r['ns_' + i]; });
  dispose(feed.embeddings);
  const d = r.waveform.data ?? await r.waveform.getData();
  const pcm = new Float32Array(d); dispose(r.waveform);
  return pcm;
}

async function handle(m) {
  if (m.type === 'init') {
    DSJ = m.dsj;
    const u = new Uint16Array(m.quant), n = 12 * 1024 * 256;                  // 使うのは先頭 12 段だけ
    QUANT = new Float32Array(n); for (let i = 0; i < n; i++) QUANT[i] = f16(u[i]);
    const loc = {}; DSJ.keys.forEach((_, i) => loc['ns_' + i] = 'gpu-buffer');  // 31 個の状態は GPU に置いたまま
    sess = await ort.InferenceSession.create(new Uint8Array(m.dec), { executionProviders: ['webgpu'], preferredOutputLocation: loc });
    reset();
    postMessage({ type: 'ready' });
  } else if (m.type === 'reset') {
    reset();
  } else if (m.type === 'decode') {
    const t = performance.now();
    const pcm = await decode(m.codes);
    postMessage({ type: 'pcm', id: m.id, pcm, ms: performance.now() - t }, [pcm.buffer]);
  }
}

// async の onmessage は await のところで次のメッセージに割り込まれるので、1本の鎖に並べて順番に処理する
let chain = Promise.resolve();
onmessage = e => {
  chain = chain.then(() => handle(e.data)).catch(err => postMessage({ type: 'error', message: (err && err.message) || String(err) }));
};
