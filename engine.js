// 出題の仕組み。ブラウザと Node の両方で動く(依存なし)。仕様は docs/app.md。
// createRun(data, options, seed) は純粋な関数: 同じ種なら同じ問題・同じ選択肢の並びになる。

// フルスペル → 略語の向きは外した(2026-11-05 ユーザー判断。略語を見て思い出す練習にならないため)
export const DIRECTIONS = ["expansion", "summary"];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 比べるための形: 大文字小文字・区切り(空白・ハイフン・スラッシュ・カンマ・&)を落とす
export function squash(s) {
  return String(s).toLowerCase().replace(/[^0-9a-z]/g, "");
}

function heads(s) {
  return String(s)
    .split(/[\s\-/,&]+/)
    .filter((w) => w && /[A-Z0-9]/.test(w[0]))
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export function editDistance(a, b) {
  a = a.toUpperCase();
  b = b.toUpperCase();
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// その語の正しい書き方の集合(squash した形)
export function correctForms(item) {
  return new Set([item.expansion, ...(item.variants || [])].filter(Boolean).map(squash));
}

// 綴りの近い語・同じ綴りで意味の違う語(似た略語の組)
export function partnersOf(item, pool) {
  const a = item.acronym.toUpperCase();
  return pool.filter((o) => {
    if (o.id === item.id) return false;
    const b = o.acronym.toUpperCase();
    if (a === b) return true;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    if (shorter.length >= 2 && longer.includes(shorter)) return true;
    return a.length >= 3 && b.length >= 3 && editDistance(a, b) === 1;
  });
}

function pickDistinct(cands, n, exclude) {
  const out = [];
  const seen = new Set(exclude);
  for (const c of cands) {
    const k = squash(c);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length === n) break;
  }
  return out;
}



const NEAR = 12; // 似た語を、近い順にこの数だけ候補にする
const NEAR_MIX = 6; // 候補のうち、近い方のこの数を混ぜて選ぶ(足りなければ残りの候補を近い順に使う)

// 範囲ごとの下ごしらえ(似た語・組の相手・分野ごとの語)。同じ範囲なら作り直さない
const indexCache = new WeakMap();
function buildIndex(pool) {
  const upper = (it) => it.acronym.toUpperCase();
  const partners = new Map();
  const nearHeads = new Map();
  const byField = new Map();
  const headOf = new Map(pool.map((it) => [it.id, heads(it.expansion || "")]));
  for (const it of pool) {
    partners.set(it.id, partnersOf(it, pool));
    // 区切りを除くと同じになる略語(DA と D/A)も候補にしない(誤答として外され、候補が足りなくなるため)
    const others = pool.filter((o) => o.id !== it.id && upper(o) !== upper(it) && squash(o.acronym) !== squash(it.acronym));
    // 略語 → フルスペル: 頭文字の数が同じ、1 文字目が同じ、頭文字の並びが近い、の順(語の数・頭文字で見抜けないように)
    const h = headOf.get(it.id);
    nearHeads.set(it.id, others.filter((o) => o.expansion)
      .map((o) => {
        const oh = headOf.get(o.id);
        return [Math.abs(oh.length - h.length), oh[0] === h[0] ? 0 : 1, editDistance(oh, h), o];
      })
      .sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || (x[3].id < y[3].id ? -1 : 1))
      .slice(0, NEAR).map((x) => x[3]));
    if (!byField.has(it.field)) byField.set(it.field, []);
    byField.get(it.field).push(it);
  }
  return { partners, nearHeads, byField };
}
function indexFor(data, key, pool) {
  if (!indexCache.has(data)) indexCache.set(data, new Map());
  const m = indexCache.get(data);
  if (!m.has(key)) m.set(key, buildIndex(pool));
  return m.get(key);
}

