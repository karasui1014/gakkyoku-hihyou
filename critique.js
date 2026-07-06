/* ============================================================
   HyoshaEngine ── 批評生成エンジン
   音響解析(OtoAnalyzer)と歌詞解析(KotobaAnalyzer)の結果から、
   スコア・ランク・改善案・読み物としての批評文を生成する。
   ============================================================ */
"use strict";

const HyoshaEngine = (() => {

  /* ---------- ユーティリティ ---------- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makePick(rng) {
    return arr => arr[Math.floor(rng() * arr.length) % arr.length];
  }

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  /* 範囲内なら100点、外れるほど減点 */
  function rangeScore(x, lo, hi, fallout) {
    if (x >= lo && x <= hi) return 100;
    const d = x < lo ? lo - x : x - hi;
    return clamp(100 - (d / fallout) * 100, 0, 100);
  }

  function fill(tpl, map) {
    return tpl.replace(/\{(\w+)\}/g, (_, k) => (k in map ? map[k] : `{${k}}`));
  }

  function durText(sec) {
    const m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m > 0 ? `${m}分${s}秒` : `${s}秒`;
  }

  /* 口調によって言い回しを選ぶ */
  function tonePick(tone, o) {
    if (tone === "amakuchi") return o.a;
    if (tone === "karakuchi") return o.k;
    return o.f;
  }

  /* ---------- 帯域の便利参照 ---------- */
  function bandRatio(audio, ids) {
    let r = 0;
    for (const b of audio.bands) if (ids.includes(b.id)) r += b.ratio;
    return r;
  }

  /* ---------- スコア計算 ---------- */
  function computeScores(audio, lyr, genre) {
    const g = HyoDB.genres[genre] || HyoDB.genres.free;
    const inst = lyr.isEmpty;

    /* --- 構成 --- */
    const durS = rangeScore(audio.durationSec, g.dur[0], g.dur[1], 90);
    const introS = audio.introSec <= g.intro ? 100 : clamp(100 - (audio.introSec - g.intro) * 2.2, 0, 100);
    const sectS = rangeScore(audio.sectionCount, 3, 9, 4);
    const climaxS = rangeScore(audio.climaxRatio, 1.35, 3.6, 1.2);
    const endS = audio.endsAbrupt ? 55 : (audio.hasFadeOut ? 88 : 92);
    const kousei = durS * .2 + introS * .2 + sectS * .2 + climaxS * .25 + endS * .15;

    /* --- サウンド --- */
    const clipS = audio.clipRatio > 0.002 ? 30 : audio.clipRatio > 0.0005 ? 55 : 95;
    const drS = rangeScore(audio.dynamicRange, g.dr[0], g.dr[1], 6);
    const crestS = rangeScore(audio.crest, 8, 20, 8);
    const low = bandRatio(audio, ["sub", "bass"]);
    const himid = bandRatio(audio, ["himid"]);
    const airHigh = bandRatio(audio, ["high", "air"]);
    const muddy = low > 0.62;
    const harsh = himid > 0.24 || audio.brightness > 3800;
    const dull = airHigh < 0.02 || audio.brightness < 750;
    let balS = 92;
    if (muddy) balS -= 25;
    if (harsh) balS -= 20;
    if (dull) balS -= 20;
    balS = clamp(balS, 30, 100);
    const stereoS = audio.isMono ? 50 : rangeScore(audio.stereoWidth, 0.08, 0.85, 0.3);
    const brightS = rangeScore(audio.brightness, g.bright[0], g.bright[1], 1500);
    const sound = clipS * .2 + drS * .2 + balS * .25 + stereoS * .15 + brightS * .1 + crestS * .1;

    /* --- 歌詞 or 旋律 --- */
    let kotoba, richS = 0, clicheS = 0;
    if (!inst) {
      richS = rangeScore(lyr.richness, 0.55, 0.92, 0.25);
      clicheS = clamp(95 - lyr.cliche.count * 9, 20, 95);
      const dens = (lyr.sceneDensity * 1.2 + lyr.emotionDensity) * 1000;
      const imageS = rangeScore(dens, 12, 80, 30);
      const structS = (lyr.hasChorus ? 92 : 58) * .6 + rangeScore(lyr.blocks, 3, 9, 4) * .4;
      const lenS = rangeScore(lyr.chars, 180, 800, 350);
      let base = richS * .25 + clicheS * .2 + imageS * .2 + structS * .2 + lenS * .15;
      if (lyr.domVowelRatio >= 0.42) base += 5;
      kotoba = clamp(base, 0, 100);
    } else {
      const contrastS = rangeScore(audio.centroidStd, 280, 1400, 400);
      const keyS = rangeScore(audio.key.confidence, 0.15, 1, 0.2);
      kotoba = contrastS * .35 + sectS * .25 + keyS * .2 + drS * .2;
    }

    /* --- 独自性 --- */
    const toneVarS = rangeScore(audio.centroidStd, 300, 1600, 500);
    const structUnS = rangeScore(audio.sectionCount, 4, 10, 3);
    const uniqueS = !inst
      ? clicheS * .5 + richS * .5
      : rangeScore(audio.key.confidence, 0.15, 1, 0.25);
    const widthS = audio.isMono ? 45 : rangeScore(audio.stereoWidth, 0.15, 0.9, 0.4);
    const dokuji = toneVarS * .3 + structUnS * .2 + uniqueS * .3 + widthS * .2;

    /* --- 訴求力 --- */
    const hookS = rangeScore(audio.hookStrength, 0.68, 1.1, 0.3);
    const tempoS = audio.tempo.bpm > 0
      ? rangeScore(audio.tempo.bpm, g.tempo[0], g.tempo[1], 30)
      : 60;
    const loudS = rangeScore(audio.rmsDb, -19, -8, 7);
    const chorusS = !inst
      ? (lyr.hasChorus ? (lyr.topRepeatCount >= 3 ? 92 : 82) : 62)
      : climaxS;
    const appeal = hookS * .3 + climaxS * .2 + tempoS * .2 + loudS * .15 + chorusS * .15;

    const total = kousei * .21 + sound * .22 + kotoba * .23 + dokuji * .15 + appeal * .19;

    const r = v => Math.round(clamp(v, 0, 100));
    return {
      items: [
        { id: "kousei", label: "曲の構成", value: r(kousei) },
        { id: "sound",  label: "サウンド", value: r(sound) },
        { id: "kotoba", label: inst ? "旋律・展開" : "歌詞", value: r(kotoba) },
        { id: "dokuji", label: "独自性", value: r(dokuji) },
        { id: "appeal", label: "訴求力", value: r(appeal) }
      ],
      total: r(total),
      flags: { muddy, harsh, dull, inst }
    };
  }

  /* ---------- 課題の抽出 ---------- */
  function collectIssues(audio, lyr, genre, flags) {
    const g = HyoDB.genres[genre] || HyoDB.genres.free;
    const issues = [];
    const add = (id, sev, extra) => issues.push({ id, sev, extra: extra || {} });

    if (audio.clipRatio > 0.0005) add("clipping", 10);
    if (audio.dynamicRange < g.dr[0] - 1.5) add("overCompressed", 7);
    if (audio.rmsDb < -19 && !["jazz", "bgm", "ballad"].includes(genre)) add("weakLoudness", 6);
    if (flags.muddy) add("muddy", 6);
    if (flags.harsh) add("harsh", 5);
    if (flags.dull) add("dullHigh", 5);
    if (audio.isMono) add("monoFile", 5);
    else if (audio.stereoWidth < 0.08) add("narrowStereo", 4);
    if (audio.introSec > g.intro) add("longIntro", audio.introSec > g.intro * 2 ? 6 : 4);
    if (audio.climaxRatio < 1.25) add("noClimax", genre === "bgm" ? 3 : 6);
    if (audio.centroidStd < 250) add("flatTone", 4);
    if (audio.endsAbrupt) add("abruptEnd", 3);
    if (audio.durationSec > g.dur[1] + 45) add("tooLong", 4);
    if (audio.durationSec < g.dur[0] - 30) add("tooShort", 5);
    if (audio.tempo.bpm > 0 && audio.tempo.confidence < 0.12 && !["jazz", "bgm"].includes(genre)) add("tempoUnstable", 4);
    if (audio.key.confidence < 0.15 && genre !== "bgm") add("keyAmbiguous", 3);
    if (audio.hookStrength < 0.6 && genre !== "bgm") add("weakHook", 6);

    if (!lyr.isEmpty) {
      if (lyr.cliche.count >= 2) {
        const ex = lyr.cliche.found.slice(0, 3).map(f => `「${f.word}」`).join("、");
        add("cliche", 6, { examples: ex });
      }
      if (lyr.richness < 0.55) add("lowVocab", 5);
      if (!lyr.hasChorus && genre !== "bgm") add("noStructureLyrics", 5);
      if (lyr.chars < 120) add("lyricsTooShort", 4);
      if (lyr.sceneDensity < 0.008 && lyr.emotionDensity > 0.02) add("noScene", 4);
    }

    issues.sort((a, b) => b.sev - a.sev);
    return issues;
  }

  /* ---------- ランク判定 ---------- */
  function decideRank(total, tone) {
    const th = HyoDB.tones[tone].rankTh;
    let idx = 4;
    if (total >= th[0]) idx = 0;
    else if (total >= th[1]) idx = 1;
    else if (total >= th[2]) idx = 2;
    else if (total >= th[3]) idx = 3;
    return { ...HyoDB.ranks[idx], index: idx };
  }

  /* ============================================================
     批評文の組み立て
     ============================================================ */

  function buildSoundParagraphs(a, tone, genre, pick) {
    const g = HyoDB.genres[genre] || HyoDB.genres.free;
    const ps = [];

    /* リズムと調性 */
    let p1 = "";
    if (a.tempo.bpm > 0) {
      const inRange = a.tempo.bpm >= g.tempo[0] && a.tempo.bpm <= g.tempo[1];
      p1 += `テンポはおよそ${Math.round(a.tempo.bpm)}BPM。${HyoDB.tempoFeel(a.tempo.bpm)}リズムが曲の背骨になっている。`;
      p1 += inRange
        ? `${g.label}のフィールドで違和感のない速度設定であり、この選択は的確だ。`
        : tonePick(tone, {
            a: `${g.label}としてはやや珍しい速度だが、それがこの曲の個性にもなっている。`,
            f: `${g.label}の典型からは外れた速度で、狙いがあるなら活きるが、応募先の傾向は確認しておきたい。`,
            k: `${g.label}を狙うならこの速度設定は再考の余地がある。審査側は「ジャンル理解」も見ている。`
          });
      if (a.tempo.confidence < 0.12) {
        p1 += tonePick(tone, {
          a: "ビートの輪郭は柔らかめで、これは楽曲の浮遊感にもつながっている。",
          f: "ただしビートの芯はやや曖昧で、リズムの推進力は限定的だ。",
          k: "問題はビートの芯が曖昧なことだ。体が揺れないダンスミュージックと同じで、これは致命傷になりうる。"
        });
      }
    } else {
      p1 += "明確なビートを持たない、テンポの輪郭を溶かした作りだ。";
    }
    if (a.key.confidence >= 0.15) {
      p1 += `調性は${a.key.nameJp}(${a.key.name})と推定される。${HyoDB.keyMood(a.key)}が全体を包んでいる。`;
    } else {
      p1 += "調性の中心はやや曖昧で、和声の重心が定まりきらない印象を受ける。";
    }
    ps.push(p1);

    /* 音質・ミックス */
    let p2 = `音の質感に耳を移そう。全体は${HyoDB.brightnessWord(a.brightness)}で、平均音量は${a.rmsDb}dB、ダイナミックレンジは${a.dynamicRange}dBだ。`;
    if (a.clipRatio > 0.0005) {
      p2 += tonePick(tone, {
        a: "惜しいのは、ところどころ音が天井に当たって歪んでいることだ。ここさえ直せば印象は大きく変わる。",
        f: "気になるのは波形の天井への張り付き、いわゆる音割れが検出されたことだ。提出前に必ず解消したい。",
        k: "看過できないのは音割れだ。内容を聴く前に「制作環境を管理できていない」と判断される。真っ先に直すべきである。"
      });
    } else if (a.dynamicRange < g.dr[0] - 1.5) {
      p2 += tonePick(tone, {
        a: "音圧はしっかり出ている。あとは静と動の呼吸がもう少しあると、サビがさらに映えるはずだ。",
        f: "音圧は十分だが、その代償として抑揚が平坦になっている。静かな場面の「引き」を作る余地がある。",
        k: "音圧競争に参加した結果、曲の呼吸が失われている。全部が大声の演説を誰も最後まで聴かないのと同じだ。"
      });
    } else if (a.dynamicRange > g.dr[1] + 3) {
      p2 += tonePick(tone, {
        a: "ダイナミクスが豊かに保たれているのは美点だ。仕上げの音圧調整だけ、提出先の基準に合わせたい。",
        f: "抑揚は豊かだが、現代の配信基準と並べるとやや音量が控えめに聴こえる可能性がある。",
        k: "ダイナミクスが広すぎて、他の応募作と並んだ瞬間に埋もれる音量感だ。マスタリングの詰めが甘い。"
      });
    } else {
      p2 += tonePick(tone, {
        a: "音圧と抑揚のバランスは良好で、安心して聴いていられる仕上がりだ。",
        f: "音圧と抑揚のバランスは標準的な水準を満たしている。",
        k: "音圧と抑揚のバランスは及第点。ここで減点はされないが、加点もされない。"
      });
    }
    const low = bandRatio(a, ["sub", "bass"]);
    const airHigh = bandRatio(a, ["high", "air"]);
    if (low > 0.62) p2 += "帯域バランスでは低域の比重が大きく、全体がややこもって聴こえる。";
    else if (airHigh < 0.02) p2 += "高域の空気感が薄く、音像に少し曇りがある。";
    else if (bandRatio(a, ["himid"]) > 0.24) p2 += "中高域がやや強く、長時間のリスニングでは刺さりを感じるかもしれない。";
    else p2 += "帯域バランスに大きな偏りはなく、各パートの居場所が整理されている。";
    if (a.isMono) {
      p2 += "なお音源はモノラルで書き出されている。意図的でなければステレオでの再書き出しを勧める。";
    } else if (a.stereoWidth < 0.08) {
      p2 += "ステレオの広がりは控えめで、音像が中央に密集している。";
    } else if (a.stereoWidth > 0.5) {
      p2 += "ステレオイメージは大胆に広く、空間の演出に積極的だ。";
    }
    ps.push(p2);

    /* 構成 */
    let p3 = `構成に目を向けると、${durText(a.durationSec)}の中におよそ${a.sectionCount}つのセクションが確認できる。`;
    if (a.introSec > g.intro) {
      p3 += tonePick(tone, {
        a: `イントロは${a.introSec}秒とじっくりめ。世界観の提示としては丁寧だが、少し刈り込む選択肢もある。`,
        f: `イントロは${a.introSec}秒。今の試聴環境を考えると、本編到達までをもう少し早めたい。`,
        k: `イントロに${a.introSec}秒。審査員がスキップボタンに指を伸ばすには十分な長さだ。`
      });
    } else {
      p3 += `本編への到達は${a.introSec}秒と速く、聴き手を待たせない。`;
    }
    if (a.climaxRatio >= 1.35) {
      const pos = a.climaxPosition;
      const posText = pos < 0.4 ? "前半" : pos < 0.75 ? "中盤から後半" : "終盤";
      p3 += `エネルギーの頂点は${posText}に置かれ、平均との対比は${a.climaxRatio}倍。山場は明確に設計されている。`;
    } else {
      p3 += tonePick(tone, {
        a: "エネルギーの起伏は穏やかで、BGM的な心地よさがある。ただ、コンペでは「山場」がもう一段あると強い。",
        f: "一方でエネルギーの起伏は小さく、クライマックスがどこなのかが伝わりにくい。",
        k: "最大の問題はここだ。曲全体が平坦で、サビが来たことに気づかないまま終わる。これでは印象に残りようがない。"
      });
    }
    if (a.endsAbrupt) p3 += "終わり方はやや唐突で、余韻の設計に改善の余地がある。";
    else if (a.hasFadeOut) p3 += "終盤はフェードアウトで余韻を残す作りだ。";
    else p3 += "エンディングはきちんと着地しており、聴後感は悪くない。";
    ps.push(p3);

    return ps;
  }

  function buildLyricsParagraphs(lyr, tone, pick) {
    const ps = [];

    let p1 = `歌詞は${lyr.blocks}ブロック・${lyr.lines}行、${lyr.chars}文字。`;
    if (lyr.hasChorus) {
      p1 += lyr.topRepeat
        ? `「${lyr.topRepeat.slice(0, 22)}${lyr.topRepeat.length > 22 ? "…" : ""}」というフレーズが繰り返され、曲の顔として機能している。`
        : "繰り返しのブロックが核となり、サビの構造がはっきりしている。";
    } else {
      p1 += tonePick(tone, {
        a: "明確な繰り返しを持たない、散文詩のような構成だ。物語として読ませるタイプの詞と言える。",
        f: "一方で、サビにあたる明確な繰り返しが見当たらない。意図的でなければ、核となるフレーズを立てたい。",
        k: "サビが、ない。正確には「どこがサビなのか聴き手に伝わらない」。歌モノのコンペではこれだけで大きなハンデになる。"
      });
    }
    const povText = [];
    if (lyr.selfUsed.length) povText.push(`一人称「${lyr.selfUsed[0]}」`);
    if (lyr.otherUsed.length) povText.push(`相手を指す「${lyr.otherUsed[0]}」`);
    if (povText.length === 2) p1 += `${povText.join("と")}の間に流れる感情が、詞の軸になっている。`;
    else if (povText.length === 1) p1 += `${povText[0]}の視点から綴られる、独白性の強い詞だ。`;
    ps.push(p1);

    let p2 = "";
    const dens = lyr.emotionDensity;
    if (dens > 0.03) {
      p2 += tonePick(tone, {
        a: "感情を表す言葉が惜しみなく注がれ、気持ちの熱量はまっすぐ伝わってくる。",
        f: "感情語の密度は高い。熱は伝わるが、直接的な表現に頼る場面も目立つ。",
        k: "「悲しい」「愛してる」と直接言ってしまう場面が多すぎる。感情の説明は、聴き手が感じる余白を奪う。"
      });
    } else if (dens > 0.008) {
      p2 += "感情表現は適度に抑制され、押しつけがましさがない。";
    } else {
      p2 += "感情を直接語る言葉は少なく、風景や行動に想いを託すタイプの詞だ。";
    }
    if (lyr.sceneDensity > 0.012) {
      const words = lyr.scene.found.slice(0, 3).map(f => `「${f.word}」`).join("、");
      p2 += `${words}といった情景の言葉が視覚的なイメージを立ち上げており、これは詞の確かな強みである。`;
    } else {
      p2 += tonePick(tone, {
        a: "情景描写を一行足すと、感情がさらに立体的になるだろう。",
        f: "ただ、目に浮かぶ「絵」が少ない。具体的な風景を一つ置くだけで詞は数段深くなる。",
        k: "この詞には「絵」がない。どこで、何が見えている歌なのか。カメラのない映画を観せられている気分だ。"
      });
    }
    if (lyr.cliche.count >= 2) {
      const ex = lyr.cliche.found.slice(0, 3).map(f => `「${f.word}」`).join("、");
      p2 += tonePick(tone, {
        a: `${ex}のような定番フレーズは安心感がある反面、あなたにしか書けない言葉に置き換えるともっと輝く。`,
        f: `${ex}など、使い慣らされた言い回しが複数見られる。ここが詞の個性を薄めている一因だ。`,
        k: `${ex}──何百回も聴いたフレーズの再放送だ。審査員は同じ言葉を今週すでに何十回も読んでいる。`
      });
    } else if (lyr.richness > 0.75) {
      p2 += "語彙の重複が少なく、言葉選びに独自の手触りがあるのは高く評価したい。";
    }
    if (lyr.domVowelRatio >= 0.42 && lyr.domVowel) {
      p2 += `行末には母音「${lyr.domVowel}」の響きが揃う箇所が多く、韻の意識が歌いやすさに寄与している。`;
    }
    ps.push(p2);

    return ps;
  }

  function buildInstParagraphs(a, tone, pick) {
    const ps = [];
    let p1 = "歌詞を持たないインストゥルメンタルとして、この曲は音だけで物語を運ぶ必要がある。";
    if (a.centroidStd > 500) {
      p1 += "その点、音色の表情は場面ごとによく動いており、聴き手を飽きさせない工夫が感じられる。";
    } else if (a.centroidStd > 280) {
      p1 += "音色の変化は適度にあり、場面転換は概ね伝わってくる。";
    } else {
      p1 += tonePick(tone, {
        a: "音色は一貫していて世界観は保たれているが、中盤に一度「景色の変わる瞬間」があると、さらに引き込まれる。",
        f: "ただ、音色の変化が乏しく、後半に向けて集中力が途切れやすい。展開の起伏がもう一段ほしい。",
        k: "音色が最初から最後までほぼ同じだ。3分間同じ写真を見せられて感動する人はいない。"
      });
    }
    ps.push(p1);
    return ps;
  }

  /* ---------- 3つの視点 ---------- */
  function buildPersonaQuotes(a, lyr, scores, issues, tone, genre, pick) {
    const g = HyoDB.genres[genre] || HyoDB.genres.free;
    const has = id => issues.some(i => i.id === id);
    const sc = Object.fromEntries(scores.items.map(i => [i.id, i.value]));
    const quotes = [];

    /* プロデューサー */
    let pd = [];
    if (has("clipping")) {
      pd.push(tonePick(tone, {
        a: "まず音割れだけ直しましょう。それだけで商品としての顔つきになります。",
        f: "音割れの解消が最優先ですね。ここが残っていると内容の話に進めません。",
        k: "音割れした音源を送ってくる時点で、こちらとしては次のファイルを開けたくなります。"
      }));
    }
    if (sc.appeal >= 75) {
      pd.push(tonePick(tone, {
        a: "冒頭のつかみとサビの見せ方は商業ラインに乗っています。売り込み先が想像できる曲です。",
        f: "つかみは悪くない。プレイリストに入っても数曲は生き残れる訴求力があります。",
        k: "つかみは水準以上。ただ水準以上の曲は毎週何十曲も届きます。あと一押しの「売り」を言語化してください。"
      }));
    } else {
      pd.push(tonePick(tone, {
        a: "サビの解放感をあと一段階作れると、ぐっとコンペ向きの顔になりますよ。",
        f: "現状では冒頭45秒の求心力が弱い。コンペは最初の30秒が勝負です。",
        k: "最初の30秒で手が止まりませんでした。つまり実戦なら、そこで再生を止めています。"
      }));
    }
    if (a.durationSec > g.dur[1] + 45) pd.push("尺は正直、長いです。放送やプレイリストを考えると詰める価値があります。");
    quotes.push({ by: HyoDB.personas.producer.name, text: pd.slice(0, 3).join("") });

    /* 評論家 */
    let cr = [];
    if (sc.dokuji >= 72) {
      cr.push(tonePick(tone, {
        a: "既製品をなぞらない音の選び方に、作り手の視点が宿っています。この匂いは大切にしてほしい。",
        f: "音響的な手癖に独自性の芽がある。量産型に落ちていないのは評価できます。",
        k: "独自性の芽はある。だが「芽」止まりだ。この曲でしか聴けない瞬間を、あと二つ作れたはずです。"
      }));
    } else {
      cr.push(tonePick(tone, {
        a: "丁寧に整えられた分、良くも悪くも「きれいにまとまって」います。あなたの癖をもう少し混ぜても許される曲です。",
        f: "楽曲としての破綻はない。ただ、この曲でなければならない理由がまだ弱い。",
        k: "技術的な整合性はある。しかし批評家として問いたいのは一点だけ──この曲は、世界に何を新しく足しましたか。"
      }));
    }
    if (!lyr.isEmpty) {
      cr.push(lyr.sceneDensity > 0.012
        ? "詞に風景があるのは美点です。感情を風景に語らせる書き方は、聴き手の記憶に残ります。"
        : tonePick(tone, {
            a: "詞は感情がまっすぐで好感が持てます。そこに一枚の「絵」が加わると文学になります。",
            f: "詞は気持ちの記述に寄っていて、映像が立ち上がりにくい。具体の力を借りるべきです。",
            k: "詞が感情の説明書になっています。歌詞は日記ではなく、風景で殴る文学であってほしい。"
          }));
    } else if (a.key.mode === "minor") {
      cr.push("短調の翳りを言葉に頼らず描こうとする姿勢は、インストとして正しい戦い方です。");
    }
    quotes.push({ by: HyoDB.personas.critic.name, text: cr.slice(0, 2).join("") });

    /* 一般リスナー */
    let ls = [];
    if (sc.appeal >= 75) {
      ls.push(pick([
        "最初の方でおっと思って、そのまま最後まで聴けました。",
        "通勤中に流れてきたら、曲名を調べると思います。"
      ]));
    } else if (sc.appeal >= 55) {
      ls.push("嫌いじゃないです。ただ、正直に言うと途中でスマホを見ちゃいました。");
    } else {
      ls.push(tonePick(tone, {
        a: "雰囲気は好きです。サビがもっと「来た!」ってなると、友だちにも勧めやすいかな。",
        f: "BGMとしては心地いいけど、どこがサビだったか思い出せないです。",
        k: "ごめんなさい、2回目を再生する理由が見つかりませんでした。"
      }));
    }
    if (!lyr.isEmpty && lyr.hasChorus && lyr.topRepeat) {
      ls.push(`「${lyr.topRepeat.slice(0, 14)}${lyr.topRepeat.length > 14 ? "…" : ""}」のところは口ずさめました。`);
    }
    if (scores.total >= 74) ls.push("全体的にはちゃんと「ちゃんとした曲」って感じがして、素人耳にはすごいと思いました。");
    quotes.push({ by: HyoDB.personas.listener.name, text: ls.slice(0, 2).join("") });

    return quotes;
  }

  /* ---------- 総評 ---------- */
  function buildSummary(scores, rank, tone, title, pick) {
    const best = [...scores.items].sort((a, b) => b.value - a.value)[0];
    const worst = [...scores.items].sort((a, b) => a.value - b.value)[0];
    let p = `五つの観点を採点すると、最も高いのは「${best.label}」(${best.value}点)、最も低いのは「${worst.label}」(${worst.value}点)。総合${scores.total}点で、評価は【${rank.char}:${rank.word}】とした。`;
    p += tonePick(tone, {
      a: `つまりこの曲の伸びしろは「${worst.label}」に集中しているということだ。裏を返せば、直す場所が明確なのは幸運である。`,
      f: `「${worst.label}」の底上げが、総合点を最も効率よく押し上げる。`,
      k: `コンペで問われるのは平均点ではなく、減点項目の少なさだ。「${worst.label}」${worst.value}点は、審査表の上では十分な落選理由になる。`
    });
    const closing = fill(pick(HyoDB.closings[tone]), { title, rankDesc: rank.desc });
    return [p, closing];
  }

  /* ---------- メイン ---------- */
  function generate({ audio, lyrics, tone, genre, title }) {
    const lyr = lyrics && !lyrics.isEmpty ? lyrics : { isEmpty: true };
    const seed = Math.round(audio.durationSec * 1000) ^ (audio.brightness << 8) ^ ((lyr.chars || 0) << 4);
    const rng = mulberry32(seed || 42);
    const pick = makePick(rng);

    const scores = computeScores(audio, lyr, genre);
    const issues = collectIssues(audio, lyr, genre, scores.flags);
    const rank = decideRank(scores.total, tone);
    const g = HyoDB.genres[genre] || HyoDB.genres.free;

    /* 冒頭 */
    const opening = fill(pick(HyoDB.openings[tone]), {
      title,
      durText: durText(audio.durationSec),
      tempoFeel: HyoDB.tempoFeel(audio.tempo.bpm),
      keyMood: HyoDB.keyMood(audio.key),
      genre: g.label
    });

    const sections = [];
    sections.push({ heading: "第一印象", paragraphs: [opening] });
    sections.push({ heading: "サウンドと構成", paragraphs: buildSoundParagraphs(audio, tone, genre, pick) });
    sections.push(lyr.isEmpty
      ? { heading: "旋律と展開", paragraphs: buildInstParagraphs(audio, tone, pick) }
      : { heading: "歌詞の世界", paragraphs: buildLyricsParagraphs(lyr, tone, pick) });
    sections.push({
      heading: "3つの視点から",
      paragraphs: [],
      quotes: buildPersonaQuotes(audio, lyr, scores, issues, tone, genre, pick)
    });
    sections.push({ heading: "総評", paragraphs: buildSummary(scores, rank, tone, title, pick) });

    /* 改善案 */
    const maxIssues = HyoDB.tones[tone].maxIssues;
    const improvements = issues.slice(0, maxIssues).map(i => {
      const adv = HyoDB.advice[i.id];
      return { title: adv.title, detail: fill(adv.detail, i.extra) };
    });
    if (improvements.length === 0) {
      improvements.push({
        title: "大きな技術的欠点は見つかりませんでした",
        detail: "ここから先は好みと文脈の世界です。ミックスの微調整、歌詞の一語の置き換えなど、細部の磨き込みを重ねてください。"
      });
    }

    /* 技術データ */
    const tech = [
      ["曲の長さ", durText(audio.durationSec)],
      ["推定テンポ", audio.tempo.bpm > 0 ? `${Math.round(audio.tempo.bpm)} BPM` : "検出できず"],
      ["推定キー", audio.key.confidence >= 0.1 ? `${audio.key.nameJp}(${audio.key.name})` : "曖昧"],
      ["平均音量(RMS)", `${audio.rmsDb} dB`],
      ["ピーク", `${audio.peakDb} dB`],
      ["ダイナミックレンジ", `${audio.dynamicRange} dB`],
      ["ステレオ幅", audio.isMono ? "モノラル" : `${Math.round(audio.stereoWidth * 100)}%`],
      ["音色の明るさ(重心)", `${audio.brightness} Hz`],
      ["セクション数(推定)", `${audio.sectionCount}`],
      ["イントロ長", `${audio.introSec} 秒`],
      ["音割れ", audio.clipRatio > 0.0005 ? "検出あり" : "なし"],
      ["歌詞", lyr.isEmpty ? "なし(インスト)" : `${lyr.lines}行・${lyr.chars}文字`]
    ];

    return { scores, rank, sections, improvements, tech, tone, genre, title };
  }

  /* テキスト書き出し用 */
  function toPlainText(result) {
    const lines = [];
    lines.push(`■ ${result.title} ── 批評結果`);
    lines.push(`総合評価:${result.rank.char}(${result.rank.word})/ ${result.scores.total}点`);
    lines.push(`口調:${HyoDB.tones[result.tone].label} ジャンル:${(HyoDB.genres[result.genre] || HyoDB.genres.free).label}`);
    lines.push("");
    for (const it of result.scores.items) lines.push(`・${it.label}:${it.value}点`);
    lines.push("");
    for (const sec of result.sections) {
      lines.push(`【${sec.heading}】`);
      for (const p of sec.paragraphs) lines.push(p);
      if (sec.quotes) for (const q of sec.quotes) lines.push(`「${q.text}」──${q.by}`);
      lines.push("");
    }
    lines.push("【改善案】");
    result.improvements.forEach((im, i) => {
      lines.push(`${i + 1}. ${im.title}`);
      lines.push(`   ${im.detail}`);
    });
    return lines.join("\n");
  }

  return { generate, toPlainText, computeScores };
})();
