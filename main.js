// 画面の操作。出題の中身は engine.js が作る。文字列は textContent で入れ、HTML として解釈しない。
import { canAsk, createRun, initialMarks } from "./engine.js";

// レベルの番号は main の前に出すので、sub には書かない(番号が二重に出ないように)
const LEVELS = [
  { value: 1, main: "ITパスポート", sub: "" },
  { value: 2, main: "基本情報技術者", sub: "セキュリティマネジメントを含む" },
  { value: 3, main: "応用情報技術者", sub: "" },
  { value: 4, main: "高度情報技術者", sub: "高度区分 9 試験" },
];
const DIRECTIONS = [
  { value: "expansion", main: "略語 → フルスペル", sub: "PPP を見て Point-to-Point Protocol を選ぶ" },
  { value: "summary", main: "略語 → 何をするものか", sub: "略語を見て説明を選ぶ" },
  { value: "mixed", main: "2 つを混ぜる", sub: "向きを問題ごとに変える" },
];
const MODES = [
  { value: "normal", main: "ふつう", sub: "範囲からまんべんなく" },
  { value: "pairs", main: "似た略語の組", sub: "NAT と NAPT のような紛らわしい語を続けて出す" },
];
const COUNTS = [10, 20, 50].map((n) => ({ value: n, main: `${n} 問`, sub: "" }));
const ASK = {
  expansion: "この略語のフルスペルは？",
  summary: "この略語の意味は？",
};
const KIND_LABEL = { expansion: "略語 → フルスペル", summary: "略語 → 何をするものか" };
const STORE_KEY = "acronym-card:options";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const SVG_NS = "http://www.w3.org/2000/svg";
function mark(kind) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("class", "mark-path");
  p.setAttribute("d", kind === "ok" ? "M5 12.5l4.5 4.5L19 7.5" : "M6.5 6.5l11 11M17.5 6.5l-11 11");
  svg.append(p);
  return svg;
}

let data = null;
let byId = new Map();
let options = loadOptions();
let run = null;
let index = 0;
let results = [];

function loadOptions() {
  const base = { level: 1, direction: "expansion", mode: "normal", count: 10 };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (!saved || typeof saved !== "object") return base;
    // 保存した値は、選べる値の一覧と照らしてから使う(外したフルスペル → 略語や、壊れた値は既定に戻す)
    const pick = (list, v, d) => (list.some((x) => x.value === v) ? v : d);
    return {
      level: pick(LEVELS, saved.level, base.level),
      direction: pick(DIRECTIONS, saved.direction, base.direction),
      mode: pick(MODES, saved.mode, base.mode),
      count: pick(COUNTS, saved.count, base.count),
    };
  } catch {
    return base;
  }
}
function saveOptions() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(options));
  } catch {
    /* 保存できなくても動く */
  }
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

// 自前の切り替えボタン(役割は radiogroup。矢印キーで移動できる)
function renderSeg(name, items) {
  const box = document.querySelector(`.seg[data-name="${name}"]`);
  box.replaceChildren();
  items.forEach((it) => {
    const b = el("button", "seg__opt");
    b.type = "button";
    b.setAttribute("role", "radio");
    const checked = options[name] === it.value;
    b.setAttribute("aria-checked", String(checked));
    b.tabIndex = checked ? 0 : -1;
    const main = el("span", "seg__main", it.main);
    if (name === "level") main.dataset.num = String(it.value);
    b.append(main);
    if (it.sub) b.append(el("span", "seg__sub", it.sub));
    b.addEventListener("click", () => {
      options[name] = it.value;
      saveOptions();
      renderSetup();
      box.querySelector('[aria-checked="true"]')?.focus();
    });
    b.addEventListener("keydown", (ev) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!(ev.key in keys)) return;
      ev.preventDefault();
      const i = items.findIndex((x) => x.value === options[name]);
      options[name] = items[(i + keys[ev.key] + items.length) % items.length].value;
      saveOptions();
      renderSetup();
      box.querySelector('[aria-checked="true"]')?.focus();
    });
    box.append(b);
  });
}

