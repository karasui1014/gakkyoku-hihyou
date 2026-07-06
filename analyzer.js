/* ============================================================
   OtoAnalyzer ── 音響解析エンジン
   Web Audio APIで音源をデコードし、FFTベースで
   テンポ・調性・ダイナミクス・帯域バランス・構成を解析する。
   すべて端末内で完結し、外部への通信は行わない。
   ============================================================ */
"use strict";

const OtoAnalyzer = (() => {

  const FRAME = 2048;   // FFTサイズ
  const HOP = 512;      // ホップ長
  const TARGET_SR = 22050;

  /* ---------- FFT(基数2・反復型) ---------- */
  function makeFFT(n) {
    const levels = Math.round(Math.log2(n));
    const cosT = new Float32Array(n / 2);
    const sinT = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cosT[i] = Math.cos(2 * Math.PI * i / n);
      sinT[i] = Math.sin(2 * Math.PI * i / n);
    }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i, r = 0;
      for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    return function fft(re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tre = re[l] * cosT[k] + im[l] * sinT[k];
            const tim = im[l] * cosT[k] - re[l] * sinT[k];
            re[l] = re[j] - tre; im[l] = im[j] - tim;
            re[j] += tre; im[j] += tim;
          }
        }
      }
    };
  }

  function hannWindow(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    return w;
  }

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[idx];
  }

  function toDb(x) { return 20 * Math.log10(Math.max(x, 1e-8)); }

  /* ---------- Krumhansl-Schmuckler 調性プロファイル ---------- */
  const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const NOTE_NAMES_JP = ["ハ", "嬰ハ", "ニ", "嬰ニ", "ホ", "ヘ", "嬰ヘ", "ト", "嬰ト", "イ", "嬰イ", "ロ"];

  function pearson(a, b) {
    const n = a.length;
    let sa = 0, sb = 0;
    for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
    const ma = sa / n, mb = sb / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      const xa = a[i] - ma, xb = b[i] - mb;
      num += xa * xb; da += xa * xa; db += xb * xb;
    }
    const den = Math.sqrt(da * db);
    return den > 1e-12 ? num / den : 0;
  }

  function estimateKey(chroma) {
    let total = 0;
    for (let i = 0; i < 12; i++) total += chroma[i];
    if (total <= 1e-9) return { name: "不明", nameJp: "不明", mode: "unknown", confidence: 0, tonic: -1 };
    const results = [];
    for (let root = 0; root < 12; root++) {
      const maj = new Array(12), min = new Array(12);
      for (let i = 0; i < 12; i++) {
        maj[i] = MAJOR_PROFILE[(i - root + 12) % 12];
        min[i] = MINOR_PROFILE[(i - root + 12) % 12];
      }
      results.push({ tonic: root, mode: "major", score: pearson(chroma, maj) });
      results.push({ tonic: root, mode: "minor", score: pearson(chroma, min) });
    }
    results.sort((a, b) => b.score - a.score);
    const best = results[0], second = results[1];
    const conf = Math.max(0, Math.min(1, (best.score - second.score) * 4 + best.score * 0.4));
    const modeJp = best.mode === "major" ? "長調" : "短調";
    const modeEn = best.mode === "major" ? "Major" : "Minor";
    return {
      name: `${NOTE_NAMES[best.tonic]} ${modeEn}`,
      nameJp: `${NOTE_NAMES_JP[best.tonic]}${modeJp}`,
      mode: best.mode,
      tonic: best.tonic,
      confidence: conf
    };
  }

  /* ---------- テンポ推定(オンセット包絡の自己相関) ---------- */
  function estimateTempo(flux, fps) {
    const n = flux.length;
    if (n < fps * 8) return { bpm: 0, confidence: 0, stability: 0 };

    // 局所平均を引いてオンセットを強調
    const env = new Float32Array(n);
    const w = Math.max(1, Math.round(fps * 1.0));
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += flux[i];
      if (i >= w) sum -= flux[i - w];
      const mean = sum / Math.min(i + 1, w);
      env[i] = Math.max(0, flux[i] - mean);
    }

    const minLag = Math.max(2, Math.floor(60 / 200 * fps));   // 200 BPM
    const maxLag = Math.ceil(60 / 55 * fps);                  // 55 BPM
    const acLen = Math.min(n - 1, maxLag * 2 + 2);
    const ac = new Float32Array(acLen + 1);
    for (let lag = 1; lag <= acLen; lag++) {
      let s = 0;
      for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
      ac[lag] = s / (n - lag);
    }

    let acMean = 0, cnt = 0;
    for (let lag = minLag; lag <= maxLag; lag++) { acMean += ac[lag]; cnt++; }
    acMean = cnt ? acMean / cnt : 0;

    let bestScore = -Infinity, bestLag = minLag;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const bpm = 60 * fps / lag;
      // 実用テンポ帯(90〜140)をゆるく優遇
      const weight = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 1.0, 2));
      const dbl = lag * 2 <= acLen ? ac[lag * 2] : 0;   // 倍テンポの支持
      const score = (ac[lag] + 0.45 * dbl) * weight;
      if (score > bestScore) { bestScore = score; bestLag = lag; }
    }

    // 放物線補間でラグを微調整
    let lagF = bestLag;
    if (bestLag > minLag && bestLag < acLen - 1) {
      const y0 = ac[bestLag - 1], y1 = ac[bestLag], y2 = ac[bestLag + 1];
      const denom = y0 - 2 * y1 + y2;
      if (Math.abs(denom) > 1e-12) {
        const delta = 0.5 * (y0 - y2) / denom;
        if (Math.abs(delta) < 1) lagF = bestLag + delta;
      }
    }

    const bpm = 60 * fps / lagF;
    const confidence = acMean > 1e-12 ? Math.max(0, Math.min(1, (ac[bestLag] / acMean - 1) / 3)) : 0;

    // 前半・後半で別々に推定して安定度を測る
    const half = Math.floor(n / 2);
    const bpmA = subTempo(env.subarray(0, half), fps, minLag, maxLag);
    const bpmB = subTempo(env.subarray(half), fps, minLag, maxLag);
    let stability = 0;
    if (bpmA > 0 && bpmB > 0) {
      const ratio = Math.max(bpmA, bpmB) / Math.min(bpmA, bpmB);
      const r = Math.min(ratio, 2 / ratio < 1 ? ratio : ratio); // 倍半分は同一視
      const near = Math.min(Math.abs(ratio - 1), Math.abs(ratio - 2), Math.abs(ratio - 0.5));
      stability = Math.max(0, 1 - near * 6);
    }
    // オンセットがほぼ無い(ビートレスな)音源では誤検出を避ける
    if (confidence < 0.02) return { bpm: 0, confidence: 0, stability: 0 };
    return { bpm: Math.round(bpm * 10) / 10, confidence, stability };
  }

  function subTempo(env, fps, minLag, maxLag) {
    const n = env.length;
    if (n < maxLag * 2) return 0;
    let bestScore = -Infinity, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
      s /= (n - lag);
      const bpm = 60 * fps / lag;
      const weight = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 1.0, 2));
      if (s * weight > bestScore) { bestScore = s * weight; bestLag = lag; }
    }
    return bestLag ? 60 * fps / bestLag : 0;
  }

  /* ---------- 帯域定義 ---------- */
  const BANDS = [
    { id: "sub",    label: "超低域(〜60Hz)",       lo: 0,    hi: 60 },
    { id: "bass",   label: "低域(60〜150Hz)",      lo: 60,   hi: 150 },
    { id: "lowmid", label: "中低域(150〜400Hz)",   lo: 150,  hi: 400 },
    { id: "mid",    label: "中域(400〜1.5kHz)",    lo: 400,  hi: 1500 },
    { id: "himid",  label: "中高域(1.5〜4kHz)",    lo: 1500, hi: 4000 },
    { id: "high",   label: "高域(4〜9kHz)",        lo: 4000, hi: 9000 },
    { id: "air",    label: "超高域(9kHz〜)",       lo: 9000, hi: 99999 }
  ];

  /* ---------- ファイルのデコード ---------- */
  async function decodeFile(file) {
    const buf = await file.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    try {
      return await ctx.decodeAudioData(buf);
    } finally {
      ctx.close().catch(() => {});
    }
  }

  /* ---------- メイン解析 ---------- */
  async function analyzeBuffer(audio, onProgress) {
    const progress = typeof onProgress === "function" ? onProgress : () => {};
    const sr = audio.sampleRate;
    const chs = audio.numberOfChannels;
    const len = audio.length;
    const durationSec = audio.duration;

    if (durationSec < 5) throw new Error("音源が短すぎます(5秒以上の楽曲をアップロードしてください)。");

    const ch0 = audio.getChannelData(0);
    const ch1 = chs > 1 ? audio.getChannelData(1) : null;

    progress(0.02, "ステレオ感を測定しています…");

    /* --- ステレオ相関・ピーク・クリッピング --- */
    let sumLR = 0, sumLL = 0, sumRR = 0;
    let peak = 0, clipped = 0, clipRun = 0;
    const stride = 4;
    for (let i = 0; i < len; i += stride) {
      const l = ch0[i];
      const r = ch1 ? ch1[i] : l;
      sumLR += l * r; sumLL += l * l; sumRR += r * r;
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > peak) peak = a;
      if (a >= 0.985) { clipRun++; if (clipRun >= 2) clipped++; }
      else clipRun = 0;
    }
    const corrDen = Math.sqrt(sumLL * sumRR);
    const stereoCorr = corrDen > 1e-12 ? sumLR / corrDen : 1;
    const stereoWidth = ch1 ? Math.max(0, Math.min(1, 1 - stereoCorr)) : 0;
    const clipRatio = clipped / (len / stride);

    progress(0.05, "音声をモノラル合成しています…");

    /* --- モノラル化 + ダウンサンプリング --- */
    const factor = Math.max(1, Math.round(sr / TARGET_SR));
    const dsr = sr / factor;
    const dlen = Math.floor(len / factor);
    const mono = new Float32Array(dlen);
    for (let i = 0; i < dlen; i++) {
      let acc = 0;
      const base = i * factor;
      for (let k = 0; k < factor; k++) {
        const idx = base + k;
        acc += ch1 ? (ch0[idx] + ch1[idx]) * 0.5 : ch0[idx];
      }
      mono[i] = acc / factor;
    }

    /* --- フレーム解析 --- */
    const nFrames = Math.max(1, Math.floor((dlen - FRAME) / HOP) + 1);
    const fft = makeFFT(FRAME);
    const win = hannWindow(FRAME);
    const re = new Float32Array(FRAME);
    const im = new Float32Array(FRAME);
    const mag = new Float32Array(FRAME / 2);
    const prevMag = new Float32Array(FRAME / 2);

    const fluxArr = new Float32Array(nFrames);
    const rmsArr = new Float32Array(nFrames);
    const centroidArr = new Float32Array(nFrames);
    const chroma = new Float32Array(12);
    const bandEnergy = new Float32Array(BANDS.length);

    // ビン→ピッチクラス / 帯域 の対応表
    const binPc = new Int8Array(FRAME / 2).fill(-1);
    const binBand = new Int8Array(FRAME / 2).fill(-1);
    for (let k = 1; k < FRAME / 2; k++) {
      const f = k * dsr / FRAME;
      if (f >= 55 && f <= 5000) {
        const midi = 69 + 12 * Math.log2(f / 440);
        binPc[k] = ((Math.round(midi) % 12) + 12) % 12;
      }
      for (let b = 0; b < BANDS.length; b++) {
        if (f >= BANDS[b].lo && f < BANDS[b].hi) { binBand[k] = b; break; }
      }
    }

    const fps = dsr / HOP;
    let rolloffSum = 0;

    for (let fi = 0; fi < nFrames; fi++) {
      const off = fi * HOP;
      let rms = 0;
      for (let i = 0; i < FRAME; i++) {
        const s = mono[off + i];
        re[i] = s * win[i];
        im[i] = 0;
        rms += s * s;
      }
      rmsArr[fi] = Math.sqrt(rms / FRAME);

      fft(re, im);

      let flux = 0, cNum = 0, cDen = 0, totalE = 0;
      for (let k = 1; k < FRAME / 2; k++) {
        const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        mag[k] = m;
        const d = m - prevMag[k];
        if (d > 0) flux += d;
        prevMag[k] = m;
        const f = k * dsr / FRAME;
        cNum += f * m; cDen += m;
        const e = m * m;
        totalE += e;
        if (binPc[k] >= 0) chroma[binPc[k]] += e;
        if (binBand[k] >= 0) bandEnergy[binBand[k]] += e;
      }
      fluxArr[fi] = flux;
      centroidArr[fi] = cDen > 1e-9 ? cNum / cDen : 0;

      // ロールオフ(85%)
      let accE = 0, roll = 0;
      const target = totalE * 0.85;
      for (let k = 1; k < FRAME / 2; k++) {
        accE += mag[k] * mag[k];
        if (accE >= target) { roll = k * dsr / FRAME; break; }
      }
      rolloffSum += roll;

      if ((fi & 255) === 0) {
        progress(0.08 + 0.62 * fi / nFrames, "周波数を分解しています…");
        await new Promise(r => setTimeout(r, 0));
      }
    }

    progress(0.72, "テンポを推定しています…");
    await new Promise(r => setTimeout(r, 0));

    /* --- ラウドネス・ダイナミクス --- */
    const dbArr = Array.from(rmsArr, v => toDb(v));
    const maxDb = Math.max(...dbArr);
    const activeDb = dbArr.filter(d => d > maxDb - 40).sort((a, b) => a - b);
    const rmsDb = activeDb.length
      ? toDb(Math.sqrt(rmsArr.reduce((s, v) => s + v * v, 0) / rmsArr.length))
      : -60;
    const peakDb = toDb(peak);
    const dynamicRange = percentile(activeDb, 0.95) - percentile(activeDb, 0.10);
    const crest = peakDb - rmsDb;

    /* --- テンポ --- */
    const tempo = estimateTempo(fluxArr, fps);

    progress(0.8, "キー(調)を判定しています…");
    await new Promise(r => setTimeout(r, 0));

    /* --- 調性 --- */
    const key = estimateKey(chroma);

    /* --- 帯域バランス --- */
    let bandTotal = 0;
    for (let b = 0; b < BANDS.length; b++) bandTotal += bandEnergy[b];
    const bands = BANDS.map((b, i) => ({
      id: b.id, label: b.label,
      ratio: bandTotal > 1e-12 ? bandEnergy[i] / bandTotal : 0
    }));

    /* --- スペクトル統計 --- */
    const activeIdx = [];
    for (let i = 0; i < nFrames; i++) if (dbArr[i] > maxDb - 40) activeIdx.push(i);
    let cMean = 0;
    for (const i of activeIdx) cMean += centroidArr[i];
    cMean = activeIdx.length ? cMean / activeIdx.length : 0;
    let cVar = 0;
    for (const i of activeIdx) cVar += Math.pow(centroidArr[i] - cMean, 2);
    const centroidStd = activeIdx.length ? Math.sqrt(cVar / activeIdx.length) : 0;

    progress(0.86, "曲の構成を読み取っています…");
    await new Promise(r => setTimeout(r, 0));

    /* --- 秒単位の構成解析 --- */
    const secLen = Math.max(1, Math.floor(nFrames / fps));
    const secE = new Float32Array(secLen);
    const secC = new Float32Array(secLen);
    for (let s = 0; s < secLen; s++) {
      const from = Math.floor(s * fps), to = Math.min(nFrames, Math.floor((s + 1) * fps));
      let e = 0, c = 0, n = 0;
      for (let i = from; i < to; i++) { e += rmsArr[i] * rmsArr[i]; c += centroidArr[i]; n++; }
      secE[s] = n ? Math.sqrt(e / n) : 0;
      secC[s] = n ? c / n : 0;
    }

    const secESorted = [...secE].sort((a, b) => a - b);
    const e90 = percentile(secESorted, 0.9) || 1e-9;
    const eMeanActive = (() => {
      const act = secESorted.filter(v => v > e90 * 0.1);
      return act.length ? act.reduce((s, v) => s + v, 0) / act.length : 1e-9;
    })();

    // セクション境界(エネルギー・音色の急変)
    const novelty = [];
    for (let s = 1; s < secLen; s++) {
      const de = Math.abs(secE[s] - secE[s - 1]) / (eMeanActive + 1e-9);
      const dc = Math.abs(secC[s] - secC[s - 1]) / (cMean + 1e-9);
      novelty.push(de * 0.7 + dc * 0.55);
    }
    const novMean = novelty.reduce((s, v) => s + v, 0) / Math.max(1, novelty.length);
    const novStd = Math.sqrt(novelty.reduce((s, v) => s + Math.pow(v - novMean, 2), 0) / Math.max(1, novelty.length));
    const boundaries = [];
    let lastB = -99;
    for (let i = 0; i < novelty.length; i++) {
      if (novelty[i] > novMean + 1.4 * novStd && i - lastB >= 7) {
        boundaries.push(i + 1);
        lastB = i;
      }
    }
    const sectionCount = boundaries.length + 1;

    // クライマックス(8秒窓の最大エネルギー / 平均)
    let maxWin = 0, maxWinAt = 0;
    const winSec = 8;
    for (let s = 0; s + winSec <= secLen; s++) {
      let e = 0;
      for (let k = 0; k < winSec; k++) e += secE[s + k];
      e /= winSec;
      if (e > maxWin) { maxWin = e; maxWinAt = s; }
    }
    const climaxRatio = eMeanActive > 1e-12 ? maxWin / eMeanActive : 1;
    const climaxPosition = secLen > 0 ? maxWinAt / secLen : 0;

    // イントロ長(エネルギーが本編水準に達するまで)
    let introSec = 0;
    for (let s = 0; s < secLen; s++) {
      if (secE[s] > e90 * 0.35) { introSec = s; break; }
    }

    // 終わり方(フェード or ブツ切り)
    const tail = Math.min(8, secLen);
    let fadeSlope = 0;
    if (tail >= 4) {
      const a = toDb(Math.max(secE[secLen - tail], 1e-8));
      const b = toDb(Math.max(secE[secLen - 1], 1e-8));
      fadeSlope = (b - a) / tail; // dB/秒
    }
    const lastE = secE[secLen - 1] || 0;
    const endsAbrupt = lastE > e90 * 0.5 && fadeSlope > -2;
    const hasFadeOut = fadeSlope < -1.2;

    // 冒頭のつかみ(最初の45秒に山があるか)
    const first45 = Math.min(45, secLen);
    let firstMax = 0;
    for (let s = 0; s < first45; s++) if (secE[s] > firstMax) firstMax = secE[s];
    const hookStrength = e90 > 1e-12 ? firstMax / e90 : 0;

    progress(0.94, "批評の準備をしています…");
    await new Promise(r => setTimeout(r, 0));

    return {
      durationSec, sampleRate: sr, channels: chs,
      peakDb: Math.round(peakDb * 10) / 10,
      rmsDb: Math.round(rmsDb * 10) / 10,
      crest: Math.round(crest * 10) / 10,
      dynamicRange: Math.round(dynamicRange * 10) / 10,
      clipRatio,
      stereoWidth: Math.round(stereoWidth * 100) / 100,
      isMono: !ch1,
      tempo,
      key,
      bands,
      brightness: Math.round(cMean),
      centroidStd: Math.round(centroidStd),
      rolloff: Math.round(rolloffSum / nFrames),
      sectionCount,
      boundaries,
      climaxRatio: Math.round(climaxRatio * 100) / 100,
      climaxPosition: Math.round(climaxPosition * 100) / 100,
      introSec,
      endsAbrupt,
      hasFadeOut,
      hookStrength: Math.round(hookStrength * 100) / 100
    };
  }

  async function analyzeFile(file, onProgress) {
    const progress = typeof onProgress === "function" ? onProgress : () => {};
    progress(0.0, "音声を読み込んでいます…");
    let audio;
    try {
      audio = await decodeFile(file);
    } catch (e) {
      throw new Error("このファイルを音声として読み込めませんでした。MP3 / WAV / M4A / AAC / FLAC / OGG 形式をお試しください。");
    }
    return analyzeBuffer(audio, onProgress);
  }

  return { analyzeFile, analyzeBuffer };
})();
