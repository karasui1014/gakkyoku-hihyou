/* ============================================================
   KotobaAnalyzer ── 歌詞解析エンジン
   構成・語彙・感情語・情景語・常套句・韻などを解析する。
   ============================================================ */
"use strict";

const KotobaAnalyzer = (() => {

  const EMOTION_WORDS = [
    "愛", "恋", "好き", "嫌い", "泣", "涙", "笑", "嬉し", "悲し", "切な",
    "寂し", "淋し", "痛", "怖", "憎", "会いたい", "苦し", "幸せ", "不安",
    "孤独", "祈", "願", "想い", "思い出", "後悔", "未練", "憧れ", "ときめ",
    "焦が", "愛し", "恋し", "胸が", "心が"
  ];

  const SCENE_WORDS = [
    "空", "海", "風", "花", "雨", "星", "月", "太陽", "光", "闇", "夜",
    "朝", "夕", "雲", "雪", "桜", "波", "森", "川", "街", "窓", "部屋",
    "電車", "駅", "教室", "季節", "春", "夏", "秋", "冬", "夕焼け", "夜明け",
    "地平線", "水平線", "坂道", "改札", "信号", "路地", "屋上", "海岸"
  ];

  const CLICHE_PHRASES = [
    "君に会いたい", "忘れない", "ありのまま", "歩き出す", "歩いていこう",
    "翼を広げ", "明日へ", "未来へ", "願いを込め", "抱きしめて",
    "かけがえのない", "輝く未来", "涙を拭いて", "ひとりじゃない",
    "一人じゃない", "そばにいるよ", "夢を諦め", "君がいれば",
    "手を伸ばし", "星に願い", "奇跡", "運命", "永遠に", "君と出会えた",
    "ずっと一緒", "強くなれる", "負けないで", "大丈夫だよ", "歩き続け",
    "信じ続け", "きっと届く", "君のもとへ", "夢を叶え"
  ];

  const PRONOUNS_SELF = ["僕", "私", "俺", "あたし", "ぼく", "わたし"];
  const PRONOUNS_OTHER = ["君", "あなた", "きみ", "お前", "あの子", "あいつ"];

  /* かな→母音(行末の響き解析用) */
  const VOWEL_TABLE = {
    a: "あかがさざただなはばぱまやらわゃアカガサザタダナハバパマヤラワャァ",
    i: "いきぎしじちぢにひびぴみりイキギシジチヂニヒビピミリィ",
    u: "うくぐすずつづぬふぶぷむゆるゅウクグスズツヅヌフブプムユルュゥヴ",
    e: "えけげせぜてでねへべぺめれェエケゲセゼテデネヘベペメレ",
    o: "おこごそぞとどのほぼぽもよろをょオコゴソゾトドノホボポモヨロヲョォ",
    n: "んンっッ"
  };

  function vowelOf(ch) {
    for (const v of Object.keys(VOWEL_TABLE)) {
      if (VOWEL_TABLE[v].includes(ch)) return v;
    }
    return null;
  }

  function lastKanaVowel(line) {
    for (let i = line.length - 1; i >= 0; i--) {
      const ch = line[i];
      if (ch === "ー" || ch === "〜" || /[\s、。!?!?…・()「」『』]/.test(ch)) continue;
      const v = vowelOf(ch);
      if (v && v !== "n") return v;
      if (/[a-zA-Z]/.test(ch)) {
        const m = line.slice(0, i + 1).match(/[aiueoAIUEO](?=[^aiueoAIUEO]*$)/);
        return m ? m[0].toLowerCase() : null;
      }
      return v; // 漢字などは null
    }
    return null;
  }

  function countMatches(text, words) {
    const found = [];
    let count = 0;
    for (const w of words) {
      let idx = 0, c = 0;
      while ((idx = text.indexOf(w, idx)) !== -1) { c++; idx += w.length; }
      if (c > 0) { found.push({ word: w, count: c }); count += c; }
    }
    return { count, found };
  }

  function analyze(rawText) {
    const text = (rawText || "").replace(/\r\n?/g, "\n").trim();
    if (!text) return { isEmpty: true };

    const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(b => b.length > 0);
    const flat = lines.join("");
    const chars = flat.length;

    /* 文字種の割合 */
    const kanji = (flat.match(/[一-鿿々]/g) || []).length;
    const hira = (flat.match(/[ぁ-ゖ]/g) || []).length;
    const kata = (flat.match(/[ァ-ヺー]/g) || []).length;
    const latin = (flat.match(/[a-zA-Z]/g) || []).length;

    /* 行の反復(サビらしさ) */
    const lineMap = new Map();
    for (const l of lines) lineMap.set(l, (lineMap.get(l) || 0) + 1);
    let repeatedLines = 0, topRepeat = null, topRepeatCount = 1;
    for (const [l, c] of lineMap) {
      if (c >= 2) {
        repeatedLines += c;
        if (c > topRepeatCount) { topRepeatCount = c; topRepeat = l; }
      }
    }
    const repetitionRatio = lines.length ? repeatedLines / lines.length : 0;

    /* ブロックの反復(コーラス構造) */
    const blockMap = new Map();
    for (const b of blocks) {
      const norm = b.replace(/\s/g, "");
      blockMap.set(norm, (blockMap.get(norm) || 0) + 1);
    }
    const hasRepeatedBlock = [...blockMap.values()].some(c => c >= 2);
    const hasChorus = hasRepeatedBlock || topRepeatCount >= 2;

    /* 語彙の豊かさ(文字バイグラムのユニーク率) */
    const bigrams = new Set();
    let bigramTotal = 0;
    for (let i = 0; i < flat.length - 1; i++) {
      bigrams.add(flat.slice(i, i + 2));
      bigramTotal++;
    }
    const richness = bigramTotal ? bigrams.size / bigramTotal : 0;

    /* 感情語・情景語・常套句 */
    const emotion = countMatches(flat, EMOTION_WORDS);
    const scene = countMatches(flat, SCENE_WORDS);
    const cliche = countMatches(flat, CLICHE_PHRASES);
    const emotionDensity = chars ? emotion.count / chars : 0;
    const sceneDensity = chars ? scene.count / chars : 0;

    /* 人称 */
    const selfUsed = PRONOUNS_SELF.filter(p => flat.includes(p));
    const otherUsed = PRONOUNS_OTHER.filter(p => flat.includes(p));

    /* 行の長さ */
    const lens = lines.map(l => l.length);
    const lenMean = lens.reduce((s, v) => s + v, 0) / lines.length;
    const lenStd = Math.sqrt(lens.reduce((s, v) => s + Math.pow(v - lenMean, 2), 0) / lines.length);

    /* 行末の母音(韻の気配) */
    const vowels = lines.map(lastKanaVowel).filter(v => v);
    const vowelCount = {};
    for (const v of vowels) vowelCount[v] = (vowelCount[v] || 0) + 1;
    let domVowel = null, domVowelRatio = 0;
    for (const [v, c] of Object.entries(vowelCount)) {
      const r = vowels.length ? c / vowels.length : 0;
      if (r > domVowelRatio) { domVowelRatio = r; domVowel = v; }
    }

    /* その他 */
    const questions = (flat.match(/[??]/g) || []).length;
    const exclaims = (flat.match(/[!!]/g) || []).length;
    const englishRatio = chars ? latin / chars : 0;

    return {
      isEmpty: false,
      lines: lines.length,
      blocks: blocks.length,
      chars,
      kanjiRatio: chars ? kanji / chars : 0,
      hiraRatio: chars ? hira / chars : 0,
      kataRatio: chars ? kata / chars : 0,
      englishRatio,
      repetitionRatio,
      topRepeat,
      topRepeatCount,
      hasChorus,
      richness,
      emotion,
      scene,
      cliche,
      emotionDensity,
      sceneDensity,
      selfUsed,
      otherUsed,
      lenMean: Math.round(lenMean * 10) / 10,
      lenStd: Math.round(lenStd * 10) / 10,
      domVowel,
      domVowelRatio: Math.round(domVowelRatio * 100) / 100,
      questions,
      exclaims
    };
  }

  return { analyze };
})();
