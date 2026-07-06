/* ============================================================
   app.js ── UI制御
   ファイル受付・解析実行・結果描画・履歴・保存/コピー/印刷。
   すべての動的テキストは textContent 経由で挿入し、
   HTMLインジェクションを防止する。
   ============================================================ */
"use strict";

(() => {

  const $ = id => document.getElementById(id);

  const els = {
    dropzone: $("dropzone"),
    fileInput: $("file-input"),
    fileInfo: $("file-info"),
    fileName: $("file-name"),
    fileClear: $("file-clear"),
    audioPreview: $("audio-preview"),
    titleInput: $("title-input"),
    genreSelect: $("genre-select"),
    lyricsInput: $("lyrics-input"),
    analyzeBtn: $("analyze-btn"),
    progressPanel: $("progress-panel"),
    progressMessage: $("progress-message"),
    progressBar: $("progress-bar"),
    resultPanel: $("result-panel"),
    resultTitle: $("result-title"),
    resultSub: $("result-sub"),
    rankChar: $("rank-char"),
    rankWord: $("rank-word"),
    radar: $("radar-canvas"),
    scoreList: $("score-list"),
    critiqueBody: $("critique-body"),
    kaizenList: $("kaizen-list"),
    techList: $("tech-list"),
    tategakiToggle: $("tategaki-toggle"),
    copyBtn: $("copy-btn"),
    saveBtn: $("save-btn"),
    printBtn: $("print-btn"),
    historyList: $("history-list"),
    historyEmpty: $("history-empty"),
    historyClear: $("history-clear")
  };

  const MAX_FILE_SIZE = 100 * 1024 * 1024;
  const HISTORY_KEY = "gakkyoku_hihyou_history_v1";
  const HISTORY_MAX = 20;

  let currentFile = null;
  let currentObjectUrl = null;
  let currentResult = null;
  let currentMode = "futsuu";
  let analyzing = false;

  /* ============ ファイル受付 ============ */

  function isAudioFile(file) {
    if (file.type && file.type.startsWith("audio/")) return true;
    return /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|aif|aiff)$/i.test(file.name);
  }

  function setFile(file) {
    if (!file) return;
    if (!isAudioFile(file)) {
      alert("音声ファイル(MP3 / WAV / M4A / AAC / FLAC / OGG)を選択してください。");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      alert("ファイルサイズが100MBを超えています。より小さいファイルをお試しください。");
      return;
    }
    currentFile = file;
    els.fileName.textContent = `${file.name}(${(file.size / 1024 / 1024).toFixed(1)}MB)`;
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(file);
    els.audioPreview.src = currentObjectUrl;
    els.fileInfo.hidden = false;
    els.analyzeBtn.disabled = false;
  }

  function clearFile() {
    currentFile = null;
    if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
    els.audioPreview.removeAttribute("src");
    els.audioPreview.load();
    els.fileInfo.hidden = true;
    els.fileInput.value = "";
    els.analyzeBtn.disabled = true;
  }

  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.dropzone.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.fileInput.click(); }
  });
  els.fileInput.addEventListener("change", () => setFile(els.fileInput.files[0]));

  ["dragover", "dragenter"].forEach(ev =>
    els.dropzone.addEventListener(ev, e => { e.preventDefault(); els.dropzone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach(ev =>
    els.dropzone.addEventListener(ev, e => { e.preventDefault(); els.dropzone.classList.remove("dragover"); }));
  els.dropzone.addEventListener("drop", e => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setFile(f);
  });
  els.fileClear.addEventListener("click", clearFile);

  /* ============ 口調セレクタ ============ */

  document.querySelectorAll(".seal-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seal-btn").forEach(b => {
        b.classList.remove("selected");
        b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("selected");
      btn.setAttribute("aria-checked", "true");
      currentMode = btn.dataset.mode;
    });
  });

  /* ============ 解析実行 ============ */

  els.analyzeBtn.addEventListener("click", async () => {
    if (!currentFile || analyzing) return;
    analyzing = true;
    els.analyzeBtn.disabled = true;
    els.resultPanel.hidden = true;
    els.progressPanel.hidden = false;
    els.progressBar.style.width = "0%";
    els.progressPanel.scrollIntoView({ behavior: "smooth", block: "center" });

    const onProgress = (frac, msg) => {
      els.progressBar.style.width = `${Math.round(frac * 100)}%`;
      if (msg) els.progressMessage.textContent = msg;
    };

    try {
      const audio = await OtoAnalyzer.analyzeFile(currentFile, onProgress);
      onProgress(0.96, "批評文を執筆しています…");
      await new Promise(r => setTimeout(r, 30));

      const lyrics = KotobaAnalyzer.analyze(els.lyricsInput.value);
      const title = (els.titleInput.value || "").trim() ||
        currentFile.name.replace(/\.[^.]+$/, "") || "無題";

      const result = HyoshaEngine.generate({
        audio, lyrics,
        tone: currentMode,
        genre: els.genreSelect.value,
        title
      });

      onProgress(1, "完成しました");
      currentResult = result;
      renderResult(result);
      saveHistory(result);
      els.progressPanel.hidden = true;
      els.resultPanel.hidden = false;
      els.resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      els.progressPanel.hidden = true;
      alert(err && err.message ? err.message : "解析中にエラーが発生しました。別のファイルでお試しください。");
    } finally {
      analyzing = false;
      els.analyzeBtn.disabled = !currentFile;
    }
  });

  /* ============ 結果描画 ============ */

  function renderResult(result) {
    els.resultTitle.textContent = result.title;
    const toneLabel = HyoDB.tones[result.tone].label;
    const genreLabel = (HyoDB.genres[result.genre] || HyoDB.genres.free).label;
    const now = new Date();
    els.resultSub.textContent =
      `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ・ 口調:${toneLabel} ・ ジャンル:${genreLabel} ・ 総合${result.scores.total}点`;

    els.rankChar.textContent = result.rank.char;
    els.rankWord.textContent = result.rank.word;

    /* スコアバー */
    els.scoreList.textContent = "";
    for (const item of result.scores.items) {
      const row = document.createElement("div");
      row.className = "score-item";
      const name = document.createElement("span");
      name.className = "score-name";
      name.textContent = item.label;
      const track = document.createElement("div");
      track.className = "score-track";
      const fill = document.createElement("div");
      fill.className = "score-fill";
      fill.style.width = "0%";
      track.appendChild(fill);
      const val = document.createElement("span");
      val.className = "score-val";
      val.textContent = String(item.value);
      row.append(name, track, val);
      els.scoreList.appendChild(row);
      requestAnimationFrame(() => { fill.style.width = `${item.value}%`; });
    }

    drawRadar(result.scores.items);

    /* 批評本文 */
    els.critiqueBody.textContent = "";
    els.critiqueBody.classList.remove("tategaki");
    els.tategakiToggle.classList.remove("active");
    els.tategakiToggle.textContent = "縦書きで読む";
    for (const sec of result.sections) {
      const h = document.createElement("h3");
      h.textContent = sec.heading;
      els.critiqueBody.appendChild(h);
      for (const p of sec.paragraphs) {
        const el = document.createElement("p");
        el.textContent = p;
        els.critiqueBody.appendChild(el);
      }
      if (sec.quotes) {
        for (const q of sec.quotes) {
          const bq = document.createElement("blockquote");
          const t = document.createElement("span");
          t.textContent = q.text;
          const c = document.createElement("cite");
          c.textContent = `── ${q.by}`;
          bq.append(t, c);
          els.critiqueBody.appendChild(bq);
        }
      }
    }

    /* 改善案 */
    els.kaizenList.textContent = "";
    for (const im of result.improvements) {
      const li = document.createElement("li");
      const head = document.createElement("span");
      head.className = "kaizen-head";
      head.textContent = im.title;
      const detail = document.createElement("span");
      detail.className = "kaizen-detail";
      detail.textContent = im.detail;
      li.append(head, detail);
      els.kaizenList.appendChild(li);
    }

    /* 技術データ */
    els.techList.textContent = "";
    for (const [k, v] of result.tech) {
      const div = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      div.append(dt, dd);
      els.techList.appendChild(div);
    }
  }

  /* ============ レーダーチャート ============ */

  function drawRadar(items) {
    const cv = els.radar;
    const dpr = window.devicePixelRatio || 1;
    const W = 360, H = 330;
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = W + "px";
    cv.style.height = H + "px";
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2, cy = H / 2 + 8, R = 108;
    const n = items.length;
    const angle = i => -Math.PI / 2 + i * 2 * Math.PI / n;

    /* グリッド */
    ctx.strokeStyle = "#d8cca8";
    ctx.fillStyle = "#fbf6e9";
    for (let ring = 5; ring >= 1; ring--) {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = angle(i % n), r = R * ring / 5;
        const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      if (ring === 5) ctx.fill();
      ctx.stroke();
    }
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = angle(i);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + R * Math.cos(a), cy + R * Math.sin(a));
    }
    ctx.stroke();

    /* データ */
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const it = items[i % n];
      const a = angle(i % n), r = R * it.value / 100;
      const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.fillStyle = "rgba(199, 62, 58, 0.16)";
    ctx.strokeStyle = "#c73e3a";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();

    /* 頂点とラベル */
    ctx.font = "600 12px 'Hiragino Sans', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < n; i++) {
      const it = items[i];
      const a = angle(i);
      const px = cx + (R * it.value / 100) * Math.cos(a);
      const py = cy + (R * it.value / 100) * Math.sin(a);
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = "#c73e3a";
      ctx.fill();

      const lx = cx + (R + 26) * Math.cos(a);
      const ly = cy + (R + 22) * Math.sin(a);
      ctx.fillStyle = "#2b2620";
      ctx.fillText(it.label, lx, ly - 7);
      ctx.fillStyle = "#c73e3a";
      ctx.font = "700 13px 'Hiragino Sans', sans-serif";
      ctx.fillText(String(it.value), lx, ly + 9);
      ctx.font = "600 12px 'Hiragino Sans', sans-serif";
    }
  }

  /* ============ ツールバー ============ */

  els.tategakiToggle.addEventListener("click", () => {
    const on = els.critiqueBody.classList.toggle("tategaki");
    els.tategakiToggle.classList.toggle("active", on);
    els.tategakiToggle.textContent = on ? "横書きに戻す" : "縦書きで読む";
  });

  els.copyBtn.addEventListener("click", async () => {
    if (!currentResult) return;
    const text = HyoshaEngine.toPlainText(currentResult);
    try {
      await navigator.clipboard.writeText(text);
      flashBtn(els.copyBtn, "コピーしました");
    } catch {
      flashBtn(els.copyBtn, "コピーできませんでした");
    }
  });

  els.saveBtn.addEventListener("click", () => {
    if (!currentResult) return;
    const text = HyoshaEngine.toPlainText(currentResult);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `批評_${currentResult.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  els.printBtn.addEventListener("click", () => window.print());

  function flashBtn(btn, msg) {
    const orig = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = orig; }, 1600);
  }

  /* ============ 履歴 ============ */

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  function saveHistory(result) {
    try {
      const arr = loadHistory();
      arr.unshift({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ts: Date.now(),
        title: result.title,
        tone: result.tone,
        genre: result.genre,
        rank: result.rank,
        scores: result.scores,
        sections: result.sections,
        improvements: result.improvements,
        tech: result.tech
      });
      while (arr.length > HISTORY_MAX) arr.pop();
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
    } catch { /* 容量超過などは無視(履歴は補助機能) */ }
    renderHistory();
  }

  function deleteHistory(id) {
    try {
      const arr = loadHistory().filter(h => h.id !== id);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
    } catch { }
    renderHistory();
  }

  function renderHistory() {
    const arr = loadHistory();
    els.historyList.textContent = "";
    els.historyEmpty.hidden = arr.length > 0;
    els.historyClear.hidden = arr.length === 0;

    for (const h of arr) {
      const li = document.createElement("li");
      li.className = "history-item";

      const rank = document.createElement("span");
      rank.className = "history-rank";
      rank.textContent = h.rank.char;

      const info = document.createElement("div");
      info.className = "history-info";
      const t = document.createElement("p");
      t.className = "history-title";
      t.textContent = h.title;
      const m = document.createElement("p");
      m.className = "history-meta";
      const d = new Date(h.ts);
      m.textContent = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ・ ${HyoDB.tones[h.tone].label} ・ 総合${h.scores.total}点`;
      info.append(t, m);

      const del = document.createElement("button");
      del.className = "history-del";
      del.type = "button";
      del.textContent = "×";
      del.setAttribute("aria-label", "この履歴を削除");
      del.addEventListener("click", e => {
        e.stopPropagation();
        deleteHistory(h.id);
      });

      li.append(rank, info, del);
      li.addEventListener("click", () => {
        currentResult = h;
        renderResult(h);
        els.resultPanel.hidden = false;
        els.resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      els.historyList.appendChild(li);
    }
  }

  els.historyClear.addEventListener("click", () => {
    if (!confirm("批評の履歴をすべて削除しますか?")) return;
    try { localStorage.removeItem(HISTORY_KEY); } catch { }
    renderHistory();
  });

  renderHistory();

  /* ============ Service Worker(PWA) ============ */

  if ("serviceWorker" in navigator &&
      (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => { });
    });
  }

})();