function optionsFor(item, direction, pool, rng, idx) {
  // 同じ綴りの別の意味の語は、どの向きでも誤答に使わない(それも正しい答えになるため)
  const same = (o) => o.acronym.toUpperCase() === item.acronym.toUpperCase();
  const partners = idx.partners.get(item.id).filter((p) => !same(p));
  const sameAcronymForms = new Set(pool.filter((o) => o.id !== item.id && same(o)).flatMap((o) => [...correctForms(o)]));
  if (direction === "expansion") {
    // 偽のフルスペル(本物と同じ頭文字の並び)を先に、足りなければ頭文字の数が同じ別の語の本物で埋める
    const exclude = new Set([...correctForms(item), ...sameAcronymForms]);
    const fakes = shuffle(item.fakes || [], rng);
    const near = shuffle(idx.nearHeads.get(item.id).slice(0, NEAR_MIX), rng)
      .concat(idx.nearHeads.get(item.id).slice(NEAR_MIX))
      .map((o) => o.expansion);
    const wrong = pickDistinct([...fakes, ...near], 3, exclude);
    return { prompt: item.acronym, correct: item.expansion, wrong };
  }
  // summary: 組の相手を 1 つまで、残りは同じ分野、足りなければ範囲全体から。
  // 説明がほぼ同じになる語の組(ESSID と SSID など。データの summary_twins)は、互いの誤答に使わない
  const twin = (o) => (item.summary_twins || []).includes(o.id) || (o.summary_twins || []).includes(item.id);
  const sameField = shuffle((idx.byField.get(item.field) || []).filter((o) => o.id !== item.id && !same(o) && !twin(o)), rng);
  const wrong = [];
  const seen = new Set([item.summary]);
  // 問われている略語そのものを含む説明(DVD の説明の「CD より…」など)は、誤答に使わない
  const esc = item.acronym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentions = new RegExp(`(?<![A-Za-z])${esc}(?![A-Za-z])`);
  const tryAdd = (o) => {
    if (wrong.length >= 3 || !o.summary || seen.has(o.summary) || o.id === item.id || same(o) || twin(o)) return;
    if (mentions.test(o.summary)) return;
    seen.add(o.summary);
    wrong.push(o.summary);
  };
  shuffle(partners, rng).slice(0, 1).forEach(tryAdd);
  sameField.forEach(tryAdd);
  for (let tries = 0; wrong.length < 3 && tries < pool.length * 2; tries++) tryAdd(pool[Math.floor(rng() * pool.length)]);
  return { prompt: item.acronym, correct: item.summary, wrong };
}

export function canAsk(item, direction) {
  if (direction === "summary") return Boolean(item.summary);
  // 偽のフルスペルが無い語(色の頭文字・人名の頭文字など)は、略語 → フルスペルでは出さない
  // (誤答の頭文字が正解と違い、頭文字だけで答えが分かってしまうため)
  if (direction === "expansion") return Boolean(item.expansion) && (item.fakes || []).length > 0;
  return false;
}

// options: { level: 1-4, direction: "expansion"|"summary"|"mixed", mode: "normal"|"pairs", count, onlyIds? }
export function createRun(data, options, seed) {
  const rng = mulberry32(seed);
  const level = options.level || 1;
  const full = data.items.filter((it) => it.level <= level);
  // 間違えた語だけを出すときも、誤答の候補は範囲全体から選ぶ
  const idx = indexFor(data, `L${level}`, full);
  const fixed = options.direction && options.direction !== "mixed" ? options.direction : "";
  let pool = full;
  if (options.onlyIds && options.onlyIds.length) {
    const want = new Set(options.onlyIds);
    pool = full.filter((it) => want.has(it.id));
  }
  // 向きを決めて出すときは、その向きで出せる語だけにする(向きをこっそり変えない)
  if (fixed) pool = pool.filter((it) => canAsk(it, fixed));
  const count = Math.min(options.count || 10, pool.length);
  let order;
  if (options.mode === "pairs") {
    // 範囲の語を順に回し、組の相手がいれば続けて出す(組の無い語も出す)
    const inPool = new Set(pool.map((it) => it.id));
    const partnersIn = (it) => idx.partners.get(it.id).filter((p) => inPool.has(p.id));
    order = [];
    const used = new Set();
    for (const it of shuffle(pool, rng)) {
      if (order.length >= count) break;
      if (used.has(it.id)) continue;
      order.push(it);
      used.add(it.id);
      const p = shuffle(partnersIn(it), rng).find((x) => !used.has(x.id));
      if (p && order.length < count) {
        order.push(p);
        used.add(p.id);
      }
    }
  } else {
    order = shuffle(pool, rng).slice(0, count);
  }
  const questions = order.map((item) => {
    let direction = fixed || DIRECTIONS[Math.floor(rng() * DIRECTIONS.length)];
    if (!canAsk(item, direction)) direction = DIRECTIONS.find((d) => canAsk(item, d)) || "summary";
    const { prompt, correct, wrong } = optionsFor(item, direction, full, rng, idx);
    const choices = shuffle([correct, ...wrong], rng);
    const sibling = full.some((o) => o.id !== item.id && o.acronym.toUpperCase() === item.acronym.toUpperCase());
    return {
      id: item.id,
      direction,
      prompt,
      // 同じ綴りで意味の違う語があるときは、どの意味の問題かを示す。
      // 分野が相手と同じ組(MBO と MBO#2)は、データに持たせた手がかり(context)を使う
      context: sibling ? item.context || item.field : "",
      choices,
      answer: choices.indexOf(correct),
    };
  });
  return { seed, options: { ...options, level }, questions };
}

