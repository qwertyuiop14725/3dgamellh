/*
 * 雪迹 Cold Smoke —— 低版本内核兼容预编译器
 *
 * 用法：npm i && node build.mjs [源HTML] [输出HTML]
 * 默认：index.src.html -> index.html
 *
 * 只做三件事，视觉、交互、文案一律不动：
 *   1. 把 CSS 变量 / clamp / max / min / env / calc 乘法 / inset / gap 等运行时计算
 *      预编译成老内核能直接解析的静态回退声明（现代内核仍吃原来的声明）；
 *      边界、变量重定义等分支用条件规则补齐，且只在不支持 clamp 的内核生效；
 *   2. 把内联脚本预编译到能运行 WebGL2 的最低内核语法（ES2017），并前置精简兼容层；
 *   3. 把 WebGL2 着色器链接改为启动期并行预编译（KHR_parallel_shader_compile）。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import esbuild from 'esbuild';

const SRC = process.argv[2] || path.resolve('index.src.html');
const OUT = process.argv[3] || path.resolve('index.html');
const html = fs.readFileSync(SRC, 'utf8');

/* ------------------------------------------------------------------ 1. 拆分源文件 */
const styleOpen = html.indexOf('<style>');
const styleClose = html.indexOf('</style>', styleOpen);
const css = html.slice(styleOpen + 7, styleClose);
const headMisc = html.slice(0, styleOpen);
const sOpen = html.indexOf('<script>');
const sClose = html.indexOf('</script>', sOpen);
let js = html.slice(sOpen + 8, sClose);
const bodyStart = html.indexOf('<div id="app">');
const bodyHtml = html.slice(bodyStart, sOpen);
const tailScripts = html.slice(sClose + 9).trim();
const title = (headMisc.match(/<title>[\s\S]*?<\/title>/) || ['<title>雪迹 Cold Smoke</title>'])[0];
const claudeMeta = (headMisc.match(/<meta\s+name="claude[^>]*>/) || [''])[0];

/* ------------------------------------------------------------------ 2. CSS 预编译 */
function splitArgs(s) {
  const args = []; let d = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') d++;
    else if (c === ')') d--;
    else if (c === ',' && d === 0) { args.push(s.slice(start, i)); start = i + 1; }
  }
  args.push(s.slice(start));
  return args;
}
function replaceFns(s, name, fn) {
  const re = new RegExp('(^|[^\\w-])' + name + '\\s*\\(', 'g');
  let out = '', last = 0, m;
  while ((m = re.exec(s))) {
    const open = re.lastIndex - 1;
    let d = 1, i = open + 1;
    while (i < s.length && d) {
      if (s[i] === '(') d++;
      else if (s[i] === ')') d--;
      i++;
    }
    if (d) break;
    out += s.slice(last, m.index + m[1].length) + fn(splitArgs(s.slice(open + 1, i - 1)));
    last = i; re.lastIndex = i;
  }
  return out + s.slice(last);
}
/* 把 calc() 里的乘除、嵌套括号摊平成老内核也支持的加减表达式 */
function linearize(expr) {
  expr = expr.replace(/\bcalc\s*\(/g, '(');
  const toks = [];
  const re = /(\d*\.?\d+(?:[eE][-+]?\d+)?)(px|vmin|vw|vh|em|rem|%)?|([()+*/-])/g;
  let m, pos = 0;
  while ((m = re.exec(expr))) {
    if (expr.slice(pos, m.index).trim() !== '') return null;
    pos = re.lastIndex;
    if (m[1] !== undefined) toks.push({ t: 'len', v: parseFloat(m[1]), u: m[2] || '_num' });
    else toks.push({ t: 'op', v: m[3] });
  }
  if (expr.slice(pos).trim() !== '' || !toks.length) return null;
  let i = 0;
  const merge = (a, b, sign) => {
    if (!a || !b) return null;
    const o = new Map(a);
    for (const [u, v] of b) o.set(u, (o.get(u) || 0) + sign * v);
    return o;
  };
  function parseExpr() {
    let acc = parseTerm();
    while (acc && i < toks.length && (toks[i].v === '+' || toks[i].v === '-')) {
      const op = toks[i++].v; acc = merge(acc, parseTerm(), op === '+' ? 1 : -1);
    }
    return acc;
  }
  function parseTerm() {
    let acc = parseFactor();
    while (acc && i < toks.length && (toks[i].v === '*' || toks[i].v === '/')) {
      const op = toks[i++].v, r = parseFactor();
      if (!r) return null;
      const o = new Map();
      if (op === '*') {
        for (const [u, v] of acc) for (const [u2, v2] of r) {
          const uu = u === '_num' ? u2 : u2 === '_num' ? u : (u === u2 ? u : null);
          if (!uu) return null;
          o.set(uu, (o.get(uu) || 0) + v * v2);
        }
      } else {
        if (r.size !== 1 || !r.has('_num')) return null;
        const k = r.get('_num');
        for (const [u, v] of acc) o.set(u, v / k);
      }
      acc = o;
    }
    return acc;
  }
  function parseFactor() {
    const t = toks[i]; if (!t) return null;
    if (t.t === 'len') { i++; return new Map([[t.u, t.v]]); }
    if (t.v === '(') { i++; const e = parseExpr(); if (toks[i] && toks[i].v === ')') i++; return e; }
    if (t.v === '-') { i++; const e = parseFactor(); if (!e) return null; const o = new Map(); for (const [u, v] of e) o.set(u, -v); return o; }
    if (t.v === '+') { i++; return parseFactor(); }
    return null;
  }
  const map = parseExpr();
  if (!map || !map.size || i !== toks.length) return null;
  for (const [, v] of map) if (!isFinite(v)) return null;
  const fmt = v => String(Math.round(v * 1e6) / 1e6);
  const parts = [];
  for (const [u, v] of map) parts.push({ u: u === '_num' ? 'px' : u, v, s: fmt(v) + (u === '_num' ? 'px' : u) });
  if (parts.length === 1) return parts[0].s;
  let s = 'calc(';
  parts.forEach((p, k) => {
    if (!k) s += p.s;
    else s += (p.v < 0 ? ' - ' : ' + ') + (p.v < 0 ? fmt(-p.v) + p.u : p.s);
  });
  return s + ')';
}
function simplifyCalc(s) {
  for (let p = 0; p < 8; p++) {
    const t = replaceFns(s, 'calc', a => {
      const r = linearize(a[0]);
      return r === null ? 'calc(' + a[0] + ')' : r;
    });
    if (t === s) break; s = t;
  }
  return s;
}
const pxNum = x => { const m = /^([-+]?\d*\.?\d+)px$/.exec(String(x).trim()); return m ? parseFloat(m[1]) : null; };
const unitOf = x => {
  const m = /^([-+]?\d*\.?\d+)(vmin|vw|vh|em|rem|%)$/.exec(String(x).trim());
  return m ? { unit: m[2], coef: parseFloat(m[1]) } : null;
};
function simplify(v) {
  let s = String(v).trim();
  for (let p = 0; p < 10; p++) {
    let t = replaceFns(s, 'env', a => (a[1] || '0px').trim());
    t = replaceFns(t, 'var', a => {
      const n = a[0].trim();
      return defs[n] !== undefined ? defs[n] : (a.length > 1 ? a.slice(1).join(',').trim() : '0px');
    });
    t = replaceFns(t, 'max', a => a[0].trim());
    t = replaceFns(t, 'min', a => a[0].trim());
    t = replaceFns(t, 'clamp', a => (a[1] || a[0]).trim());
    if (t === s) break; s = t;
  }
  return simplifyCalc(s).trim();
}

/* 把 CSS 解析成规则，记下每条声明的绝对位置与它所在规则块的结束位置 */
function parseRules(cssText) {
  const rules = [], stack = [];
  let i = 0, last = 0;
  while (i < cssText.length) {
    if (cssText.startsWith('/*', i)) {
      const e = cssText.indexOf('*/', i + 2); i = e < 0 ? cssText.length : e + 2; last = i; continue;
    }
    const c = cssText[i];
    if (c === '{') {
      stack.push({ sel: cssText.slice(last, i).trim(), bodyStart: i + 1 }); last = i + 1; i++;
    } else if (c === '}') {
      const top = stack.pop();
      if (top && top.sel && top.sel.charAt(0) !== '@') {
        rules.push({ sel: top.sel, media: stack.filter(f => /^@(media|supports)/i.test(f.sel)).map(f => f.sel), bodyStart: top.bodyStart, end: i + 1 });
      }
      last = i + 1; i++;
    } else i++;
  }
  return rules;
}
function splitDecls(cssText, from, to) {
  const out = []; let i = from, last = from, d = 0;
  const push = (a, b) => {
    const seg = cssText.slice(a, b).replace(/\/\*[\s\S]*?\*\//g, '');
    const k = seg.indexOf(':');
    if (k >= 0) out.push({ prop: seg.slice(0, k).trim(), val: seg.slice(k + 1).trim(), start: a, end: b });
  };
  while (i < to) {
    if (cssText.startsWith('/*', i)) { const e = cssText.indexOf('*/', i + 2); i = e < 0 ? to : e + 2; continue; }
    const c = cssText[i];
    if (c === '(') d++;
    else if (c === ')') d--;
    else if (c === ';' && d === 0) { push(last, i); last = i + 1; }
    i++;
  }
  if (last < to) push(last, to);
  return out;
}

const rules = parseRules(css);
const defs = {}, varDefs = {}, defCount = {};
const ruleDecls = new Map();
for (const r of rules) {
  const ds = splitDecls(css, r.bodyStart, r.end - 1);
  ruleDecls.set(r, ds);
  for (const d of ds) {
    if (d.prop.slice(0, 2) !== '--') continue;
    defCount[d.prop] = (defCount[d.prop] || 0) + 1;
    if (defs[d.prop] === undefined) defs[d.prop] = d.val;
    (varDefs[d.prop] = varDefs[d.prop] || []).push({ sel: r.sel, media: r.media, val: d.val });
  }
}

/* 求一条声明在老内核下的静态值，同时收集 clamp 边界、min() 分支、被重定义的变量 */
function resolve(v, overrides) {
  const ctx = { vars: new Set(), clamps: [], minRule: null };
  let s = String(v).trim();
  for (let p = 0; p < 10; p++) {
    let t = replaceFns(s, 'env', a => (a[1] || '0px').trim());
    t = replaceFns(t, 'var', a => {
      const n = a[0].trim();
      if (defCount[n] > 1) ctx.vars.add(n);
      const d = overrides && overrides[n] !== undefined ? overrides[n] : defs[n];
      return d !== undefined ? d : (a.length > 1 ? a.slice(1).join(',').trim() : '0px');
    });
    if (t === s) break; s = t;
  }
  const raw = s;                                   // 展开变量后、未化简的老内核表达式
  for (let p = 0; p < 6; p++) {
    let t = replaceFns(s, 'max', a => {
      const vals = a.map(simplify), nums = vals.map(pxNum);
      const px = nums.filter(x => x !== null);
      if (px.length === vals.length) return Math.max.apply(null, px) + 'px';
      if (px.length) return Math.max.apply(null, px) + 'px';       // 视口分支由下面的媒体查询兜底
      return 'max(' + a.join(',') + ')';
    });
    t = replaceFns(t, 'min', a => {
      const vals = a.map(simplify), nums = vals.map(pxNum);
      const px = nums.filter(x => x !== null);
      if (px.length === vals.length) return Math.min.apply(null, px) + 'px';
      if (px.length === 1 && vals.length === 2) {
        const other = vals[nums.indexOf(null)], u = unitOf(other);
        if (u) ctx.minRule = { px: px[0], unit: u.unit, coef: u.coef, expr: other };
        return px[0] + 'px';
      }
      return 'min(' + a.join(',') + ')';
    });
    if (t === s) break; s = t;
  }
  for (let p = 0; p < 6; p++) {
    let changed = false;
    const t = replaceFns(s, 'clamp', a => {
      changed = true;
      const lo = simplify(a[0]), mid = simplify(a[1]), hi = simplify(a[2] || a[1]);
      const id = '@@C' + ctx.clamps.length + '@@', u = unitOf(mid);
      ctx.clamps.push({ id, lo, mid, hi, nlo: pxNum(lo), nhi: pxNum(hi), unit: u && u.unit, coef: u && u.coef });
      return id;
    });
    if (!changed || t === s) { s = t; break; }
    s = t;
  }
  const sub = key => {
    let o = s;
    for (const c of ctx.clamps) o = o.split(c.id).join(c[key]);
    return simplifyCalc(o).trim();
  };
  return {
    fb: sub('mid'), raw, expr: s,
    loV: ctx.clamps.length ? sub('lo') : null,
    hiV: ctx.clamps.length ? sub('hi') : null,
    clamps: ctx.clamps, vars: Array.from(ctx.vars), minRule: ctx.minRule,
  };
}

/* 把重定义变量的选择器合并进原选择器，避免 #app.wide #app.wide ... 这种永不匹配的后代链 */
function mergeSel(S, rsel) {
  const m = /^#app((?:\.[\w-]+)+)/.exec(S);
  const m2 = /^#app((?:\.[\w-]+)+)?/.exec(rsel);
  if (!m || !m2) return S + ' ' + rsel;
  return '#app' + m[1] + (m2[1] || '') + rsel.slice(m2[0].length);
}

const SUP = '@supports not (font-size: clamp(1px, 2vmin, 3px))';
const fmtPx = v => Math.round(v * 100) / 100 + 'px';
function wrapMedia(media, inner) {
  let s = inner;
  for (let i = media.length - 1; i >= 0; i--) s = media[i] + ' { ' + s + ' }';
  return s;
}
function clampStates(res, probe) {
  return res.clamps.map(c => {
    if (c.nlo === null || c.nhi === null || !c.unit || !(c.coef > 0)) return 'mid';
    const L = c.nlo * 100 / c.coef, H = c.nhi * 100 / c.coef;
    return probe < L ? 'lo' : probe > H ? 'hi' : 'mid';
  });
}
function substituteStates(res, states) {
  let o = res.expr;
  res.clamps.forEach((c, i) => { o = o.split(c.id).join(c[states[i]]); });
  return simplifyCalc(o).trim();
}
/* 一条声明里若有多个 clamp，逐个按"中间值落在哪一段"分段求值，避免只钉全上界/全下界时混合区间失真 */
function rangeCond(u, a, b) {
  const A = a > 0 ? fmtPx(a) : null, B = isFinite(b) ? fmtPx(b) : null;
  if (u === 'vmin') {
    const low = A ? ['(min-width:' + A + ') and (min-height:' + A + ')'] : [];
    if (!B) return low.join('') || '(min-width:0px)';
    const pre = low.length ? low[0] + ' and ' : '';
    return pre + '(max-width:' + B + '), ' + pre + '(max-height:' + B + ')';
  }
  const ax = u === 'vw' ? 'width' : 'height';
  if (A && B) return '(min-' + ax + ':' + A + ') and (max-' + ax + ':' + B + ')';
  if (B) return '(max-' + ax + ':' + B + ')';
  return '(min-' + ax + ':' + A + ')';
}
function boundaryRules(r, prop, res, sel) {
  const cs = res.clamps.filter(c => c.nlo !== null && c.nhi !== null && c.unit && c.coef > 0);
  if (!cs.length) return '';
  const units = new Set(cs.map(c => c.unit));
  if (units.size > 1) return '';                 // 混合单位无法用单一媒体条件表达，保留中间值
  const u = cs[0].unit;
  const S = sel || r.sel;
  const body = value => wrapMedia(r.media, S + ' { ' + prop + ': ' + value + '; }');
  const marks = [0, Infinity];
  for (const c of cs) marks.push(c.nlo * 100 / c.coef, c.nhi * 100 / c.coef);
  const pts = Array.from(new Set(marks)).sort((a, b) => a - b);
  let out = '';
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1];
    const probe = isFinite(b) ? (a + b) / 2 : a + 1;
    const states = clampStates(res, probe);
    if (states.every(x => x === 'mid')) continue;
    out += SUP + ' { @media ' + rangeCond(u, a, b) + ' { ' + body(substituteStates(res, states)) + ' } } ';
  }
  return out;
}
function minRules(r, prop, res) {
  const m = res.minRule;
  if (!m || !m.coef) return '';
  const X = fmtPx(m.px * 100 / m.coef);
  const cond = m.unit === 'vw' ? '(max-width:' + X + ')'
    : m.unit === 'vh' ? '(max-height:' + X + ')'
    : '(max-width:' + X + '), (max-height:' + X + ')';
  return SUP + ' { @media ' + cond + ' { ' + wrapMedia(r.media, r.sel + ' { ' + prop + ': ' + m.expr + '; }') + ' } }';
}
function contextRules(r, prop, val, res) {
  // 只有展开后仍含老内核不认识的函数时，才需要按变量重定义的上下文补规则
  if (!res.vars.length || !/clamp\(|\bmin\(|\bmax\(/.test(res.raw)) return '';
  const name = res.vars[0], list = varDefs[name] || [];
  if (list.length < 2) return '';
  let out = '';
  for (let i = 1; i < list.length; i++) {
    const ov = {}; ov[name] = list[i].val;
    const r2 = resolve(val, ov);
    const S = mergeSel(list[i].sel, r.sel);
    out += SUP + ' { ' + wrapMedia(r.media, S + ' { ' + prop + ': ' + r2.fb + '; }') + ' } ';
    const b = boundaryRules(r, prop, r2, S);
    if (b) out += b + ' ';
  }
  return out;
}
function resolveBody(body) {
  return body.split(';').map(x => {
    const c = x.indexOf(':'); if (c < 0) return x.trim();
    const p = x.slice(0, c).trim(), v = x.slice(c + 1).trim();
    return v ? p + ': ' + resolve(v).fb : '';
  }).filter(Boolean).join('; ');
}

const displayGrid = new Set(), flexColumn = new Set();
for (const r of rules) for (const d of ruleDecls.get(r)) {
  if (d.prop === 'display' && /grid/.test(d.val)) displayGrid.add(r.sel);
  if (d.prop === 'flex-direction' && /column/.test(d.val)) flexColumn.add(r.sel);
}

const inserts = [], ruleExtras = new Map(), gapRules = [], focusRules = [];
const stat = { fallback: 0, boundary: 0, context: 0 };
for (const r of rules) {
  const ds = ruleDecls.get(r);
  const extras = [];
  if (r.sel.indexOf(':focus-visible') >= 0) {
    const body = ds.map(x => x.prop + ': ' + x.val).join('; ');
    focusRules.push(wrapMedia(r.media, '.no-focusvisible ' + r.sel.replace(/:focus-visible/g, ':focus') + ' { ' + resolveBody(body) + ' }'));
  }
  for (const d of ds) {
    const prop = d.prop, val = d.val;
    if (prop.slice(0, 2) === '--') continue;
    const res = resolve(val);
    const fb = res.fb;
    const modern = /var\(|clamp\(|max\(|min\(|env\(|calc\(|inset|revert|conic-gradient/.test(val);

    if (prop === 'inset') {
      const q = fb.split(/\s+/);
      const [t, rr, b, l] = q.length === 1 ? [q[0], q[0], q[0], q[0]]
        : q.length === 2 ? [q[0], q[1], q[0], q[1]]
        : q.length === 3 ? [q[0], q[1], q[2], q[1]] : [q[0], q[1], q[2], q[3]];
      inserts.push({ pos: d.start, text: `\n  top:${t}; right:${rr}; bottom:${b}; left:${l};` });
      stat.fallback++;
    } else if (/conic-gradient\(/.test(val)) {
      inserts.push({ pos: d.start, text: '\n  background: rgba(255, 208, 138, .35);' }); stat.fallback++;
    } else if (prop === 'display' && /revert/.test(val)) {
      inserts.push({ pos: d.start, text: '\n  display: inline;' }); stat.fallback++;
    } else if (modern && fb && fb !== val && !/var\(|clamp\(|max\(|min\(|env\(|@@C/.test(fb)) {
      inserts.push({ pos: d.start, text: `\n  ${prop}: ${fb};` }); stat.fallback++;
    }

    if (prop === 'gap' && !displayGrid.has(r.sel)) {
      const dir = flexColumn.has(r.sel) ? 'margin-top' : 'margin-left';
      gapRules.push(wrapMedia(r.media, '.no-flexgap ' + r.sel + ' > * + * { ' + dir + ': ' + fb + '; }'));
    }
    const bnd = boundaryRules(r, prop, res);
    if (bnd) { extras.push(bnd); stat.boundary++; }
    const mn = minRules(r, prop, res);
    if (mn) extras.push(mn);
    const ctxr = contextRules(r, prop, val, res);
    if (ctxr) { extras.push(ctxr); stat.context++; }
  }
  if (extras.length) ruleExtras.set(r.end, (ruleExtras.get(r.end) || '') + '\n' + extras.join('\n') + '\n');
}
for (const [pos, text] of ruleExtras) inserts.push({ pos, text });
inserts.sort((a, b) => b.pos - a.pos || (a.text < b.text ? 1 : -1));
let cssMain = css;
for (const it of inserts) cssMain = cssMain.slice(0, it.pos) + it.text + cssMain.slice(it.pos);

let cssExtra = '/* ---- precompiled fallbacks for older engines (generated by build.mjs) ---- */\n';
cssExtra += '#seg .split { max-height: 0; overflow: hidden; }\n#seg.res .split { max-height: 80px; }\n#seg .split > p { overflow: hidden; }\n';
for (const r of gapRules) cssExtra += r + '\n';
for (const r of focusRules) cssExtra += r + '\n';

/* ------------------------------------------------------------------ 3. 源码级：着色器并行预编译 */
function mustReplace(src, from, to) {
  if (!src.includes(from)) throw new Error('build.mjs: 源码锚点未找到 -> ' + from.slice(0, 70));
  return src.replace(from, to);
}
js = mustReplace(js,
  "  const caps = { backend: 'webgl2', hdr:",
  "  const extParallel = gl.getExtension('KHR_parallel_shader_compile');\n  const caps = { backend: 'webgl2', hdr:");
js = mustReplace(js,
  "  let curProg = null, curTarget = undefined, ysign = 1, st = {};\n  const vaos = new Map();",
  "  let curProg = null, curTarget = undefined, ysign = 1, st = {};\n  const pipes = [];\n  const vaos = new Map();");
js = mustReplace(js,
  "      P.ubuf = new Float32Array(Math.max(4, P.layout.size));\n      return P;",
  "      P.ubuf = new Float32Array(Math.max(4, P.layout.size));\n      pipes.push(P);\n      return P;");
js = mustReplace(js,
  "    finishPipeline(P) {",
  `    precompile(done) {
      if (!extParallel || !pipes.length) { if (done) done(); return; }
      const pending = pipes.slice(), deadline = performance.now() + 2500;
      const poll = () => {
        for (let i = pending.length - 1; i >= 0; i--) {
          const P = pending[i];
          try {
            if (P.ready || gl.getProgramParameter(P.prog, extParallel.COMPLETION_STATUS_KHR)) { g.finishPipeline(P); pending.splice(i, 1); }
          } catch (e) { console.error('shader precompile', e); pending.splice(i, 1); }
        }
        if (pending.length && performance.now() < deadline) { requestAnimationFrame(poll); return; }
        // 老驱动可能一直不报完成：交给 GL 自己阻塞到链接结束，保证游戏一定会开始
        for (const P of pending) { try { g.finishPipeline(P); } catch (e) { console.error('shader finish', e); } }
        if (done) done();
      };
      poll();
    },
    finishPipeline(P) {`);
js = mustReplace(js,
  "  boot(UI.stage).then(() => { UI.ready(); lastT = performance.now(); requestAnimationFrame(loop); if (QS.has('autostart')) UI.go(); }).catch(e => { if (!retryOnWebGL2(e)) reportError(e); });",
  "  boot(UI.stage).then(() => { UI.ready(); lastT = performance.now(); const start = () => { requestAnimationFrame(loop); if (QS.has('autostart')) UI.go(); }; if (App.gfx && typeof App.gfx.precompile === 'function') App.gfx.precompile(start); else start(); }).catch(e => { if (!retryOnWebGL2(e)) reportError(e); });");

/* ------------------------------------------------------------------ 4. 语法预编译（ES2017 档：能运行 WebGL2 的最低内核） */
const transpiled = esbuild.transformSync(js, {
  loader: 'js', target: 'es2017', charset: 'utf8', legalComments: 'inline', minify: false, sourcemap: false,
}).code;
new vm.Script(transpiled);                       // 只做语法检查，不执行

/* ------------------------------------------------------------------ 5. 精简兼容层（ES5，不覆盖原生实现） */
const polyfill = `(function () {
  var w = window;
  if (!String.prototype.padStart) {
    String.prototype.padStart = function (n, s) {
      var t = String(this), k = Number(n) - t.length;
      if (!(k > 0)) return t;
      s = s === undefined ? ' ' : String(s);
      var p = ''; while (p.length < k) p += s;
      return p.slice(0, k) + t;
    };
  }
  if (!String.prototype.padEnd) {
    String.prototype.padEnd = function (n, s) {
      var t = String(this), k = Number(n) - t.length;
      if (!(k > 0)) return t;
      s = s === undefined ? ' ' : String(s);
      var p = ''; while (p.length < k) p += s;
      return t + p.slice(0, k);
    };
  }
  if (!String.prototype.includes) {
    String.prototype.includes = function (s, i) { return String(this).indexOf(s, i || 0) !== -1; };
  }
  if (!Array.prototype.includes) {
    Array.prototype.includes = function (v, i) {
      var a = this, n = a.length >>> 0, k = i == null ? 0 : Number(i);
      if (k < 0) k = Math.max(0, n + k);
      for (; k < n; k++) { var x = a[k]; if (x === v || (x !== x && v !== v)) return true; }
      return false;
    };
  }
  if (!Array.from) {
    Array.from = function (o, f) {
      if (o == null) throw new TypeError('Array.from');
      var a = [], n = o.length >>> 0, i;
      for (i = 0; i < n; i++) a[i] = f ? f(o[i], i) : o[i];
      a.length = n; return a;
    };
  }
  if (!Object.assign) {
    Object.assign = function (t) {
      for (var i = 1; i < arguments.length; i++) {
        var s = arguments[i]; if (s == null) continue;
        for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k];
      }
      return t;
    };
  }
  if (!Object.entries) {
    Object.entries = function (o) {
      var a = []; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) a.push([k, o[k]]); return a;
    };
  }
  if (!Object.values) {
    Object.values = function (o) {
      var a = []; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) a.push(o[k]); return a;
    };
  }
  if (!Number.isFinite) Number.isFinite = function (v) { return typeof v === 'number' && isFinite(v); };
  if (!Number.isNaN) Number.isNaN = function (v) { return v !== v; };
  if (!Number.isInteger) Number.isInteger = function (v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; };
  if (!Math.imul) {
    Math.imul = function (a, b) {
      var ah = (a >>> 16) & 65535, al = a & 65535, bh = (b >>> 16) & 65535, bl = b & 65535;
      return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
    };
  }
  if (!Math.hypot) Math.hypot = function () {
    var s = 0, i; for (i = 0; i < arguments.length; i++) s += arguments[i] * arguments[i];
    return Math.sqrt(s);
  };
  if (!Math.log2) Math.log2 = function (x) { return Math.log(x) * Math.LOG2E; };
  if (!Math.sign) Math.sign = function (x) { return x > 0 ? 1 : x < 0 ? -1 : (x === 0 ? x : NaN); };
  if (!w.URLSearchParams) {
    w.URLSearchParams = function (s) {
      var m = {}, k;
      String(s || '').replace(/^\\?/, '').split('&').forEach(function (p) {
        if (!p) return;
        var j = p.indexOf('='), a = j < 0 ? p : p.slice(0, j), b = j < 0 ? '' : p.slice(j + 1);
        try { a = decodeURIComponent(a); b = decodeURIComponent(b); } catch (e) {}
        m[a] = b;
      });
      this.get = function (n) { return m[n] == null ? null : m[n]; };
      this.has = function (n) { return m[n] != null; };
      this.set = function (n, v) { m[n] = String(v); };
      this.toString = function () {
        var a = []; for (k in m) if (m.hasOwnProperty(k)) a.push(encodeURIComponent(k) + '=' + encodeURIComponent(m[k]));
        return a.join('&');
      };
    };
  }
})();`;
new vm.Script(polyfill);

const shim = `(function () {
  var w = window, d = document, root = d.documentElement;
  if (!w.requestAnimationFrame) {
    w.requestAnimationFrame = w.msRequestAnimationFrame || w.webkitRequestAnimationFrame || w.mozRequestAnimationFrame ||
      function (cb) { return setTimeout(function () { cb(Date.now()); }, 16); };
  }
  if (!w.cancelAnimationFrame) {
    w.cancelAnimationFrame = w.msCancelAnimationFrame || w.webkitCancelAnimationFrame || w.mozCancelAnimationFrame || clearTimeout;
  }
  if (!w.performance || typeof w.performance.now !== 'function') {
    var t0 = Date.now(); w.performance = { now: function () { return Date.now() - t0; } };
  }
  if (!w.matchMedia) {
    w.matchMedia = function (q) { return { matches: false, media: q, addListener: function () {}, removeListener: function () {}, addEventListener: function () {}, removeEventListener: function () {} }; };
  }
  if (w.Element && !w.Element.prototype.closest) {
    w.Element.prototype.closest = function (s) {
      var e = this;
      while (e && e.nodeType === 1) {
        var ok = e.matches ? e.matches(s) : (e.msMatchesSelector ? e.msMatchesSelector(s) : false);
        if (ok) return e;
        e = e.parentElement;
      }
      return null;
    };
  }
  try { d.querySelector(':focus-visible'); } catch (e) { root.className += ' no-focusvisible'; }
  var hasGap = false;
  try {
    var t = d.createElement('div'); t.style.display = 'flex'; t.style.gap = '10px';
    root.appendChild(t);
    var cs = w.getComputedStyle ? w.getComputedStyle(t) : null;
    hasGap = !!(cs && (cs.gap === '10px' || cs.columnGap === '10px' || cs.rowGap === '10px'));
    root.removeChild(t);
  } catch (e2) {}
  if (!hasGap) root.className += ' no-flexgap';
})();`;

/* ------------------------------------------------------------------ 6. 组装 */
const esc = s => s.replace(/<\/script/gi, '<\\/script');
const outHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1">
${title}
${claudeMeta}
<style>
${cssMain}
</style>
<style>
${cssExtra}
</style>
</head>
<body>
${bodyHtml}
<script>${esc(polyfill)}</script>
<script>${esc(shim)}</script>
<script>
${esc(transpiled)}
</script>
${tailScripts}
</body>
</html>
`;
fs.writeFileSync(OUT, outHtml, 'utf8');
console.log('OK ->', OUT);
console.log('  CSS 静态回退声明 :', stat.fallback, '条');
console.log('  clamp 边界规则    :', stat.boundary, '条');
console.log('  上下文变量回退    :', stat.context, '条');
console.log('  flex gap 回退规则 :', gapRules.length, '条');
console.log('  焦点回退规则      :', focusRules.length, '条');
console.log('  兼容层            :', (polyfill.length / 1024).toFixed(1), 'KB');
console.log('  业务脚本(预编译)  :', (transpiled.length / 1024).toFixed(1), 'KB');