// 向きを決めたときは、その向きで出せる語だけを数える(偽の無い語は略語 → フルスペルに出ない)
function poolSize(level, direction = "mixed") {
  return data.items.filter((it) => it.level <= level && (direction === "mixed" || canAsk(it, direction))).length;
}

function renderSetup() {
  renderSeg("level", LEVELS.map((l) => ({ ...l, sub: `${l.sub ? `${l.sub}・` : ""}${poolSize(l.value, options.direction)} 語` })));
  renderSeg("direction", DIRECTIONS);
  renderSeg("mode", MODES);
  renderSeg("count", COUNTS);
  const n = poolSize(options.level, options.direction);
  $("pool-size").textContent = n
    ? `この条件で出る語: ${n} 語`
    : "このレベルまでの語は、まだ検証中で出せません";
  $("start").disabled = n === 0;
}

// 画面を切り替えたら、その画面の見出しにフォーカスを移す(フォーカスの行き場が無くならないように)
function show(id, focusHeading = true) {
  for (const s of ["setup", "quiz", "result"]) $(s).hidden = s !== id;
  window.scrollTo({ top: 0 });
  if (focusHeading) $(`${id}-title`)?.focus({ preventScroll: true });
}

function start(onlyIds) {
  const seed = (Date.now() ^ Math.floor(Math.random() * 2 ** 31)) >>> 0;
  run = createRun(data, { ...options, onlyIds }, seed);
  if (!run.questions.length) {
    toast("出せる問題がありません");
    return;
  }
  index = 0;
  results = [];
  show("quiz", false);
  renderQuestion();
}