// 単語ごとのカードで、略語のどの文字がフルスペルのどの文字から来たかを示す印(下線)の位置を決める。
// 略語の文字をフルスペルの文字に、いちばん自然な対応(大文字で始まる語の 1 文字目を優先)で順に当てる。
// 全部の文字を当てられないときは null(誤った印を出すより、印を出さない方が安全)。
// 返り値: words と同じ長さの配列で、各要素はその語の中で印を付ける文字の位置の配列。
export function initialMarks(acronym, words) {
  const want = [];
  const chars = [...acronym].filter((c) => /[A-Za-z0-9]/.test(c));
  const flat = words.map((w) => w.word).join(" ");
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/[0-9]/.test(c)) {
      // 数字: フルスペルに同じ数字があればそれ(U2F の 2nd)、2 は to(M2M)、3 以上は直前の文字の繰り返し(W3C)
      if (new RegExp(`(^|[\\s\\-/])${c}`).test(flat)) want.push({ ch: c });
      else if (c === "2") want.push({ to: true });
      else if (i > 0 && !/[0-9]/.test(chars[i - 1])) for (let k = 1; k < Number(c); k++) want.push({ ch: chars[i - 1] });
      else return null;
    } else want.push({ ch: c });
  }
  // 候補の位置と、当てるときの重み(小さいほど自然)
  const pos = [];
  words.forEach((w, wi) => {
    const s = w.word;
    for (let ci = 0; ci < s.length; ci++) {
      const ch = s[ci];
      if (!/[A-Za-z0-9]/.test(ch)) continue;
      const start = ci === 0 || /[\s\-/(]/.test(s[ci - 1]);
      const upperLike = /[A-Z0-9]/.test(ch);
      // 語の途中の文字は、同じ語の中では前の文字を優先する(Hypertext の t は 2 つ目の t ではなく 1 つ目)
      const cost = start ? (upperLike ? 0 : 2) : (upperLike ? 1 : 6) + ci / 1000;
      // 「to」の語の頭(M2M の 2 に当てる)
      const isTo = start && s.slice(ci, ci + 2).toLowerCase() === "to" && !/[A-Za-z]/.test(s[ci + 2] || "");
      pos.push({ wi, ci, ch, start, upperLike, cost, isTo });
    }
  });
  // 大文字で始まる語の頭を飛ばすのは不自然(GNU の G のような例外はある)なので重みを付ける
  // 全部大文字の語(GNU General Public License の GNU)はフルスペルに付いた名前なので、飛ばしても不自然でない
  const allCaps = (p) => /^[A-Z0-9]{2,}$/.test(words[p.wi].word.slice(p.ci).split(/[\s\-/]/)[0]);
  const skipCost = (p) => (p.start && p.upperLike ? (allCaps(p) ? 1 : 3) : 0);
  const n = want.length;
  const m = pos.length;
  const INF = 1e9;
  // dp[i][j]: want の i 番目以降を、pos の j 番目以降で当てる最小の重み
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
  for (let j = m; j >= 0; j--) dp[n][j] = j === m ? 0 : dp[n][j + 1] + skipCost(pos[j]);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const p = pos[j];
      let best = dp[i][j + 1] + skipCost(p);
      const w = want[i];
      const ok = w.to ? p.isTo : p.ch.toUpperCase() === w.ch.toUpperCase();
      if (ok) best = Math.min(best, p.cost + dp[i + 1][j + 1]);
      dp[i][j] = best;
    }
  }
  if (dp[0][0] >= INF) return null;
  // いちばん自然な対応が 2 通り以上あるとき(CAPTCHA の T が Turing か Tell か)は決められないので、印を出さない
  const ways = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let j = m; j >= 0; j--) ways[n][j] = 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const p = pos[j];
      let c = 0;
      if (dp[i][j + 1] + skipCost(p) === dp[i][j]) c += ways[i][j + 1];
      const w = want[i];
      const ok = w.to ? p.isTo : p.ch.toUpperCase() === w.ch.toUpperCase();
      if (ok && p.cost + dp[i + 1][j + 1] === dp[i][j]) c += ways[i + 1][j + 1];
      ways[i][j] = Math.min(c, 2);
    }
  }
  if (ways[0][0] > 1) return null;
  const marks = words.map(() => []);
  let i = 0;
  for (let j = 0; j < m && i < n; j++) {
    const p = pos[j];
    const w = want[i];
    const ok = w.to ? p.isTo : p.ch.toUpperCase() === w.ch.toUpperCase();
    if (ok && p.cost + dp[i + 1][j + 1] === dp[i][j]) {
      marks[p.wi].push(p.ci);
      i++;
    }
  }
  return i === n ? marks : null;
}
