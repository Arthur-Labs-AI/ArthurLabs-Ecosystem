/* Marginalia Mobile: interactive design exploration.
   Pure design material: renders the 11 mobile compositions against the real demo dataset (demo-data.js).
   Reuses the desktop exploration's icons, kind glyphs, relation geometry, word diff and tokens (../exploration/).
   Nothing here imports from, or is imported by, apps/arthur. */
(function () {
  const A = window.Arthur, D = window.DEMO;
  const M = (window.Mobile = {});
  const NS = "http://www.w3.org/2000/svg";

  /* ======================================================================= data */
  // Pinned "now": 10 minutes after the newest capture, so Home has a Today and a Yesterday.
  const NOW = Date.parse("2026-10-04T19:25:23Z");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayKey = (t) => Math.floor(t / 864e5);
  const ago = (t) => { const m = Math.round((NOW - t) / 6e4); if (m < 1) return "now"; if (m < 60) return m + " min"; const h = Math.round(m / 60); if (h < 24) return h + " h"; const d = dayKey(NOW) - dayKey(t); return d === 1 ? "Yesterday" : d + " d"; };
  const when = (t) => { const d = new Date(t), hm = String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0"); const dd = dayKey(NOW) - dayKey(t); return dd === 0 ? "Today " + hm : dd === 1 ? "Yesterday " + hm : DOW[d.getUTCDay()] + " " + d.getUTCDate() + " " + MON[d.getUTCMonth()] + ", " + hm; };
  const group = (t) => { const d = dayKey(NOW) - dayKey(t); return d === 0 ? "Today" : d === 1 ? "Yesterday" : d <= 7 ? "This week" : "Earlier"; };
  const KINDS = ["idea", "task", "decision", "question", "note"], KN = { idea: "Idea", task: "Task", decision: "Decision", question: "Question", note: "Note" }, KP = { idea: "Ideas", task: "Tasks", decision: "Decisions", question: "Questions", note: "Notes" };

  const caps = {}; D.captures.forEach((c) => (caps[c.id] = { ...c, t: Date.parse(c.at) }));
  const revBy = {}, revId = {};
  D.revisions.forEach((r) => { const x = { ...r, t: Date.parse(r.at), parents: [] }; (revBy[r.o] = revBy[r.o] || []).push(x); revId[r.id] = x; });
  Object.values(revBy).forEach((l) => l.forEach((r, i) => (r.n = i + 1)));
  D.parents.forEach((p) => revId[p.c].parents.push(p.p));
Object.values(revId).forEach((r) => r.parents.sort((a, b) => revId[a].n - revId[b].n)); // display convention: older parent first
  const rl = (id) => "R" + revId[id].n;

  const rels = D.relations.map((r) => ({ ...r, ts: Date.parse(r.at) }));
  const edgesOf = {}; rels.forEach((r) => { (edgesOf[r.s] = edgesOf[r.s] || []).push(r); (edgesOf[r.t] = edgesOf[r.t] || []).push(r); });
  const deg = (id) => (edgesOf[id] || []).length;
  const objs = D.objects.map((o) => { const cur = revId[o.cur]; return { ...o, src: caps[o.cap].source, t: Math.max(Date.parse(o.created_at), cur.t), links: 0 }; }).sort((a, b) => b.t - a.t);
  const O = {}; objs.forEach((o) => { O[o.id] = o; o.links = deg(o.id); });
  const byTitle = (t) => objs.find((o) => o.title === t);
  const kidsOf = (cid) => objs.filter((o) => o.cap === cid).sort((a, b) => a.ss - b.ss);
  const HUB = objs.slice().sort((a, b) => b.links - a.links)[0];
  const capByPrefix = (p) => D.captures.find((c) => c.id.startsWith(p)).id;

  // Objects Arthur would organize out of captures that are not in the demo database yet (design states only).
  const NEW_TEXT = "Okay, the offline indicator: when a thought is waiting to be organized I should see a small mark, so I know nothing is lost.";
  const SYN = {
    NEW: [{ id: "n1", kind: "idea", title: "Show when a thought is waiting to be organized", src: "voice", links: 0, revs: 1 }, { id: "n2", kind: "task", title: "Design the offline indicator", src: "voice", links: 0, revs: 1 }],
  };
  SYN[capByPrefix("cb0d")] = [{ id: "n3", kind: "idea", title: "Say what changed in my thinking", src: "voice", links: 0, revs: 1 }];

  /* ======================================================================= icons */
  const X = {
    keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
    back: '<path d="M15 5l-7 7 7 7"/>', minus: '<path d="M5 12h14"/>', retry: '<path d="M4 12a8 8 0 1 0 2.6-5.9M4 4.5v4h4"/>', down: '<path d="M6 9l6 6 6-6"/>',
    target: '<circle cx="12" cy="12" r="3"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
  };
  const I = (n, c = "") => (X[n] ? `<svg class="ic ${c}" viewBox="0 0 24 24" aria-hidden="true">${X[n]}</svg>` : A.ic(n, c));

  /* ======================================================================= graph layout (computed once, deterministic) */
  function hash01(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0) / 0x100000000; }
  const GL = (function () {
    const n = objs.length, K = 190, P = {};
    objs.forEach((o) => { const a = hash01(o.id) * Math.PI * 2, r = Math.sqrt(hash01(o.id + "r")) * Math.sqrt(n) * 120; P[o.id] = { x: Math.cos(a) * r, y: Math.sin(a) * r }; });
    for (let it = 0; it < 360; it++) {
      const T = 1 - it / 360, dp = {}; objs.forEach((o) => (dp[o.id] = { x: 0, y: 0 }));
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const a = P[objs[i].id], b = P[objs[j].id]; let dx = a.x - b.x, dy = a.y - b.y; const d = Math.max(Math.hypot(dx, dy), 1), f = (K * K) / d; dx /= d; dy /= d; dp[objs[i].id].x += dx * f; dp[objs[i].id].y += dy * f; dp[objs[j].id].x -= dx * f; dp[objs[j].id].y -= dy * f; }
      rels.forEach((e) => { const a = P[e.s], b = P[e.t]; let dx = a.x - b.x, dy = a.y - b.y; const d = Math.max(Math.hypot(dx, dy), 1), f = (d * d) / K; dx /= d; dy /= d; dp[e.s].x -= dx * f; dp[e.s].y -= dy * f; dp[e.t].x += dx * f; dp[e.t].y += dy * f; });
      objs.forEach((o) => { const p = P[o.id], d = dp[o.id]; d.x -= p.x * 9; d.y -= p.y * 9; const len = Math.hypot(d.x, d.y) || 1, lim = Math.min(len, 60 * T + 1.5); p.x += (d.x / len) * lim; p.y += (d.y / len) * lim; });
    }
    for (let it = 0; it < 60; it++) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const a = P[objs[i].id], b = P[objs[j].id]; const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 1, min = 118; if (d < min) { const m = (min - d) / 2; a.x += (dx / d) * m; a.y += (dy / d) * m; b.x -= (dx / d) * m; b.y -= (dy / d) * m; } }
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; objs.forEach((o) => { const p = P[o.id]; x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
    const pos = {}; objs.forEach((o) => (pos[o.id] = [Math.round(P[o.id].x - x0 + 90), Math.round(P[o.id].y - y0 + 90)]));
    return { pos, w: Math.round(x1 - x0 + 180), h: Math.round(y1 - y0 + 180) };
  })();
  const nodeR = (id) => 7.5 + Math.min(deg(id), 7) * 1.4;
  function shape(kind, r) {
    const s = r * 1.02;
    switch (kind) {
      case "task": return `<rect x="${-s}" y="${-s}" width="${2 * s}" height="${2 * s}" rx="${s * .34}"/>`;
      case "decision": { const d = s * 1.3; return `<path d="M0 ${-d} ${d} 0 0 ${d} ${-d} 0z" stroke-linejoin="round"/>`; }
      case "question": { const h = s * 1.12; const p = [0, 1, 2, 3, 4, 5].map((i) => { const a = Math.PI / 6 + (i * Math.PI) / 3 - Math.PI / 2; return [Math.cos(a) * h, Math.sin(a) * h].map((v) => v.toFixed(1)); }); return `<path d="M${p.map((q) => q.join(" ")).join("L")}z" stroke-linejoin="round"/>`; }
      case "note": return `<rect x="${-s * .86}" y="${-s}" width="${s * 1.72}" height="${2 * s}" rx="${s * .22}"/><path d="M${-s * .45} ${-s * .2}H${s * .45}M${-s * .45} ${s * .32}H${s * .1}" fill="none"/>`;
      default: return `<circle r="${s * 1.05}"/>`;
    }
  }
  const wrap = (t, n) => { const w = t.split(" "), L = [""]; w.forEach((x) => { if ((L[L.length - 1] + " " + x).trim().length > n && L[L.length - 1]) L.push(x); else L[L.length - 1] = (L[L.length - 1] + " " + x).trim(); }); if (L.length > 3) { L.length = 3; L[2] = L[2].replace(/\s*\S*$/, "") + "…"; } return L; };
  const edgeGeom = (e, i) => {
    const [x1, y1] = GL.pos[e.s], [x2, y2] = GL.pos[e.t], dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len, st = A.relStyle[e.kind];
    const rs = nodeR(e.s) + 5, rt = nodeR(e.t) + (st.arrow ? 10 : 5), sx = x1 + ux * rs, sy = y1 + uy * rs, tx = x2 - ux * rt, ty = y2 - uy * rt;
    const bend = (hash01(e.id) > .5 ? 1 : -1) * Math.min(34, len * 0.1), cx = (sx + tx) / 2 - uy * bend, cy = (sy + ty) / 2 + ux * bend;
    return { d: `M${sx.toFixed(1)} ${sy.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`, mx: (sx + 2 * cx + tx) / 4, my: (sy + 2 * cy + ty) / 4 };
  };
  const GEO = {}; rels.forEach((e, i) => (GEO[e.id] = edgeGeom(e, i)));

  /* ======================================================================= lineage (vertical rail) */
  function lineageOf(oid) {
    const revs = revBy[oid], row = {}, kids = {}, lane = {}, res = [];
    revs.forEach((r, i) => (row[r.id] = i)); revs.forEach((r) => r.parents.forEach((p) => (kids[p] = kids[p] || []).push(r.id)));
    revs.forEach((r, i) => {
      const p0 = r.parents[0]; let l = null;
      if (p0 && kids[p0][0] === r.id) l = lane[p0];
      if (l == null) { const from = p0 ? row[p0] : i; l = 0; while (res[l] != null && res[l] >= from) l++; }
      lane[r.id] = l; res[l] = Math.max(res[l] ?? -1, i); r.parents.forEach((p) => (res[lane[p]] = Math.max(res[lane[p]] ?? -1, i)));
    });
    const cur = O[oid].cur, lanes = Math.max(...Object.values(lane)) + 1;
    return { revs, row, lane, lanes, cur, kids, branches: Object.values(kids).reduce((n, k) => n + k.length - 1, 0), merges: revs.filter((r) => r.parents.length > 1).length };
  }
  const evolving = objs.filter((o) => o.revs > 1 && revBy[o.id].length > 1).sort((a, b) => b.revs - a.revs || b.t - a.t);
  const words = (s) => s.split(/\s+/).filter(Boolean).length;
  function diffSegs(a, b) { return A.wordDiff(a, b); }
  const diffHtml = (segs) => segs.map((g) => (g.k === "eq" ? esc(g.s) : g.k === "ins" ? `<ins>${esc(g.s)}</ins>` : `<del>${esc(g.s)}</del>`)).join("");
  function stat(r, pid) { const p = pid && revId[pid]; if (!p) return { add: words(r.body), del: 0, title: false }; const d = diffSegs(p.body, r.body); const c = (k) => d.filter((s) => s.k === k).reduce((n, s) => n + words(s.s), 0); return { add: c("ins"), del: c("del"), title: p.title !== r.title }; }
  const caption = (r) => { if (r.origin === "initial") return "First captured"; if (r.origin === "merge") return "Merged " + r.parents.map(rl).join(" + "); const s = stat(r, r.parents[0]); return `+${s.add} −${s.del} words${s.title ? " · title" : ""}`; };
  const REVO = { initial: "First capture", user_edit: "Your edit", distillation: "From a new capture", merge: "Merge", system: "System" };

  /* ======================================================================= small renderers */
  const kindGlyph = (k) => A.kind(k);
  const margin = (o, opt = {}) => `<div class="mrg">${opt.nosrc ? "" : `<span>${A.srcIc(o.src)}${A.srcName(o.src)}</span>`}<span aria-label="${o.links} connections">${A.ic("link", "sm")}<b class="n">${o.links}</b></span><span aria-label="${o.revs} revisions">${A.ic("rev", "sm")}<b class="n">r${o.revs}</b></span>${o.t && !opt.nowhen ? `<span class="when">${ago(o.t)}</span>` : ""}</div>`;
  const originWord = (o) => (o === "user" ? "Yours" : o === "model" ? "Arthur's" : "Arthur's");
  const originDot = (o) => `<span class="origin${o === "model" ? " model" : ""}" aria-hidden="true"></span>`;
  const verb = (e, id) => { const k = A.REL[e.kind]; if (k.sym) return { t: k.label, dir: "" }; return e.s === id ? { t: k.label, dir: "→" } : { t: A.INV[e.kind], dir: "←" }; };
  const relRow = (e, id) => { const other = O[e.s === id ? e.t : e.s], v = verb(e, id); return `<button class="rel" data-act="edge" data-id="${e.id}">${A.relSwatch(e.kind)}<span><span class="rt">${esc(other.title)}</span><span class="rv">${originDot(e.origin)}<b>${v.dir ? v.dir + " " : ""}${v.t}</b> · ${originWord(e.origin)}</span></span></button>`; };
  const head = (title, sub, right = "") => `<header class="mhead"><div style="flex:1;min-width:0"><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ""}</div>${right}<button class="iconbtn" data-act="settings" aria-label="Settings">${A.ic("settings")}</button></header>`;
  const mark = () => A.mark(24);

  /* ======================================================================= state */
  const BASE = () => ({
    tab: "home", cap: "c", outcome: "success", micGranted: true, capHint: false, dim: "m", nav: "gesture", freeze: false,
    draft: "", typing: false, rec: null, xcribe: false, sys: null, alert: null, pend: null, org: {},
    q: "", kind: "all", detail: null, sheet: null, toast: null, settings: false,
    conMode: "list", conOpen: {}, rf: new Set(Object.keys(A.REL)), of: "all", sel: null, map: null, sheetOpen: false, focusId: HUB.id,
    evoId: (evolving.find((o) => lineageOf(o.id).merges && lineageOf(o.id).branches) || evolving[0]).id, evoSel: null, evoCmp: null, evoTab: "changes", pickOpen: false,
    scrolls: {},
  });

  /* ======================================================================= screens */
  function homeScreen(ph) {
    const s = ph.s;
    const greet = `<div class="hello">Sunday evening</div>`;
    let html = `<header class="mhead"><div class="brandrow">${mark()}Arthur</div><button class="iconbtn" data-act="settings" aria-label="Settings">${A.ic("settings")}</button></header>${greet}<h1 class="hero">What’s on your mind?</h1>`;
    if (s.xcribe) html += `<div class="page"><div class="status-line" role="status"><span class="skel" style="width:14px;height:14px;border-radius:50%"></span><b style="font-weight:600;color:var(--ink)">Transcribing…</b></div><div style="margin-top:14px"><div class="skel" style="height:12px;width:92%;margin-bottom:12px"></div><div class="skel" style="height:12px;width:78%;margin-bottom:12px"></div><div class="skel" style="height:12px;width:54%"></div></div><p style="color:var(--ink-3);font-size:12.5px;margin:14px 0 0">Your recording is being turned into text. It isn’t kept.</p></div>`;
    else html += composer(ph);
    if (s.capHint && !s.typing && !s.alert) html += `<p class="cap-hint">${A.ic("mic", "sm")}Tap Speak and Android will ask to use the microphone. Nothing is recorded until then.</p>`;
    if (s.alert) html += alertBlock(s.alert);
    html += stream(ph);
    return `<div class="scroll" data-k="home">${html}</div>`;
  }
  function composer(ph) {
    const s = ph.s;
    if (s.typing) return `<div class="page"><textarea data-draft aria-label="Write a thought" placeholder="Write it down…" ${s.freeze ? "" : "data-autofocus"}>${esc(s.draft)}</textarea><div class="acts"><button class="micbtn" data-act="speak" aria-label="Speak instead">${A.ic("mic")}</button><span class="hint">Saved first. Arthur organizes after.</span><button class="pbtn primary" data-act="send" style="height:52px;min-width:124px" ${s.draft.trim() ? "" : 'aria-disabled="true" style="height:52px;min-width:124px;opacity:.4"'}>Capture</button></div></div>`;
    if (s.cap === "a") return `<div class="knot-wrap"><button class="knot" data-act="speak" aria-label="Tap to speak">${A.ic("mic")}<b>Tap to speak</b></button><div class="orlink"><button class="tlink" data-act="type">${I("keyboard")} or write it down</button></div></div>`;
    if (s.cap === "b") return `<div class="compose-b"><div class="page"><button class="rules" data-act="type">Write it down…</button><div class="acts"><button class="mic-s" data-act="speak" aria-label="Speak">${A.ic("mic")}</button><span class="hint">Voice or text. Saved first.</span><button class="pbtn primary" data-act="type" style="min-width:110px">Capture</button></div></div></div>`;
    return `<div class="page"><button class="rules" data-act="type">Write it down, or just say it.</button><div class="acts"><button class="speak" data-act="speak">${A.ic("mic")}Speak</button><button class="kbbtn" data-act="type" aria-label="Type a thought">${I("keyboard")}</button></div></div>`;
  }
  const ALERTS = {
    denied: ["Microphone is off", "Allow microphone access for Arthur in Android settings, then try again. You can still type your thought.", ["type"]],
    sttretry: ["Couldn’t reach the speech service", "Your recording is kept on this phone only while you retry, so you don’t have to say it again. It’s deleted once it’s transcribed, if you discard it, when you leave this screen, or after 15 minutes.", ["retrystt", "discardrec"]],
    sttfail: ["Couldn’t transcribe", "Speech-to-text isn’t available right now. Nothing was saved and the recording wasn’t kept. You can type it instead.", ["speak", "type"]],
    empty: ["No speech recognised", "Nothing was saved. Record again, or type it.", ["speak", "type"]],
    interrupted: ["Recording stopped", "Arthur left the screen, so the recording ended. Nothing was saved.", ["speak", "type"]],
  };
  function alertBlock(k) { const [t, m, acts] = ALERTS[k]; return `<div class="note-block ${k === "denied" || k === "sttretry" ? "" : "err"}" role="alert">${A.ic("warn")}<div style="flex:1"><b>${t}</b>${m}<div class="row-acts">${acts.includes("retrystt") ? `<button class="pbtn sm primary" data-act="retryStt">${I("retry")}Retry transcription</button>` : ""}${acts.includes("discardrec") ? `<button class="pbtn sm" data-act="discardRec">Discard recording</button>` : ""}${acts.includes("speak") ? `<button class="pbtn sm" data-act="speak">${A.ic("mic")}Record again</button>` : ""}${acts.includes("type") ? `<button class="pbtn sm ${k === "denied" ? "primary" : ""}" data-act="type">Type instead</button>` : ""}${k === "sttretry" ? "" : `<button class="pbtn sm ghost" data-act="dismissAlert">Dismiss</button>`}</div></div></div>`; }

  function stream(ph) {
    const s = ph.s; let out = "", lastG = null;
    const list = []; if (s.pend) list.push({ id: "NEW", source: s.pend.kind, content: s.pend.text, t: NOW - 1e3, ran: 1, pend: true });
    D.captures.slice(0, 7).forEach((c) => list.push({ ...caps[c.id] }));
    list.forEach((c) => {
      const g = group(c.t); if (g !== lastG) { out += `<div class="day" style="padding:18px 0 0">${g}</div>`; lastG = g; } out += captureGroup(ph, c);
    });
    return `<div class="stream">${out}<div class="seeall"><button class="tlink" data-act="tab" data-id="ideas">All ${objs.length} ideas ${A.ic("chev")}</button></div></div>`;
  }
  function captureGroup(ph, c) {
    const s = ph.s, st = s.org[c.id], real = kidsOf(c.id), syn = SYN[c.id] || [];
    let kids = "", badge = "", cls = "";
    const kid = (o, draw) => `<button class="kid ${draw ? "thread-draw" : ""}" data-act="${O[o.id] ? "openIdea" : "noop"}" data-id="${o.id}">${kindGlyph(o.kind)}<span><span class="kt">${esc(o.title)}</span>${margin(o, { nosrc: true, nowhen: true })}</span></button>`;
    const ghost = (w) => `<div class="kid ghost-kid"><svg class="kind" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.6" stroke-dasharray="2 2.4" style="stroke:var(--pencil)"/></svg><span><span class="skel" style="display:block;height:13px;width:${w}%"></span><span class="skel" style="display:block;height:10px;width:${w - 30}%"></span></span></div>`;
    if (c.pend && s.pend.phase === "saved") badge = `<span class="pend-badge ok">${A.ic("check", "sm")}Capture saved</span>`;
    if (st === "organizing") { cls = "pending-thread"; badge = `<span class="pend-badge"><i class="dot dash"></i>Arthur is organizing…</span>`; kids = ghost(72) + (c.id === "NEW" ? ghost(54) : ""); }
    else if (st === "failed") { cls = "pending-thread"; badge = `<span class="pend-badge"><i class="dot dash"></i>Saved, not organized</span>`; kids = `<div class="kid ghost-kid"><svg class="kind" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.6" stroke-dasharray="2 2.4" style="stroke:var(--pencil)"/></svg><span><span class="kt" style="font-style:normal;color:var(--ink);font-weight:500;font-family:var(--sans);font-size:15px">Your thought is saved.</span><span style="display:block;color:var(--ink-3);font-size:13px;margin:2px 0 10px;font-style:normal;font-family:var(--sans)">Arthur couldn’t organize it just now. Nothing was lost.</span><button class="pbtn sm" data-act="retryOrg" data-id="${c.id}">${I("retry")}Retry organizing</button></span></div>`; }
    else if (st === "organized") { badge = `<span class="pend-badge ok">${A.ic("check", "sm")}Organized</span>`; kids = syn.map((o) => kid(o, true)).join(""); }
    else if (real.length) kids = real.map((o) => kid(o)).join("");
    else if (c.ran === 0) { cls = "pending-thread"; badge = `<span class="pend-badge"><i class="dot dash"></i>Not organized yet</span>`; kids = `<div class="kid ghost-kid"><svg class="kind" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.6" stroke-dasharray="2 2.4" style="stroke:var(--pencil)"/></svg><span><span style="display:block;color:var(--ink-2);font-size:14px;margin:0 0 10px;font-style:normal;font-family:var(--sans)">Saved. Arthur hasn’t organized this one.</span><button class="pbtn sm" data-act="retryOrg" data-id="${c.id}">${I("retry")}Organize now</button></span></div>`; }
    else if (!c.pend) kids = `<div class="empty-kid">Nothing to organize in this one.</div>`;
    const has = kids && !kids.includes("empty-kid") ? " has-kids" : "";
    return `<section class="group${has} ${cls}"><div class="cap-row"><div class="cap-dot">${A.srcIc(c.source)}</div><div><div class="cap-q">“${esc(c.content)}”</div><div class="cap-meta">${A.srcName(c.source)} · ${c.pend ? "just now" : when(c.t)}${badge ? "" : ""}</div>${badge ? `<div style="margin-top:5px">${badge}</div>` : ""}</div></div><div class="kids">${kids}</div></section>`;
  }

  function recOverlay(ph) {
    const t = ph.s.rec.t, mm = Math.floor(t / 60), ss = String(t % 60).padStart(2, "0");
    return `<div class="rec" role="dialog" aria-label="Recording"><div class="top"><button class="pbtn ghost" data-act="discard" style="padding:0 12px">${A.ic("x")}Discard</button></div><div class="mid"><div class="thread-v"></div><div class="live" aria-hidden="true"></div><div class="lbl" role="status">Listening</div><div class="clock" aria-label="${mm} minutes ${ss} seconds">${mm}:${ss}</div><p class="cue">Say it however it comes. Arthur organizes it after.</p></div><div class="bottom"><button class="stop" data-act="stop"><i></i>Stop and save</button><div class="fine">Audio is sent for transcription and isn’t kept.</div></div></div>`;
  }
  function sysDialog() { return `<div class="sysdlg" role="alertdialog" aria-label="Android permission (not part of Arthur)">${A.ic("mic")}<h5>Allow Arthur to record audio?</h5><button class="o" data-act="sys" data-v="allow">While using the app</button><button class="o" data-act="sys" data-v="deny">Don’t allow</button><small>Android system dialog. Arthur can’t restyle it.</small></div>`; }

  function ideasScreen(ph) {
    const s = ph.s, q = s.q.trim().toLowerCase();
    const counts = { all: objs.length }; KINDS.forEach((k) => (counts[k] = objs.filter((o) => o.kind === k).length));
    const tabs = ["all", ...KINDS].map((k) => `<button role="tab" data-act="kind" data-id="${k}" aria-selected="${s.kind === k}" class="${counts[k] ? "" : "zero"}">${k === "all" ? "All" : KP[k]}<i>${counts[k]}</i></button>`).join("");
    return `<div class="scroll" data-k="ideas" style="display:flex;flex-direction:column;overflow:hidden">${head("Ideas", `${objs.length} thoughts, newest first`)}<label class="search">${A.ic("search")}<input data-q type="search" placeholder="Search ideas" aria-label="Search ideas" value="${esc(s.q)}"></label><div class="hseg" role="tablist" aria-label="Kind">${tabs}</div><div id="ideaList" style="flex:1;overflow-y:auto;min-height:0;padding-bottom:24px">${ideaList(s)}</div></div>`;
  }
  function ideaList(s) {
    const q = s.q.trim().toLowerCase(); let last = null, out = "";
    const list = objs.filter((o) => (s.kind === "all" || o.kind === s.kind) && (!q || (o.title + " " + o.body).toLowerCase().includes(q)));
    if (!list.length) return `<div class="footnote" style="padding-top:28px">${q ? `Nothing matches “${esc(s.q)}”.` : `No ${KP[s.kind].toLowerCase()} yet.`}<br>${q ? "Try fewer words, or clear the kind filter." : "Capture a thought and Arthur will organize it."}</div>`;
    list.forEach((o) => { const g = group(o.t); if (g !== last && s.kind === "all" && !q) { out += `<div class="day">${g}</div>`; last = g; } out += `<button class="idea" data-act="openIdea" data-id="${o.id}">${kindGlyph(o.kind)}<span><span class="t">${esc(o.title)}</span><span class="s">${esc(o.body)}</span>${margin(o)}</span></button>`; });
    return out;
  }

  function detailScreen(ph) {
    const o = O[ph.s.detail], es = (edgesOf[o.id] || []).slice().sort((a, b) => b.ts - a.ts), cap = caps[o.cap], r1 = revBy[o.id], cur = revId[o.cur];
    const span = cap.content.slice(0, 0); const a = o.ss, b = o.se;
    const q = `${esc(cap.content.slice(0, a))}<mark>${esc(cap.content.slice(a, b))}</mark>${esc(cap.content.slice(b))}`;
    const clip = cap.content.length > 220 ? (() => { const s0 = Math.max(0, a - 70), e0 = Math.min(cap.content.length, b + 60); return (s0 ? "…" : "") + esc(cap.content.slice(s0, a)) + "<mark>" + esc(cap.content.slice(a, b)) + "</mark>" + esc(cap.content.slice(b, e0)) + (e0 < cap.content.length ? "…" : ""); })() : q;
    const rel3 = es.slice(0, 3).map((e) => relRow(e, o.id)).join("");
    const last3 = r1.slice(-3); const mr = last3.map((r) => `<button class="mr ${r.id === o.cur ? "cur" : ""}" data-act="openEvo" data-id="${o.id}"><span class="b">R${r.n}</span><span class="x">${REVO[r.origin]}<small>${ago(r.t)}${r.id === o.cur ? " · current" : ""}</small></span></button>`).join("");
    return `<div class="detail-top"><button class="iconbtn" data-act="back" aria-label="Back to ideas">${I("back")}</button><span class="sp"></span><button class="iconbtn" data-act="openMap" data-id="${o.id}" aria-label="Show on map">${A.ic("graph")}</button></div>
    <div class="scroll" data-k="detail"><div class="d-head"><div class="meta">${kindGlyph(o.kind)}<span class="kindname">${KN[o.kind]}</span><span>· edited ${ago(o.t)} ago</span></div><h2>${esc(o.title)}</h2></div>
    <div class="d-margin">${margin(o, { nowhen: true })}</div>
    <div class="d-body">${esc(o.body)}</div>
    <section class="facet"><div class="facet-h"><h3>Source</h3><span class="n">where this came from</span></div><div class="cap-meta2">${A.srcIc(cap.source)}<span>${A.srcName(cap.source)} capture · ${when(cap.t)}</span></div><blockquote class="quote">${clip}</blockquote></section>
    <section class="facet"><div class="facet-h"><h3>Connections</h3><span class="n">${o.links}</span>${o.links ? `<button class="tlink" data-act="openMap" data-id="${o.id}">Show on map ${A.ic("chev")}</button>` : ""}</div>${o.links ? rel3 : `<p class="footnote" style="padding:4px 0 0">No connections yet. Arthur can look for some.</p>`}${o.links > 3 ? `<button class="tlink" data-act="openCon" data-id="${o.id}" style="margin-top:4px">All ${o.links} connections ${A.ic("chev")}</button>` : ""}<div><button class="tlink" data-act="find" data-id="${o.id}">${A.ic("wand")} Find connections for this idea</button></div></section>
    <section class="facet"><div class="facet-h"><h3>Evolution</h3><span class="n">${o.revs} ${o.revs === 1 ? "revision" : "revisions"}</span>${o.revs > 1 ? `<button class="tlink" data-act="openEvo" data-id="${o.id}">Open ${A.ic("chev")}</button>` : ""}</div>${o.revs > 1 ? `<div class="minirail">${r1.length > 3 ? `<div class="mr" style="min-height:30px"><span class="b" style="border-style:dashed;border-color:var(--ink-4);color:var(--ink-3)">…</span><span class="x" style="color:var(--ink-3)">${r1.length - 3} earlier</span></div>` : ""}${mr}</div>` : `<p class="footnote" style="padding:4px 0 0">One version so far. Revise it and Arthur keeps both.</p>`}</section>
    </div><div class="actbar"><button class="pbtn primary" data-act="revise" data-id="${o.id}">${A.ic("edit")}Revise</button><button class="pbtn" data-act="branch" data-id="${o.id}">${A.ic("branch")}Branch</button></div>`;
  }

  /* ---------------- Connections */
  const shownRels = (s) => rels.filter((e) => s.rf.has(e.kind) && (s.of === "all" || (s.of === "yours" ? e.origin === "user" : e.origin !== "user")));
  const filterCount = (s) => (s.rf.size < Object.keys(A.REL).length ? 1 : 0) + (s.of !== "all" ? 1 : 0);
  function conFilterSheet(ph) {
    const s = ph.s;
    const o = [["all", "All"], ["yours", "Yours"], ["arthur", "Arthur’s"]].map(([v, l]) => `<button class="chip txt" style="flex:1;justify-content:center" aria-pressed="${s.of === v}" data-act="of" data-id="${v}">${l}</button>`).join("");
    const k = Object.keys(A.REL).map((kk) => `<button class="rel" style="grid-template-columns:62px minmax(0,1fr) 40px;opacity:${s.rf.has(kk) ? 1 : .45}" data-act="rf" data-id="${kk}" aria-pressed="${s.rf.has(kk)}">${A.relSwatch(kk, 52)}<span><span class="rt" style="font:500 15px var(--sans)">${A.REL[kk].label}</span><span class="rv">${A.REL[kk].sym ? "No direction" : "Has a direction"}</span></span><span class="ic" style="justify-self:end;width:22px;height:22px;border:1.5px solid var(--ink-3);border-radius:5px;display:flex;align-items:center;justify-content:center;color:var(--ink)">${s.rf.has(kk) ? A.ic("check", "sm") : ""}</span></button>`).join("");
    return `<div class="scrim" data-act="closeSheet"></div><div class="sheet" role="dialog" aria-label="Show connections"><div class="grab"></div><div class="sbody"><h2>Show connections</h2><div class="sec-t">Made by</div><div style="display:flex;gap:8px">${o}</div><div class="sec-t">Kind <span class="n">The line shape is the kind. Tap to hide or show.</span></div>${k}</div><div class="sbar"><button class="pbtn" data-act="resetFilters">Show all</button><button class="pbtn primary" data-act="closeSheet">Done</button></div></div>`;
  }
  function connectionsScreen(ph) {
    const s = ph.s, shown = shownRels(s), fc = filterCount(s);
    const sub = `${objs.length} ideas · ${shown.length} links`;
    const wand = `<button class="iconbtn" data-act="find" data-id="" aria-label="Find connections">${A.ic("wand")}</button>`;
    const ctl = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px var(--gut) 10px"><div class="tog" role="group" aria-label="View"><button data-act="conMode" data-id="list" aria-pressed="${s.conMode === "list"}">${A.ic("list")}List</button><button data-act="conMode" data-id="map" aria-pressed="${s.conMode === "map"}">${A.ic("graph")}Map</button></div><button class="pbtn sm" data-act="filters" ${fc ? 'style="border-color:var(--accent)"' : ""}>${A.ic("filter")}Filter${fc ? ` · ${fc}` : ""}</button></div>`;
    if (s.conMode === "map") return `<div class="scroll" data-k="con" style="display:flex;flex-direction:column;overflow:hidden">${head("Connections", sub, wand)}${ctl}<div style="position:relative;flex:1;min-height:0;border-top:1px solid var(--line-soft)">${mapHtml(ph, shown)}</div></div>`;
    const withLinks = objs.filter((o) => shown.some((e) => e.s === o.id || e.t === o.id)).map((o) => ({ o, es: shown.filter((e) => e.s === o.id || e.t === o.id) })).sort((a, b) => b.es.length - a.es.length || b.o.t - a.o.t);
    const none = objs.filter((o) => !deg(o.id)).length;
    let list = withLinks.map(({ o, es }, i) => { const open = s.conOpen[o.id] ?? (s.focusId === o.id && !!s.conOpen.__f); return `<div class="hub" data-open="${open}"><button class="hub-h" data-act="hub" data-id="${o.id}" aria-expanded="${open}">${kindGlyph(o.kind)}<span class="t">${esc(o.title)}</span><span class="cnt" aria-label="${es.length} connections">${es.length}</span><span class="chev">${A.ic("chev", "sm")}</span></button><div class="hub-b">${es.map((e) => relRow(e, o.id)).join("")}<div class="openidea"><button class="tlink" data-act="openIdea" data-id="${o.id}">Open idea ${A.ic("chev")}</button></div></div></div>`; }).join("");
    list += `<p class="footnote">${none ? `${none} idea${none > 1 ? "s have" : " has"} no connections yet.` : "Every idea here has at least one connection."} Each link shows under both of its ideas.</p>`;
    return `<div class="scroll" data-k="con" style="display:flex;flex-direction:column;overflow:hidden">${head("Connections", sub, wand)}${ctl}<div style="flex:1;overflow-y:auto;min-height:0;border-top:1px solid var(--line-soft)" id="conList">${list}</div></div>`;
  }

  /* map: SVG world, pinch + pan live in bindMap */
  function mapHtml(ph, shown) {
    const s = ph.s, sel = s.sel; let fN = null, fE = null;
    if (sel) { fN = new Set(); fE = new Set(); if (sel.type === "node") shown.forEach((e) => { if (e.s === sel.id || e.t === sel.id) { fN.add(e.s); fN.add(e.t); fE.add(e.id); } }), fN.add(sel.id); else { const e = rels.find((x) => x.id === sel.id); fN.add(e.s); fN.add(e.t); fE.add(e.id); } }
    if (!s.map) { s.map = { x: 0, y: 0, k: 1 }; s.mapFresh = true; }
    const m = s.map, k = m.k, z = k < .75 ? "lo" : k < 1.5 ? "mid" : "hi";
    let g = `<defs>${A.markerDefs()}</defs><g class="world" transform="translate(${m.x} ${m.y}) scale(${k})">`;
    shown.forEach((e) => {
      const st = A.relStyle[e.kind], geo = GEO[e.id], dim = fE && !fE.has(e.id), isSel = sel && sel.type === "edge" && sel.id === e.id, col = `var(--rel-${e.kind})`;
      g += `<g class="g-edge${dim ? " dim" : ""}" data-id="${e.id}">`;
      if (isSel) g += `<path d="${geo.d}" fill="none" stroke="${col}" stroke-width="12" opacity=".18" stroke-linecap="round"/>`;
      g += `<path d="${geo.d}" fill="none" stroke="${col}" stroke-width="${st.w * (isSel ? 1.3 : 1)}" ${st.dash ? `stroke-dasharray="${st.dash}"` : ""} stroke-linecap="${st.cap || "butt"}" ${st.arrow ? `marker-end="url(#m-${e.kind})"` : ""} ${st.arrow === "bars" ? `marker-start="url(#m-${e.kind})"` : ""}/>`;
      if (st.double) g += `<path d="${geo.d}" fill="none" stroke="var(--ground)" stroke-width="1.7"/>`;
      g += `<path class="ehit" d="${geo.d}" fill="none" stroke="transparent" stroke-width="26" style="cursor:pointer"/></g>`;
    });
    objs.forEach((o) => {
      const p = GL.pos[o.id], r = nodeR(o.id), isSel = sel && sel.type === "node" && sel.id === o.id, dim = fN && !fN.has(o.id), d = deg(o.id);
      if (!d) return;
      const inF = fN && fN.has(o.id), lc = inF ? "lab-0" : (fN ? (d >= 4 ? "lab-1" : "lab-2") : d >= 3 ? "lab-1" : "lab-2");
      g += `<g class="g-node${isSel ? " sel" : ""}${dim ? " dim" : ""}" data-id="${o.id}" transform="translate(${p[0]} ${p[1]})" tabindex="0" role="button" aria-label="${o.kind}: ${esc(o.title)}, ${d} connections">`;
      if (isSel) g += `<circle r="${r + 12}" fill="var(--accent)" opacity=".13"/>`;
      g += `<g class="shape">${shape(o.kind, r)}</g><circle class="hit" style="--r:${r}"/>`;
      g += `<text class="g-label ${lc}${isSel ? " sel" : ""}" text-anchor="middle" y="${r + 18}" style="--ly:${r + 18}">${wrap(o.title, 18).map((ln, i) => `<tspan x="0" dy="${i ? 1.15 : 0}em">${esc(ln)}</tspan>`).join("")}</text></g>`;
    });
    if (sel && sel.type === "edge") { const e = rels.find((x) => x.id === sel.id), geo = GEO[e.id], lbl = A.REL[e.kind].label, col = `var(--rel-${e.kind})`; g += `<g class="g-elabel" transform="translate(${geo.mx} ${geo.my})"><g class="inv"><rect x="-${lbl.length * 4 + 8}" y="-11" width="${lbl.length * 8 + 16}" height="22" rx="4" fill="var(--overlay)" stroke="${col}" stroke-opacity=".7"/><text text-anchor="middle" y="4.5" fill="${col}" style="font:500 12px var(--sans)">${lbl}</text></g></g>`; }
    g += `</g>`;
    const mm = minimap(ph);
    return `<div class="mapwrap"><svg class="mapsvg" data-z="${z}" style="--inv:${(1 / k).toFixed(3)}" role="application" aria-label="Connections map. Drag to pan, pinch to zoom.">${g}</svg><div class="minimap" aria-hidden="true">${mm}</div><div class="mapctl"><button data-act="zoom" data-id="in" aria-label="Zoom in">${A.ic("plus")}</button><button data-act="zoom" data-id="out" aria-label="Zoom out">${I("minus")}</button></div></div>`;
  }
  function minimap(ph) {
    const W = 84, H = 66, sc = Math.min(W / GL.w, H / GL.h), ox = (W - GL.w * sc) / 2, oy = (H - GL.h * sc) / 2;
    const dots = objs.filter((o) => deg(o.id)).map((o) => `<circle cx="${(ox + GL.pos[o.id][0] * sc).toFixed(1)}" cy="${(oy + GL.pos[o.id][1] * sc).toFixed(1)}" r="${o.id === ph.s.focusId || (ph.s.sel && ph.s.sel.id === o.id) ? 2.6 : 1.4}" fill="${ph.s.sel && ph.s.sel.id === o.id ? "var(--accent)" : "var(--ink-3)"}"/>`).join("");
    return `<svg viewBox="0 0 ${W} ${H}">${dots}<rect class="mm-view" x="0" y="0" width="10" height="10" fill="none" stroke="var(--accent)" stroke-width="1"/></svg>`;
  }
  function mapSize(ph) { const sv = ph.root.querySelector(".mapsvg"); return sv ? { w: sv.clientWidth, h: sv.clientHeight } : { w: 390, h: 440 }; }
  function centerOn(ph, wx, wy, k, anim) {
    const sz = mapSize(ph), s = ph.s, visH = sz.h - (s.sel ? 150 : 0), kk = k ?? s.map.k;
    s.map = { k: kk, x: Math.round(sz.w / 2 - wx * kk), y: Math.round(visH / 2 - wy * kk) };
    applyMap(ph, anim);
  }
  function applyMap(ph, anim) {
    const sv = ph.root.querySelector(".mapsvg"); if (!sv) return; const m = ph.s.map, w = sv.querySelector(".world");
    if (anim && !matchMedia("(prefers-reduced-motion: reduce)").matches) { w.classList.add("anim"); setTimeout(() => w.classList.remove("anim"), 320); }
    w.setAttribute("transform", `translate(${m.x} ${m.y}) scale(${m.k})`); sv.style.setProperty("--inv", (1 / m.k).toFixed(3)); sv.dataset.z = m.k < .75 ? "lo" : m.k < 1.5 ? "mid" : "hi";
    const lbl = sv.querySelectorAll(".g-elabel .inv"); lbl.forEach((n) => n.setAttribute("transform", `scale(${1 / m.k})`));
    const mmv = ph.root.querySelector(".mm-view"); if (mmv) { const sz = mapSize(ph), W = 84, H = 66, sc = Math.min(W / GL.w, H / GL.h), ox = (W - GL.w * sc) / 2, oy = (H - GL.h * sc) / 2; mmv.setAttribute("x", (ox + (-m.x / m.k) * sc).toFixed(1)); mmv.setAttribute("y", (oy + (-m.y / m.k) * sc).toFixed(1)); mmv.setAttribute("width", ((sz.w / m.k) * sc).toFixed(1)); mmv.setAttribute("height", ((sz.h / m.k) * sc).toFixed(1)); }
  }
  function bindMap(ph) {
    const sv = ph.root.querySelector(".mapsvg"); if (!sv) return;
    if (ph.s.mapFresh) { ph.s.mapFresh = false; const sel = ph.s.sel; if (sel && sel.type === "edge") { const g = GEO[sel.id]; centerOn(ph, g.mx, g.my, 1); } else { const p = GL.pos[(sel && sel.id) || ph.s.focusId] || GL.pos[HUB.id]; centerOn(ph, p[0], p[1], 1); } } else applyMap(ph);
    const ptr = new Map(); let moved = false, pinch = null, drag = null;
    const sc = () => { const r = sv.getBoundingClientRect(); return sv.clientWidth ? r.width / sv.clientWidth : 1; };
    const local = (e) => { const r = sv.getBoundingClientRect(), f = sc(); return { x: (e.clientX - r.left) / f, y: (e.clientY - r.top) / f }; };
    const zoomAt = (p, nk) => { const m = ph.s.map; nk = Math.max(.4, Math.min(2.8, nk)); m.x = p.x - ((p.x - m.x) * nk) / m.k; m.y = p.y - ((p.y - m.y) * nk) / m.k; m.k = nk; };
    sv.addEventListener("pointerdown", (e) => { ptr.set(e.pointerId, local(e)); moved = false; if (ptr.size === 1) drag = { ...ptr.get(e.pointerId), mx: ph.s.map.x, my: ph.s.map.y }; if (ptr.size === 2) { const [a, b] = [...ptr.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: ph.s.map.k }; } });
    sv.addEventListener("pointermove", (e) => {
      if (!ptr.has(e.pointerId)) return; const p = local(e); ptr.set(e.pointerId, p);
      if (ptr.size === 2 && pinch) { const [a, b] = [...ptr.values()]; zoomAt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, (pinch.k * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d); moved = true; applyMap(ph); }
      else if (ptr.size === 1 && drag) { const dx = p.x - drag.x, dy = p.y - drag.y; if (!moved && Math.hypot(dx, dy) < 6) return; moved = true; ph.s.map.x = drag.mx + dx; ph.s.map.y = drag.my + dy; applyMap(ph); }
    });
    const up = (e) => { ptr.delete(e.pointerId); if (ptr.size < 2) pinch = null; if (ptr.size === 1) { const [id, p] = [...ptr.entries()][0]; drag = { ...p, mx: ph.s.map.x, my: ph.s.map.y }; } if (!ptr.size) setTimeout(() => (moved = false), 0); };
    sv.addEventListener("pointerup", up); sv.addEventListener("pointercancel", up); sv.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") up(e); });
    sv.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(local(e), ph.s.map.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)); applyMap(ph); }, { passive: false });
    sv.addEventListener("click", (e) => {
      if (moved) return; const n = e.target.closest(".g-node"), ed = e.target.closest(".g-edge");
      if (n) selectMap(ph, { type: "node", id: n.dataset.id }); else if (ed) selectMap(ph, { type: "edge", id: ed.dataset.id }); else if (ph.s.sel) { ph.s.sel = null; ph.s.sheetOpen = false; render(ph); }
    });
    const mm = ph.root.querySelector(".minimap"); if (mm) mm.addEventListener("click", (e) => { const r = mm.getBoundingClientRect(), W = 84, H = 66, f = Math.min(W / GL.w, H / GL.h), ox = (W - GL.w * f) / 2, oy = (H - GL.h * f) / 2; centerOn(ph, ((e.clientX - r.left) / sc() - ox) / f, ((e.clientY - r.top) / sc() - oy) / f, null, true); });
  }
  function selectMap(ph, sel) {
    const s = ph.s; s.sel = sel; s.sheetOpen = false;
    if (sel.type === "node") s.focusId = sel.id;
    render(ph);
    const sz = mapSize(ph); // after sheet exists the visible height shrinks, handled in centerOn
    if (sel.type === "node") { const p = GL.pos[sel.id]; centerOn(ph, p[0], p[1], Math.max(s.map.k, 1), true); } else { const g = GEO[sel.id]; centerOn(ph, g.mx, g.my, Math.max(s.map.k, 1), true); }
  }

  function sheetHtml(ph) {
    const s = ph.s; let h = "";
    if (s.conMode === "map" && s.tab === "connections" && s.sel && !s.sheet) {
      const sel = s.sel;
      if (sel.type === "node") {
        const o = O[sel.id], es = shownRels(s).filter((e) => e.s === o.id || e.t === o.id);
        h = `<div class="sheet over-tabs" role="dialog" aria-label="${esc(o.title)}"><button class="grab" data-act="sheetToggle" aria-label="${s.sheetOpen ? "Collapse" : "Expand"}"></button><div class="peek"><div class="pm">${kindGlyph(o.kind)}<span class="kindname">${KN[o.kind]}</span><span>· ${ago(o.t)} ago</span></div><div class="pt">${esc(o.title)}</div>${margin(o, { nowhen: true })}${s.sheetOpen ? `<div class="sbody" style="padding:6px 0 0;max-height:34vh">${es.map((e) => relRow(e, o.id)).join("")}</div>` : ""}<div class="pa"><button class="pbtn primary" data-act="openIdea" data-id="${o.id}">Open idea</button><button class="pbtn" data-act="sheetToggle">${es.length} connection${es.length === 1 ? "" : "s"} ${s.sheetOpen ? I("down") : A.ic("chev", "sm")}</button></div></div></div>`;
      } else h = edgeSheet(ph, rels.find((e) => e.id === sel.id), false);
    }
    if (s.sheet) {
      const sh = s.sheet;
      if (sh.type === "edge") h = `<div class="scrim" data-act="closeSheet"></div>` + edgeSheet(ph, rels.find((e) => e.id === sh.id), true);
      if (sh.type === "settings") h = "";
      if (sh.type === "revise") {
        const o = O[sh.id], cur = revId[sh.from || o.cur], br = sh.mode === "branch", next = revBy[o.id].length + 1;
        h = `<div class="scrim" data-act="closeSheet"></div><div class="sheet" role="dialog" aria-label="${br ? "Branch" : "Revise"}"><div class="grab"></div><div class="sbody"><h2>${br ? `Branch from ${rl(cur.id)}` : "Revise this idea"}</h2><p style="color:var(--ink-3);margin:6px 0 0;font-size:13.5px">${br ? `Try another direction from ${rl(cur.id)}. It stays alongside the current version until you merge them.` : `Saves as R${next}. ${rl(o.cur)} stays exactly as it is.`}</p><label class="field"><span>Title</span><input value="${esc(cur.title)}"></label><label class="field"><span>Text</span><textarea>${esc(cur.body)}</textarea></label></div><div class="sbar"><button class="pbtn" data-act="closeSheet">Cancel</button><button class="pbtn primary" data-act="saveRev" data-id="${br ? "Branch from " + rl(cur.id) : "Revise"}" data-n="R${next}">${br ? "Create branch R" + next : "Save as R" + next}</button></div></div>`;
      }
      if (sh.type === "merge") {
        const L = lineageOf(sh.id), pick = sh.pick, next = L.revs.length + 1;
        h = `<div class="scrim" data-act="closeSheet"></div><div class="sheet" role="dialog" aria-label="Merge"><div class="grab"></div><div class="sbody"><h2>Merge revisions</h2><p style="color:var(--ink-3);margin:6px 0 0;font-size:13.5px">Pick two or more. You write the merged text. Arthur never merges for you.</p><div class="cmp" style="margin-top:14px">${L.revs.map((r) => `<button class="chip" aria-pressed="${pick.includes(r.id)}" data-act="mergePick" data-id="${r.id}">R${r.n}</button>`).join("")}</div><label class="field"><span>Merged text</span><textarea>${esc(revId[pick[pick.length - 1]].body)}</textarea></label><label style="display:flex;gap:10px;align-items:center;margin-top:14px;min-height:44px;color:var(--ink-2)"><input type="checkbox" checked style="width:20px;height:20px;accent-color:var(--accent)"> Make the merge the current revision</label></div><div class="sbar"><button class="pbtn" data-act="closeSheet">Cancel</button><button class="pbtn primary ${pick.length < 2 ? "" : ""}" ${pick.length < 2 ? 'aria-disabled="true" style="opacity:.4"' : ""} data-act="saveRev" data-id="Merge ${pick.map((p) => rl(p)).join(" + ")}" data-n="R${next}">Merge ${pick.map((p) => rl(p)).join(" + ")}</button></div></div>`;
      }
      if (sh.type === "pick") h = `<div class="scrim" data-act="closeSheet"></div><div class="sheet" role="dialog" aria-label="Choose an idea"><div class="grab"></div><div class="sbody"><h2>Choose an idea</h2><p style="color:var(--ink-3);margin:6px 0 4px;font-size:13.5px">${evolving.length} ideas have more than one revision.</p>${evolving.map((o) => { const L = lineageOf(o.id); return `<button class="idea" style="padding-left:0;padding-right:0" data-act="evoSet" data-id="${o.id}">${kindGlyph(o.kind)}<span><span class="t">${esc(o.title)}</span><span class="mrg" style="margin-top:5px"><span>${o.revs} revisions</span>${L.branches ? `<span>${L.branches} branch${L.branches > 1 ? "es" : ""}</span>` : ""}${L.merges ? `<span>${L.merges} merge${L.merges > 1 ? "s" : ""}</span>` : ""}${o.id === ph.s.evoId ? `<span style="color:var(--accent)">${A.ic("check", "sm")}Open</span>` : ""}</span></span></button>`; }).join("")}</div></div>`;
      if (sh.type === "filters") h = conFilterSheet(ph);
      if (sh.type === "find") h = `<div class="scrim" data-act="closeSheet"></div><div class="sheet" role="dialog" aria-label="Find connections"><div class="grab"></div><div class="sbody"><h2>${sh.id ? "Find connections for this idea" : "Find connections"}</h2><p style="color:var(--ink-2);margin:10px 0 0;line-height:1.5">Arthur asks its model to propose links among your recent ideas, then checks each one twice before saving it. This sends idea text to a cloud model and can take up to three requests. Nothing you wrote changes.</p></div><div class="sbar"><button class="pbtn" data-act="closeSheet">Not now</button><button class="pbtn primary" data-act="closeSheet">Find connections</button></div></div>`;
    }
    return h;
  }
  function edgeSheet(ph, e, modal) {
    const a = O[e.s], b = O[e.t], k = A.REL[e.kind], col = `var(--rel-${e.kind})`;
    return `<div class="sheet ${modal ? "" : "over-tabs"}" role="dialog" aria-label="Connection"><button class="grab" data-act="${modal ? "closeSheet" : "sheetToggle"}" aria-label="Close"></button><div class="sbody"><h2 style="font-size:22px;line-height:1.28"><span>${esc(a.title)}</span> <span style="font:600 14px var(--sans);color:${col};white-space:nowrap">${k.label}</span> <span>${esc(b.title)}</span></h2><div style="margin:16px 0 4px;display:flex;align-items:center;gap:14px">${A.relSwatch(e.kind, 56)}<span style="color:var(--ink-2);font-size:14px;line-height:1.45">${k.meaning}</span></div><dl style="display:grid;grid-template-columns:90px 1fr;gap:8px 12px;margin:14px 0 0;font-size:14px"><dt style="color:var(--ink-3)">Origin</dt><dd style="margin:0;display:flex;gap:8px;align-items:center">${originDot(e.origin)}${A.ORIGIN[e.origin]}</dd><dt style="color:var(--ink-3)">Direction</dt><dd style="margin:0">${k.sym ? "None. It reads the same both ways." : `From “${esc(a.title.slice(0, 28))}${a.title.length > 28 ? "…" : ""}”`}</dd><dt style="color:var(--ink-3)">Created</dt><dd style="margin:0">${when(e.ts)}</dd></dl>${e.origin === "model" ? `<p class="vnote" style="margin-top:14px">Arthur proposed this link and checked it twice before saving it. Nothing here changes your ideas.</p>` : ""}</div><div class="sbar" style="flex-direction:column"><div style="display:flex;gap:10px"><button class="pbtn" data-act="openIdea" data-id="${a.id}" style="min-width:0;overflow:hidden;text-overflow:ellipsis;display:block;padding:0 12px">Open “${esc(a.title.slice(0, 14))}…”</button><button class="pbtn" data-act="openIdea" data-id="${b.id}" style="min-width:0;overflow:hidden;text-overflow:ellipsis;display:block;padding:0 12px">Open “${esc(b.title.slice(0, 14))}…”</button></div></div></div>`;
  }

  /* ---------------- Evolution */
  const LW = 34, NODE_TOP = 17, NH = 26, Z = 30;
  function evolutionScreen(ph) {
    const s = ph.s, o = O[s.evoId], L = lineageOf(o.id), sel = s.evoSel && L.row[s.evoSel] != null ? s.evoSel : null;
    const railW = 22 + (L.lanes - 1) * LW + 24, X = (l) => 22 + l * LW;
    const lines = L.revs.map(() => []), curves = L.revs.map(() => []);
    L.revs.forEach((c) => c.parents.forEach((pid, pi) => {
      const ip = L.row[pid], ic = L.row[c.id], lp = L.lane[pid], lc = L.lane[c.id], isSel = sel && (sel === pid || sel === c.id), cls = (c.parents.length > 1 ? "m " : "") + (isSel ? "sel" : "");
      if (lp === lc) { lines[ip].push({ x: X(lp), t: NODE_TOP + NH, b: 0, cls }); for (let k = ip + 1; k < ic; k++) lines[k].push({ x: X(lp), t: 0, b: 0, cls }); lines[ic].push({ x: X(lc), t: 0, b: "node", cls }); }
      else if (pi === 0) { lines[ip].push({ x: X(lp), t: NODE_TOP + NH, b: Z, cls }); curves[ip].push({ from: X(lp), to: X(lc), pos: "bottom", cls }); for (let k = ip + 1; k < ic; k++) lines[k].push({ x: X(lc), t: 0, b: 0, cls }); lines[ic].push({ x: X(lc), t: 0, b: "node", cls }); }
      else { lines[ip].push({ x: X(lp), t: NODE_TOP + NH, b: 0, cls }); for (let k = ip + 1; k < ic; k++) lines[k].push({ x: X(lp), t: 0, b: 0, cls }); curves[ic].push({ from: X(lp), to: X(lc), pos: "top", cls }); }
    }));
    const sumTxt = `${L.revs.length} revisions${L.branches ? ` · ${L.branches} branch${L.branches > 1 ? "es" : ""}` : ""}${L.merges ? ` · ${L.merges} merge${L.merges > 1 ? "s" : ""}` : ""} · <b>${rl(L.cur)}</b> is current`;
    const rows = L.revs.map((r, i) => {
      const isCur = r.id === L.cur, isSel = sel === r.id, cap = caption(r);
      const ln = lines[i].map((l) => `<span class="vln ${l.cls}" style="left:${l.x}px;top:${l.t}px;${l.b === "node" ? `height:${NODE_TOP - l.t}px` : `bottom:${l.b}px`}"></span>`).join("");
      const cv = curves[i].map((c) => { const w = Math.abs(c.to - c.from), x0 = Math.min(c.from, c.to), sx = c.from < c.to ? 0 : w, ex = c.from < c.to ? w : 0; return c.pos === "bottom" ? `<svg class="vsvg" style="left:${x0}px;bottom:0;width:${w}px;height:${Z}px" viewBox="0 0 ${w} ${Z}"><path class="${c.cls}" d="M${sx} 0 C${sx} ${Z * .62},${ex} ${Z * .4},${ex} ${Z}"/></svg>` : `<svg class="vsvg" style="left:${x0}px;top:0;width:${w}px;height:${NODE_TOP}px" viewBox="0 0 ${w} ${NODE_TOP}"><path class="${c.cls}" d="M${sx} 0 C${sx} ${NODE_TOP * .6},${ex} ${NODE_TOP * .3},${ex} ${NODE_TOP}"/></svg>`; }).join("");
      const arrow = r.parents.length ? `<span class="varrow" style="left:${X(L.lane[r.id])}px"></span>` : "";
      const node = `<span class="vnode o-${r.origin}${r.origin === "merge" ? " merge" : ""}${isCur ? " cur" : ""}${isSel ? " sel" : ""}" style="left:${X(L.lane[r.id])}px">R${r.n}</span>`;
      return `<div class="vrow" style="--rail-w:${railW}px"><div class="vcell" style="position:absolute;left:0;top:0;bottom:0;width:${railW}px">${ln}${cv}${arrow}${node}</div><div style="grid-column:2;padding-left:2px;min-width:0"><button class="vhit" data-act="revSel" data-id="${r.id}" aria-expanded="${isSel}" aria-label="Revision R${r.n}, ${REVO[r.origin]}${isCur ? ", current" : ""}"><div class="l1">${REVO[r.origin]}${isCur ? `<span class="tag cur">Current</span>` : ""}</div><div class="l2">${cap} · ${ago(r.t)}${r.id === o.cur ? "" : ""}</div></button>${isSel ? revExpand(ph, r, L) : ""}</div></div>`;
    }).join("");
    return `<div class="scroll" data-k="evo">${head("Evolution", "")}<button class="evo-pick" data-act="pickIdea" aria-label="Choose an idea. Now: ${esc(o.title)}"><span class="t">${esc(o.title)}</span><span class="chev">${A.ic("chev")}</span></button><div class="evo-sum">${sumTxt}</div><div class="evo-help">Every edit keeps the old version. Branch to try another direction, merge to bring them back together.</div><div class="evo-acts"><button class="pbtn" data-act="revise" data-id="${o.id}">${A.ic("edit")}Revise</button><button class="pbtn" data-act="mergeOpen" data-id="${o.id}">${A.ic("merge")}Merge…</button></div><div class="vrail">${rows}</div></div>`;
  }
  function revExpand(ph, r, L) {
    const s = ph.s, parents = r.parents, cmpId = parents.includes(s.evoCmp) ? s.evoCmp : parents[0], p = cmpId && revId[cmpId];
    let cmp = "", body = "";
    if (parents.length > 1) cmp = `<div class="cmp">Compared with<span style="display:contents">${parents.map((pid) => `<button class="chip" aria-pressed="${pid === cmpId}" data-act="cmp" data-id="${pid}">${rl(pid)}</button>`).join("")}</span></div>`;
    else if (p) cmp = `<div class="cmp">Compared with <b style="color:var(--ink-2);font-weight:600">${rl(p.id)}</b></div>`;
    if (s.evoTab === "full" || !p) body = `<div class="diff" style="font-size:16.5px">${r.title !== (p && p.title) && p ? `<span class="dl">Title</span>${esc(r.title)}<span class="dl">Text</span>` : ""}${esc(r.body)}</div>${!p ? `<p class="vnote">This is the first version, so there is nothing earlier to compare with.</p>` : ""}`;
    else { const tt = diffSegs(p.title, r.title), bb = diffSegs(p.body, r.body); body = `<div class="diff" style="font-size:16.5px">${p.title !== r.title ? `<span class="dl">Title</span>${diffHtml(tt)}<span class="dl">Text</span>` : ""}${diffHtml(bb)}</div>`; }
    const capSrc = r.cap ? caps[r.cap] : null;
    const src = capSrc ? `<div class="facet" style="margin:16px 0 0;padding-top:12px"><div class="cap-meta2">${A.srcIc(capSrc.source)}<span>From a ${A.srcName(capSrc.source).toLowerCase()} capture · ${when(capSrc.t)}</span></div><blockquote class="quote" style="font-size:15px">${esc(capSrc.content.slice(r.ss, r.se))}</blockquote></div>` : `<p class="vnote">${r.origin === "merge" ? "Merged text is written by you. Arthur never says it came from a capture." : r.origin === "initial" ? "" : "This text is your edit, so it has no capture source."}</p>`;
    return `<div class="vexp">${cmp}<div class="dtabs" role="tablist"><button role="tab" data-act="dtab" data-id="changes" aria-selected="${s.evoTab !== "full" && !!p}" ${p ? "" : "disabled"}>Changes</button><button role="tab" data-act="dtab" data-id="full" aria-selected="${s.evoTab === "full" || !p}">Full text</button></div>${body}${src}<button class="pbtn sm" data-act="branch" data-id="${r.o}" data-from="${r.id}">${A.ic("branch")}Branch from R${r.n}</button></div>`;
  }

  function settingsScreen() {
    return `<div class="detail-top"><button class="iconbtn" data-act="back" aria-label="Back">${I("back")}</button><span class="sp"></span></div><div class="scroll" data-k="settings"><header class="mhead" style="padding-top:0"><div><h1>Settings</h1><p class="sub">About this installation</p></div></header>
    <section class="set-sec"><h3>Your knowledge</h3><p>Knowledge stored locally. Captures and everything Arthur organizes from them live on this device.</p></section>
    <section class="set-sec"><h3>Voice and organizing</h3><p>Speech is transcribed by a cloud speech service. The recording is deleted once it’s transcribed; only the text is kept.</p><p>Organizing and finding connections send the text of a capture or idea to a cloud model.</p></section>
    <section class="set-sec"><h3>About</h3><p class="serif" style="font-size:18px;color:var(--ink)">A.R.T.H.U.R. Cognitive Runtime</p><dl><dt>Client</dt><dd>mobile</dd><dt>Platform</dt><dd>android</dd><dt>App version</dt><dd>0.1.0</dd></dl></section></div>`;
  }

  /* ======================================================================= shell + render */
  const TABS = [["home", "Home"], ["ideas", "Ideas"], null, ["connections", "Connections"], ["evolution", "Evolution"]];
  function tabbar(ph) { return `<nav class="tabbar" aria-label="Primary">${TABS.map((t) => t ? `<button class="tab" data-act="tab" data-id="${t[0]}" ${ph.s.tab === t[0] && !ph.s.detail && !ph.s.settings ? 'aria-current="page"' : ""}>${A.ic(t[0])}<span>${t[1]}</span></button>` : `<button class="tab tab-cap" data-act="capTab" aria-label="Capture">${A.ic("mic")}<span>Capture</span></button>`).join("")}</nav>`; }
  const osTop = () => `<div class="os-status" aria-hidden="true"><span>19:25</span><span class="cut"></span><span class="ind"><svg width="14" height="10" viewBox="0 0 14 10" fill="currentColor"><path d="M1 8h2v2H1zM5 5h2v5H5zM9 2h2v8H9z"/></svg><span class="batt"></span></span></div>`;
  const osBot = () => `<div class="os-nav" aria-hidden="true"><span class="pill"></span><svg class="b3" viewBox="0 0 18 18"><path d="M12 3 5 9l7 6z"/></svg><svg class="b3" viewBox="0 0 18 18"><circle cx="9" cy="9" r="6"/></svg><svg class="b3" viewBox="0 0 18 18"><rect x="3" y="3" width="12" height="12" rx="2"/></svg></div>`;
  const kbHtml = () => { const row = (s) => `<div class="kr">${[...s].map((c) => `<span class="k">${c}</span>`).join("")}</div>`; return `<div class="kb" aria-hidden="true"><span class="tag">keyboard (Android, adjustResize)</span>${row("qwertyuiop")}${row("asdfghjkl")}${row("zxcvbnm")}<div class="kr"><span class="k" style="max-width:56px">?123</span><span class="k w"></span><span class="k" style="max-width:56px">⏎</span></div></div>`; };

  function render(ph) {
    const s = ph.s, root = ph.root, old = root.querySelector(".scroll[data-k]");
    if (old) s.scrolls[old.dataset.k] = old.scrollTop;
    root.dataset.size = s.dim === "s" ? "s" : s.dim === "l" ? "l" : "m"; root.dataset.nav = s.nav;
    root.style.width = ph.w + "px"; root.style.height = ph.h + "px";
    let body = "", pushed = false;
    if (s.settings) { body = `<div class="screen pushed slide-in">${settingsScreen()}</div>`; pushed = true; }
    else if (s.detail) { body = `<div class="screen pushed slide-in">${detailScreen(ph)}</div>`; pushed = true; }
    const main = s.tab === "home" ? homeScreen(ph) : s.tab === "ideas" ? ideasScreen(ph) : s.tab === "connections" ? connectionsScreen(ph) : evolutionScreen(ph);
    const typingKb = s.tab === "home" && s.typing && !s.detail && !s.settings;
    root.innerHTML = `${osTop()}<div class="viewport"><div class="screen">${main}${s.sheet || (s.sel && s.conMode === "map" && s.tab === "connections") ? sheetHtml(ph) : ""}${s.toast ? `<div class="toast" role="status">${A.ic("check")}${esc(s.toast)}</div>` : ""}</div>${typingKb ? kbHtml() : tabbar(ph)}${body}</div>${s.rec ? recOverlay(ph) : ""}${s.sys === "ask" ? sysDialog() : ""}${osBot()}`;
    // sheets that belong to detail/pushed screens must sit above them
    if (pushed && s.sheet) { const sh = root.querySelector(".viewport > .screen .sheet, .viewport > .screen .scrim"); const scr = root.querySelectorAll(".viewport > .screen > .sheet, .viewport > .screen > .scrim"); scr.forEach((n) => { n.style.zIndex = n.classList.contains("scrim") ? 55 : 60; }); }
    if (pushed && s.sheet) { const host = root.querySelector(".screen.pushed"); root.querySelectorAll(".viewport > .screen > .sheet, .viewport > .screen > .scrim").forEach((n) => host.appendChild(n)); }
    const sc = root.querySelector(".scroll[data-k]"); if (sc && s.scrolls[sc.dataset.k] != null) sc.scrollTop = s.scrolls[sc.dataset.k];
    if (s.tab === "connections" && s.conMode === "map" && !pushed) bindMap(ph);
    const af = root.querySelector("[data-autofocus]"); if (af) { af.focus({ preventScroll: true }); af.setSelectionRange(af.value.length, af.value.length); }
    if (s.typing && root.querySelector(".scroll[data-k=home]")) root.querySelector(".scroll[data-k=home]").scrollTop = 0;
  }

  /* ======================================================================= behaviour */
  const T = (ph, fn, ms) => { if (ph.s.freeze) return; const id = setTimeout(fn, ms); ph.timers.push(id); };
  const clear = (ph) => { ph.timers.forEach(clearTimeout); ph.timers = []; clearInterval(ph.tick); };
  function toast(ph, t) { ph.s.toast = t; render(ph); T(ph, () => { ph.s.toast = null; render(ph); }, 2600); }
  function speak(ph) {
    const s = ph.s; s.typing = false; s.alert = null;
    s.capHint = false;
    if (!s.micGranted) { if (s.micAsked) { s.alert = "denied"; s.tab = "home"; return render(ph); } s.sys = "ask"; return render(ph); }
    s.tab = "home"; s.detail = null; s.rec = { t: 0 }; render(ph);
    clearInterval(ph.tick); if (s.freeze) return;
    ph.tick = setInterval(() => { if (!s.rec) return clearInterval(ph.tick); s.rec.t++; const c = ph.root.querySelector(".clock"); if (c) { c.textContent = Math.floor(s.rec.t / 60) + ":" + String(s.rec.t % 60).padStart(2, "0"); } if (s.outcome === "interrupted" && s.rec.t >= 4) { s.rec = null; s.alert = "interrupted"; clearInterval(ph.tick); render(ph); } }, 1000);
  }
  function organize(ph, id) {
    const s = ph.s; s.org[id] = "organizing"; render(ph);
    T(ph, () => { s.org[id] = s.outcome === "orgfail" ? "failed" : "organized"; render(ph); }, 2000);
  }
  function captured(ph, kind, text) { const s = ph.s; s.org = {}; s.pend = { kind, text, phase: "saved" }; s.draft = ""; s.typing = false; render(ph); T(ph, () => { s.pend.phase = "organizing"; organize(ph, "NEW"); }, 1000); }
  const LEAVES = ["tab", "settings", "openIdea", "openMap", "openCon", "openEvo", "type", "speak", "capTab"];
  function act(ph, a, d) {
    const s = ph.s;
    if (s.alert === "sttretry" && LEAVES.includes(a)) s.alert = null; // leaving the retry flow deletes the temporary audio
    switch (a) {
      case "noop": return;
      case "tab": s.tab = d.id; s.detail = null; s.settings = false; s.sheet = null; s.typing = false; return render(ph);
      case "speak": return speak(ph);
      case "capTab": if (s.micGranted) return speak(ph); s.tab = "home"; s.detail = null; s.settings = false; s.sheet = null; s.typing = false; s.alert = null; s.capHint = true; return render(ph); // permission is requested only by an explicit Speak tap
      case "sys": s.sys = null; s.micAsked = true; if (d.v === "allow") { s.micGranted = true; if (s.outcome === "denied" || s.outcome === "firstuse") s.outcome = "success"; return speak(ph); } s.alert = "denied"; s.tab = "home"; return render(ph);
      case "retryStt": s.alert = null; s.xcribe = true; s.outcome = "success"; render(ph); return T(ph, () => { s.xcribe = false; captured(ph, "voice", NEW_TEXT); }, 1600);
      case "discardRec": s.alert = null; return render(ph);
      case "type": s.typing = true; s.alert = null; s.tab = "home"; s.detail = null; return render(ph);
      case "send": if (!s.draft.trim()) return; return captured(ph, "text", s.draft.trim());
      case "discard": s.rec = null; clearInterval(ph.tick); return render(ph);
      case "stop": s.rec = null; clearInterval(ph.tick); s.xcribe = true; render(ph);
        return T(ph, () => { s.xcribe = false; if (s.outcome === "sttfail") s.alert = "sttretry"; else if (s.outcome === "sttterminal") s.alert = "sttfail"; else if (s.outcome === "empty") s.alert = "empty"; else return captured(ph, "voice", NEW_TEXT); render(ph); }, 1600);
      case "dismissAlert": s.alert = null; return render(ph);
      case "retryOrg": return organize(ph, d.id);
      case "settings": s.settings = true; return render(ph);
      case "back": if (s.settings) s.settings = false; else s.detail = null; return render(ph);
      case "openIdea": if (!O[d.id]) return; s.detail = d.id; s.sheet = null; s.settings = false; s.focusId = d.id; return render(ph);
      case "kind": s.kind = d.id; return render(ph);
      case "openMap": s.detail = null; s.tab = "connections"; s.conMode = "map"; s.focusId = d.id; s.sel = { type: "node", id: d.id }; s.map = null; s.sheetOpen = false; render(ph); { const p = GL.pos[d.id]; centerOn(ph, p[0], p[1], 1.1); } return;
      case "openCon": s.detail = null; s.tab = "connections"; s.conMode = "list"; s.focusId = d.id; s.conOpen = { [d.id]: true }; render(ph); { const hb = ph.root.querySelector(`.hub-h[data-id="${d.id}"]`); if (hb) hb.scrollIntoView({ block: "start" }); } return;
      case "openEvo": s.detail = null; s.tab = "evolution"; if (evolving.find((o) => o.id === d.id)) { s.evoId = d.id; s.evoSel = null; } return render(ph);
      case "conMode": s.conMode = d.id; if (d.id === "map") { s.map = null; } s.sel = null; return render(ph);
      case "of": s.of = d.id; return render(ph);
      case "rf": s.rf.has(d.id) ? s.rf.delete(d.id) : s.rf.add(d.id); if (!s.rf.size) s.rf = new Set(Object.keys(A.REL)); return render(ph);
      case "hub": s.conOpen[d.id] = !(s.conOpen[d.id] ?? false); return render(ph);
      case "edge": if (s.conMode === "map" && s.tab === "connections" && !s.detail) return selectMap(ph, { type: "edge", id: d.id }); s.sheet = { type: "edge", id: d.id }; return render(ph);
      case "sheetToggle": if (s.sel && s.sel.type === "edge") { s.sel = null; return render(ph); } s.sheetOpen = !s.sheetOpen; return render(ph);
      case "closeSheet": s.sheet = null; return render(ph);
      case "zoom": { const sz = mapSize(ph), m = s.map, nk = Math.max(.4, Math.min(2.8, m.k * (d.id === "in" ? 1.3 : 1 / 1.3))), p = { x: sz.w / 2, y: sz.h / 2 }; m.x = p.x - ((p.x - m.x) * nk) / m.k; m.y = p.y - ((p.y - m.y) * nk) / m.k; m.k = nk; return applyMap(ph, true); }
      case "filters": s.sheet = { type: "filters" }; return render(ph);
      case "resetFilters": s.rf = new Set(Object.keys(A.REL)); s.of = "all"; return render(ph);
      case "find": s.sheet = { type: "find", id: d.id }; return render(ph);
      case "revise": s.sheet = { type: "revise", id: d.id, mode: "revise" }; return render(ph);
      case "branch": s.sheet = { type: "revise", id: d.id, mode: "branch", from: d.from }; return render(ph);
      case "saveRev": s.sheet = null; render(ph); return toast(ph, `${d.id === "Revise" ? "Saved" : d.id} as ${d.n}. Earlier revisions are unchanged.`);
      case "mergeOpen": { const L = lineageOf(d.id); s.sheet = { type: "merge", id: d.id, pick: L.revs.slice(-2).map((r) => r.id) }; return render(ph); }
      case "mergePick": { const p = s.sheet.pick, i = p.indexOf(d.id); i >= 0 ? p.splice(i, 1) : p.push(d.id); return render(ph); }
      case "pickIdea": s.sheet = { type: "pick" }; return render(ph);
      case "evoSet": s.evoId = d.id; s.evoSel = null; s.sheet = null; return render(ph);
      case "revSel": s.evoSel = s.evoSel === d.id ? null : d.id; s.evoCmp = null; s.evoTab = "changes"; render(ph); { const n = ph.root.querySelector('.vhit[aria-expanded="true"]'); if (n && !s.freeze) n.scrollIntoView({ block: "nearest", behavior: "smooth" }); } return;
      case "cmp": s.evoCmp = d.id; return render(ph);
      case "dtab": s.evoTab = d.id; return render(ph);
    }
  }

  /* ======================================================================= presets (used by ?s= and the playground) */
  const PRESETS = {
    home: (s) => {},
    "home-typing": (s) => { s.typing = true; s.draft = "Offline mode should show a small indicator so I know a thought is waiting"; },
    "home-recording": (s) => { s.rec = { t: 14 }; },
    "home-nopermission": (s) => { s.outcome = "firstuse"; s.micGranted = false; s.capHint = true; },
    "home-permission": (s) => { s.outcome = "firstuse"; s.micGranted = false; s.sys = "ask"; },
    "home-denied": (s) => { s.outcome = "denied"; s.micGranted = false; s.micAsked = true; s.alert = "denied"; },
    "home-transcribing": (s) => { s.xcribe = true; },
    "home-saved": (s) => { s.pend = { kind: "voice", text: NEW_TEXT, phase: "saved" }; },
    "home-organizing": (s) => { s.pend = { kind: "voice", text: NEW_TEXT, phase: "organizing" }; s.org.NEW = "organizing"; },
    "home-organized": (s) => { s.pend = { kind: "voice", text: NEW_TEXT, phase: "organized" }; s.org.NEW = "organized"; },
    "home-orgfail": (s) => { s.outcome = "orgfail"; s.pend = { kind: "voice", text: NEW_TEXT, phase: "organizing" }; s.org.NEW = "failed"; },
    "home-sttfail": (s) => { s.alert = "sttretry"; },
    "home-sttterminal": (s) => { s.outcome = "sttterminal"; s.alert = "sttfail"; },
    "home-interrupted": (s) => { s.alert = "interrupted"; },
    ideas: (s) => { s.tab = "ideas"; },
    "ideas-search": (s) => { s.tab = "ideas"; s.q = "бълг"; },
    "ideas-long": (s) => { s.tab = "ideas"; s.q = "provenance"; },
    idea: (s) => { s.tab = "ideas"; s.detail = byTitle("Arthur mobile app experience").id; },
    "idea-offline": (s) => { s.tab = "ideas"; s.detail = byTitle("Capture must work offline").id; },
    "idea-long": (s) => { s.tab = "ideas"; s.detail = objs.find((o) => o.title.length > 100).id; },
    "idea-cyrillic": (s) => { s.tab = "ideas"; s.detail = byTitle("Arthur трябва да разбира български").id; },
    "revise": (s) => { s.tab = "ideas"; s.detail = byTitle("Arthur mobile app experience").id; s.sheet = { type: "revise", id: s.detail, mode: "revise" }; },
    "connections-list": (s) => { s.tab = "connections"; s.conOpen = { [HUB.id]: true }; },
    "connections-map": (s) => { s.tab = "connections"; s.conMode = "map"; },
    "connections-node": (s) => { s.tab = "connections"; s.conMode = "map"; s.sel = { type: "node", id: HUB.id }; },
    "connections-node-open": (s) => { s.tab = "connections"; s.conMode = "map"; s.sel = { type: "node", id: HUB.id }; s.sheetOpen = true; },
    "connections-edge": (s) => { const e = rels.find((r) => r.kind === "contradicts" && r.origin === "model") || rels.find((r) => r.kind === "contradicts"); s.tab = "connections"; s.conMode = "map"; s.sel = { type: "edge", id: e.id }; s.focusId = e.s; },
    "connections-filtered": (s) => { s.tab = "connections"; s.rf = new Set(["contradicts", "supersedes"]); s.of = "arthur"; },
    evolution: (s) => { s.tab = "evolution"; },
    "evolution-rev": (s) => { const L = lineageOf(s.evoId); s.tab = "evolution"; s.evoSel = L.revs.find((r) => r.origin === "distillation")?.id || L.revs[1].id; },
    "evolution-merge": (s) => { const L = lineageOf(s.evoId), m = L.revs.find((r) => r.origin === "merge"); s.tab = "evolution"; s.evoSel = m.id; s.evoCmp = m.parents[1]; },
    "evolution-lanes": (s) => { const o = evolving.slice().sort((a, b) => lineageOf(b.id).lanes - lineageOf(a.id).lanes)[0]; s.tab = "evolution"; s.evoId = o.id; const m = lineageOf(o.id).revs.find((r) => r.parents.length > 1); s.evoSel = m ? m.id : null; },
    "evolution-merge-sheet": (s) => { const L = lineageOf(s.evoId); s.tab = "evolution"; s.sheet = { type: "merge", id: s.evoId, pick: L.revs.filter((r) => r.parents.length < 2).slice(-2).map((r) => r.id) }; },
    "evolution-pick": (s) => { s.tab = "evolution"; s.sheet = { type: "pick" }; },
    settings: (s) => { s.tab = "home"; s.settings = true; },
  };
  M.presets = Object.keys(PRESETS);
  const initMic = (s) => { s.micGranted = !["denied", "firstuse"].includes(s.outcome); s.micAsked = false; };
  M.lanesMax = Math.max(...evolving.map((o) => lineageOf(o.id).lanes));
  M.stats = { objects: objs.length, relations: rels.length, revisions: D.revisions.length, captures: D.captures.length, maxLinks: HUB.links, hubTitle: HUB.title, world: [GL.w, GL.h], evolving: evolving.length };

  M.mount = function (root, o = {}) {
    const ph = { root, w: o.w || 390, h: o.h || 844, s: BASE(), timers: [] };
    root.classList.add("phone"); ph.s.freeze = !!o.freeze;
    ph.s.dim = ph.w <= 364 ? "s" : ph.w >= 405 ? "l" : "m";
    if (o.nav) ph.s.nav = o.nav; if (o.cap) ph.s.cap = o.cap; if (o.outcome) ph.s.outcome = o.outcome; initMic(ph.s);
    if (o.preset && PRESETS[o.preset]) PRESETS[o.preset](ph.s);
    root.addEventListener("click", (e) => { const t = e.target.closest("[data-act]"); if (!t || t.closest(".mapsvg")) return; if (t.getAttribute("aria-disabled") === "true") return; act(ph, t.dataset.act, t.dataset); });
    root.addEventListener("input", (e) => { const t = e.target; if (t.matches("[data-q]")) { ph.s.q = t.value; const l = root.querySelector("#ideaList"); if (l) l.innerHTML = ideaList(ph.s); } if (t.matches("[data-draft]")) { ph.s.draft = t.value; const b = root.querySelector('[data-act="send"]'); if (b) { if (t.value.trim()) { b.removeAttribute("aria-disabled"); b.style.opacity = ""; } else { b.setAttribute("aria-disabled", "true"); b.style.opacity = ".4"; } } } });
    root.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.matches(".g-node,.g-edge")) { e.preventDefault(); const n = e.target; selectMap(ph, { type: "node", id: n.dataset.id }); } });
    const api = {
      ph, render: () => render(ph),
      set(k, v) { ph.s[k] = v; if (k === "outcome") initMic(ph.s); if (k === "cap" || k === "nav" || k === "outcome") render(ph); },
      resize(w, h, nav) { ph.w = w; ph.h = h; ph.s.dim = w <= 364 ? "s" : w >= 405 ? "l" : "m"; if (nav) ph.s.nav = nav; ph.s.map = null; render(ph); },
      preset(id) { clear(ph); const keep = { cap: ph.s.cap, nav: ph.s.nav, freeze: ph.s.freeze, dim: ph.s.dim, outcome: ph.s.outcome }; ph.s = { ...BASE(), ...keep }; initMic(ph.s); PRESETS[id](ph.s); render(ph); },
    };
    render(ph);
    return api;
  };
})();