function renderQuestion() {
  const q = run.questions[index];
  const total = run.questions.length;
  $("progress-bar").style.width = `${(index / total) * 100}%`;
  $("verdict-live").textContent = ""; // 次に答えたとき、同じ「正解」でも読み上げで知らせるため空にしておく
  $("q-count").textContent = `${index + 1} / ${total}`;
  $("q-kind").textContent = KIND_LABEL[q.direction];
  $("q-ask").textContent = ASK[q.direction];
  const prompt = $("q-prompt");
  prompt.textContent = q.prompt;
  prompt.classList.add("is-acronym"); // 問題文はどの向きでも略語
  const ctx = $("q-context");
  ctx.hidden = !q.context;
  ctx.textContent = q.context ? `同じ綴りで意味の違う略語があります。この問題は「${q.context}」での意味です` : "";
  const list = $("choices");
  list.replaceChildren();
  q.choices.forEach((c, i) => {
    const li = el("li");
    const b = el("button", "choice");
    b.type = "button";
    b.dataset.index = String(i);
    b.append(el("span", "choice__key", String(i + 1)));
    const t = el("span", "choice__text", c);
    b.append(t, el("span", "choice__mark"));
    b.addEventListener("click", () => choose(i));
    // 答える前は、矢印キーで選択肢の間を移動する(端まで行くと反対の端へ)
    b.addEventListener("keydown", (ev) => {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[ev.key];
      if (!step || results[index] || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      ev.preventDefault();
      const all = [...list.querySelectorAll(".choice")];
      all[(i + step + all.length) % all.length].focus();
    });
    li.append(b);
    list.append(li);
  });
  $("answer").hidden = true;
  $("next").hidden = true;
  $("quit-confirm").hidden = true;
  $("quit").hidden = false;
  list.querySelector("button")?.focus();
}

function choose(i) {
  const q = run.questions[index];
  if (results[index]) return;
  const ok = i === q.answer;
  results[index] = { id: q.id, ok };
  document.querySelectorAll(".choice").forEach((b) => {
    const k = Number(b.dataset.index);
    b.disabled = true;
    const m = b.querySelector(".choice__mark");
    // 正誤は色と印だけでなく、読み上げ用の文字でも伝える
    if (k === q.answer) {
      b.classList.add("is-correct");
      m.replaceChildren(mark("ok"), el("span", "sr-only", k === i ? "正解。あなたの答え" : "正解"));
    } else if (k === i) {
      b.classList.add("is-wrong");
      m.replaceChildren(mark("ng"), el("span", "sr-only", "あなたの答え。不正解"));
    } else {
      b.classList.add("is-dim");
    }
  });
  $("progress-bar").style.width = `${((index + 1) / run.questions.length) * 100}%`;
  renderAnswer(byId.get(q.id), ok);
  const next = $("next");
  next.hidden = false;
  next.textContent = index + 1 < run.questions.length ? "次へ" : "結果を見る";
  // フォーカスは「次へ」に移すが、画面は正誤の表示まで動かす(正解の選択肢と正誤が見えるように)
  next.focus({ preventScroll: true });
  const verdict = document.querySelector(".verdict");
  const top = Math.min(...[...document.querySelectorAll(".choice.is-correct, .choice.is-wrong")]
    .map((b) => b.getBoundingClientRect().top));
  if (top < 0) document.querySelector(".choice.is-correct, .choice.is-wrong")?.scrollIntoView({ block: "start" });
  else if (verdict && verdict.getBoundingClientRect().bottom > window.innerHeight) verdict.scrollIntoView({ block: "center" });
}

// 単語ごとのカード。略語の文字がフルスペルのどの文字から来たかに印を付ける(engine の initialMarks)。
// 対応が決められない語は印を付けない(誤った印で覚え違いをさせないため)
function wordTile(w, marks) {
  const li = el("li", "word");
  const en = el("span", "word__en");
  const at = new Set(marks || []);
  let buf = "";
  [...w.word].forEach((ch, k) => {
    if (at.has(k)) {
      if (buf) en.append(document.createTextNode(buf));
      buf = "";
      en.append(el("b", null, ch));
    } else buf += ch;
  });
  if (buf) en.append(document.createTextNode(buf));
  li.append(en, el("span", "word__ja", w.ja));
  return li;
}

function renderAnswer(item, ok) {
  const box = $("answer");
  box.replaceChildren();
  const v = el("p", `verdict ${ok ? "verdict--ok" : "verdict--ng"}`);
  v.setAttribute("aria-hidden", "true"); // 読み上げは、最初から置いてある空の #verdict-live で知らせる
  v.append(mark(ok ? "ok" : "ng"), document.createTextNode(ok ? "正解" : "不正解"));
  box.append(v);
  // 読み上げで知らせるのは正誤だけ(答えの欄の全文は通知に入れない)
  $("verdict-live").textContent = ok ? "正解" : "不正解";

  const card = el("div", "card answer__card");
  const head = el("div", "answer__head");
  head.append(el("span", "answer__acronym", item.acronym));
  if (item.expansion) head.append(el("span", "answer__expansion", item.expansion));
  card.append(head);

  if (item.words?.length) {
    const ul = el("ul", "words");
    // 英語名の頭文字ではない語(ISO)は、印を付けない(誤った成り立ちを覚えさせないため)
    const marks = item.no_marks ? null : initialMarks(item.acronym, item.words);
    item.words.forEach((w, k) => ul.append(wordTile(w, marks ? marks[k] : [])));
    card.append(ul);
  }
  if (item.summary) {
    card.append(el("p", "section-label", "何をするものか"));
    card.append(el("p", "answer__summary", item.summary));
  }
  if (item.notes?.length) {
    card.append(el("p", "section-label", "補足"));
    const ul = el("ul", "notes");
    item.notes.forEach((n) => ul.append(el("li", "note", n)));
    card.append(ul);
  }
  if (item.variants?.length) {
    card.append(el("p", "section-label", "ほかの正しい書き方"));
    card.append(el("p", "variants", item.variants.join(" / ")));
  }

  card.append(el("p", "section-label", "出典からの引用"));
  item.sources.forEach((s) => {
    const fig = el("figure", "quote");
    fig.append(el("blockquote", "quote__text", s.quote));
    const cap = el("figcaption", "quote__src");
    const who = [s.publisher, s.title].filter(Boolean).join("「") + (s.publisher && s.title ? "」" : "");
    cap.append(document.createTextNode(who ? `${who} ` : ""));
    const a = el("a", null, "原文を開く(新しいタブ)");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.setAttribute("aria-label", `${s.title || s.publisher || "出典"}の原文を新しいタブで開く`);
    cap.append(a);
    if (s.retrieved) cap.append(document.createTextNode(`(${s.retrieved} に確認)`));
    fig.append(cap);
    card.append(fig);
  });
  const meta = [item.syllabus && `シラバス: ${item.syllabus}`, item.field && `分野: ${item.field}`].filter(Boolean);
  if (meta.length) card.append(el("p", "meta-line", meta.join("・")));
  box.append(card);
  box.hidden = false;
}

function next() {
  index += 1;
  if (index < run.questions.length) renderQuestion();
  else renderResult();
}

function renderResult() {
  const total = results.length;
  const okCount = results.filter((r) => r?.ok).length;
  const score = $("score");
  score.replaceChildren(document.createTextNode(`${total} 問中 `), el("b", null, String(okCount)),
    document.createTextNode(" 問正解"));
  const missedBox = $("missed");
  missedBox.replaceChildren();
  const missed = results.filter((r) => r && !r.ok).map((r) => byId.get(r.id));
  if (missed.length) {
    missedBox.append(el("p", "section-label", "間違えた語"));
    const ul = el("ul", "missed");
    missed.forEach((it) => {
      const li = el("li");
      li.append(el("span", "missed__acr", it.acronym), el("span", null, it.expansion || it.summary));
      ul.append(li);
    });
    missedBox.append(ul);
  }
  $("retry-missed").hidden = missed.length === 0;
  $("progress-bar").style.width = "100%";
  show("result");
}

// 1〜4 のキーで選ぶ。Enter はページ全体では受けない(「原文を開く」「やめる」の Enter を横取りしないため。
// 答えたあとはフォーカスが「次へ」にあるので、Enter はそのボタンが受ける)
document.addEventListener("keydown", (ev) => {
  if ($("quiz").hidden || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (!$("quit-confirm").hidden) {
    if (ev.key === "Escape") { ev.preventDefault(); closeQuit(); }
    return; // 確かめている間は、1〜4 のキーで答えない
  }
  if (/^[1-4]$/.test(ev.key) && !results[index]) {
    const i = Number(ev.key) - 1;
    if (i < run.questions[index].choices.length) {
      ev.preventDefault();
      choose(i);
    }
  }
});
$("start").addEventListener("click", () => start());
$("next").addEventListener("click", next);
// 1 問以上答えた途中でやめるときは、画面の中で確かめる(結果が残らないため)
function askQuit() {
  const answered = results.filter(Boolean).length;
  if (!answered) { show("setup"); return; }
  $("quit-confirm-text").textContent = `ここまでの ${answered} 問の結果は残りません。やめますか？`;
  $("quit-confirm").hidden = false;
  $("quit").hidden = true; // 「やめる」が 2 つ並ばないように、確かめている間は下のボタンを隠す
  $("quit-no").focus();
}
function closeQuit() {
  $("quit-confirm").hidden = true;
  $("quit").hidden = false;
  $("quit").focus();
}
$("quit").addEventListener("click", askQuit);
$("quit-yes").addEventListener("click", () => { $("quit-confirm").hidden = true; $("quit").hidden = false; show("setup"); });
$("quit-no").addEventListener("click", closeQuit);
$("again").addEventListener("click", () => start());
$("change").addEventListener("click", () => show("setup"));
$("retry-missed").addEventListener("click", () => {
  const ids = results.filter((r) => r && !r.ok).map((r) => r.id);
  start(ids);
});

fetch("data/quiz.json")
  .then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then((d) => {
    data = d;
    byId = new Map(d.items.map((it) => [it.id, it]));
    $("loading").hidden = true;
    renderSetup();
    show("setup");
  })
  .catch((e) => {
    $("loading").textContent = `データを読み込めませんでした(${e.message})`;
  });
