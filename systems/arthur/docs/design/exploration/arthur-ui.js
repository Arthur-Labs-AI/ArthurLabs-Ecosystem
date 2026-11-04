/* Arthur design exploration: sample data (shaped like packages/contracts), icons, graph + lineage renderers. */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const A = (window.Arthur = {});

  /* ---------------------------------------------------------------- data */
  A.captures = {
    c3: { id: "c3", source: "voice", at: "Sun 14:10", content: "Maybe the EMG wristband could start a capture so I do not even have to touch the phone. But then, how do we handle two ideas that conflict?" },
    c1: { id: "c1", source: "voice", at: "Fri 2 Oct, 14:32", content: "Okay, so the thing I keep coming back to is the phone. I want to be able to quickly capture ideas on my phone, ideally using voice. It should feel natural, almost like thinking out loud, and then Arthur helps me organize them later.", span: [89, 143] },
    c2: { id: "c2", source: "text", at: "Sat 3 Oct, 09:12", content: "Mobile capture has to work on the train. No connection, no problem: write it down now, organize it when we are back online.", span: [0, 122] },
  };
  // KnowledgeObject-shaped. `ago` and `src` are display helpers.
  A.objects = [
    { id: "o1",  kind: "idea",     title: "Arthur mobile app experience", body: "The mobile app should be voice-first and require almost no navigation from the user. Focus on quick capture, clean UI and seamless organization. It should feel like a natural extension of my thinking, not a traditional notes app.", ago: "18 min", src: "voice", cap: "c1", rev: 5, group: "Today" },
    { id: "o2",  kind: "task",     title: "Email Ignatov about demo setup", body: "Prepare the demo environment, send the latest build and check the presentation flow.", ago: "34 min", src: "text", rev: 1, group: "Today" },
    { id: "o3",  kind: "decision", title: "Use EMG wristband for capture intents", body: "The EMG wristband can be used as an alternative input method for starting and stopping capture, using one or two reliable gestures.", ago: "2 h", src: "voice", cap: "c3", rev: 4, group: "Today" },
    { id: "o4",  kind: "question", title: "How to handle conflicting ideas?", body: "We need a clear strategy for contradictions between ideas, including user review and possible merging or supersession.", ago: "2 h", src: "voice", cap: "c3", rev: 2, group: "Today" },
    { id: "o5",  kind: "note",     title: "Arthur architecture overview", body: "High-level architecture of the Arthur cognitive runtime, including capture, distillation, graph, lineage and recall.", ago: "5 h", src: "text", rev: 3, group: "Today" },
    { id: "o6",  kind: "idea",     title: "Improve graph visualization", body: "The knowledge graph should be more interactive, with clear relation types, filtering and a focused view around the selected node.", ago: "Yesterday", src: "text", rev: 2, group: "Yesterday" },
    { id: "o7",  kind: "idea",     title: "Voice-first capture flow", body: "One gesture starts listening. Release or tap again to stop. The transcript becomes a Capture, nothing else is required.", ago: "Yesterday", src: "voice", rev: 3, group: "Yesterday" },
    { id: "o8",  kind: "idea",     title: "Thought distillation pipeline", body: "Turn a raw Capture into structured ideas, each pointing at the exact text it came from.", ago: "Yesterday", src: "text", rev: 6, group: "Yesterday" },
    { id: "o9",  kind: "idea",     title: "Arthur UI redesign", body: "A more focused, calmer home that makes captured thinking feel connected instead of filed away.", ago: "Yesterday", src: "voice", rev: 3, group: "Yesterday" },
    { id: "o10", kind: "note",     title: "Mobile capture research notes", body: "Observations from using other capture apps on a phone: friction is almost always in the first three seconds.", ago: "2 d", src: "text", rev: 1, group: "Earlier" },
    { id: "o11", kind: "decision", title: "Single-page dashboard layout", body: "Keep everything on one page so nothing is more than a scroll away.", ago: "4 d", src: "text", rev: 2, group: "Earlier" },
    { id: "o12", kind: "question", title: "What happens when two ideas contradict?", body: "Does Arthur flag it, ask, or stay silent until the user explores?", ago: "4 d", src: "voice", rev: 1, group: "Earlier" },
  ];
  A.INV = { related_to: "related to", contradicts: "contradicts", duplicates: "duplicates", extends: "extended by", depends_on: "needed by", derived_from: "source of", supersedes: "superseded by" };
  A.rel = [
    { id: "r1",  kind: "depends_on",   s: "o1",  t: "o7",  origin: "user",   at: "2 d ago" },
    { id: "r2",  kind: "contradicts",  s: "o1",  t: "o3",  origin: "user",   at: "1 d ago" },
    { id: "r3",  kind: "derived_from", s: "o1",  t: "o10", origin: "model",  at: "1 d ago" },
    { id: "r4",  kind: "related_to",   s: "o1",  t: "o2",  origin: "model",  at: "today" },
    { id: "r5",  kind: "related_to",   s: "o1",  t: "o9",  origin: "model",  at: "1 d ago" },
    { id: "r6",  kind: "extends",      s: "o7",  t: "o8",  origin: "model",  at: "1 d ago" },
    { id: "r7",  kind: "related_to",   s: "o8",  t: "o5",  origin: "system", at: "1 d ago" },
    { id: "r8",  kind: "extends",      s: "o6",  t: "o9",  origin: "model",  at: "1 d ago" },
    { id: "r9",  kind: "supersedes",   s: "o9",  t: "o11", origin: "user",   at: "1 d ago" },
    { id: "r10", kind: "related_to",   s: "o2",  t: "o9",  origin: "model",  at: "today" },
    { id: "r11", kind: "duplicates",   s: "o4",  t: "o12", origin: "model",  at: "3 h ago" },
    { id: "r12", kind: "related_to",   s: "o4",  t: "o5",  origin: "model",  at: "3 h ago" },
    { id: "r13", kind: "related_to",   s: "o10", t: "o7",  origin: "model",  at: "1 d ago" },
    { id: "r14", kind: "related_to",   s: "o5",  t: "o10", origin: "system", at: "2 d ago" },
  ];
  A.pos = { o1: [520, 322], o7: [330, 232], o8: [175, 132], o5: [130, 350], o10: [320, 462], o3: [700, 168], o9: [770, 332], o2: [660, 492], o6: [915, 236], o11: [905, 452], o4: [120, 540], o12: [300, 592] };
  A.regions = [
    { x: 80, y: 70, t: "Capture & cognition" }, { x: 700, y: 92, t: "Conflicts" }, { x: 770, y: 560, t: "Interface" }, { x: 40, y: 636, t: "Open questions" },
  ];
  A.REL = {
    related_to:   { label: "related to",   sym: true,  meaning: "A general semantic link. No direction." },
    extends:      { label: "extends",      sym: false, meaning: "The first develops or adds detail to the second." },
    depends_on:   { label: "depends on",   sym: false, meaning: "The first needs the second to work, be valid or make sense." },
    contradicts:  { label: "contradicts",  sym: true,  meaning: "The two materially conflict. No direction." },
    derived_from: { label: "derived from", sym: false, meaning: "The first was derived from the knowledge in the second." },
    duplicates:   { label: "duplicates",   sym: true,  meaning: "The two say effectively the same thing. No direction." },
    supersedes:   { label: "supersedes",   sym: false, meaning: "The first replaces the second as the current knowledge." },
  };
  A.ORIGIN = { model: "Proposed by Arthur", user: "Created by you", system: "Created by Arthur" };
  A.obj = (id) => A.objects.find((o) => o.id === id);
  A.deg = (id) => A.rel.filter((r) => r.s === id || r.t === id).length;
  A.edgesOf = (id) => A.rel.filter((r) => r.s === id || r.t === id);

  // Lineage of o1 (ThoughtRevision-shaped). col/lane are layout only.
  A.revs = [
    { id: "R1", origin: "initial",      parents: [],           title: "The mobile app experience", body: "The mobile app should be voice-first. Capture a thought in one gesture, then let Arthur organize it.", at: "Fri 14:32", ago: "2 d", col: 0, lane: 0, prov: { cap: "c1" } },
    { id: "R2", origin: "user_edit",    parents: ["R1"],       title: "The mobile app experience", body: "The mobile app should be voice-first and require almost no navigation. Capture a thought in one gesture, then let Arthur organize it.", at: "Sat 10:05", ago: "1 d", col: 1, lane: 0 },
    { id: "R3", origin: "distillation", parents: ["R1"],       title: "The mobile app experience", body: "The mobile app should be voice-first. Capture a thought in one gesture, then let Arthur organize it. Capture must work without a connection.", at: "Sat 09:12", ago: "1 d", col: 2, lane: 1, prov: { cap: "c2" } },
    { id: "R4", origin: "merge",        parents: ["R2", "R3"], title: "The mobile app experience", body: "The mobile app should be voice-first and require almost no navigation. Capture a thought in one gesture, then let Arthur organize it. Capture must work without a connection.", at: "Sun 16:20", ago: "2 h", col: 3, lane: 0 },
    { id: "R5", origin: "user_edit",    parents: ["R4"],       title: "Arthur mobile app experience", body: "The mobile app should be voice-first and require almost no navigation. Capture a thought in one gesture, then let Arthur organize it. Capture must work without a connection. It should feel like a natural extension of my thinking, not a traditional notes app.", at: "Sun 18:04", ago: "18 min", col: 4, lane: 0, current: true },
  ];
  A.ORIGIN_REV = { initial: "First capture", user_edit: "Your edit", distillation: "From a new capture", merge: "Merge", system: "System" };
  A.evolving = [
    { id: "o1", title: "Arthur mobile app experience", n: 5, ago: "18 min", shape: "merge" },
    { id: "o8", title: "Thought distillation pipeline", n: 6, ago: "1 d", shape: "linear" },
    { id: "o3", title: "Use EMG wristband for capture intents", n: 4, ago: "2 h", shape: "branch" },
  ];

  /* --------------------------------------------------------------- icons */
  const P = {
    home: '<path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
    ideas: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
    connections: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="10" cy="18" r="2"/><path d="m8 6.4 8 1.2M7.2 7.8l2.1 8.2M16.6 9.6l-5.2 6.8"/>',
    evolution: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 5-11 9"/>',
    settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    ask: '<path d="M5 6h14v9H11l-4 3v-3H5z"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    text: '<path d="M4 7h16M4 12h16M4 17h10"/>',
    emg: '<path d="M4 12h3l2-5 3 10 2-5h6"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    link: '<circle cx="6" cy="12" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 11.2l8-4M8 12.8l8 4"/>',
    rev: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-5 4-10 6"/>',
    paperclip: '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7"/>',
    spark: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10M16 12H11a5 5 0 0 0-5 5"/>',
    merge: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="14" r="2"/><path d="M6 7v10M6 9c0 4 4 5 10 5"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    graph: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="10" cy="18" r="2"/><path d="m8 6.4 8 1.2M7.2 7.8l2.1 8.2"/>',
    wand: '<path d="m5 19 9-9M14 6l1-2 1 2 2 1-2 1-1 2-1-2-2-1z"/>',
    cmd: '<path d="M9 9V6a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v12a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2z"/>',
    warn: '<path d="M12 4 3 20h18zM12 10v4M12 17h.01"/>',
    check: '<path d="m5 12 4 4 10-10"/>',
  };
  A.ic = (n, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[n]}</svg>`;
  const K = {
    idea: '<circle cx="8" cy="8" r="4.6"/>',
    task: '<rect x="3.4" y="3.4" width="9.2" height="9.2" rx="2.2"/>',
    decision: '<path d="M8 2.4 13.6 8 8 13.6 2.4 8z"/>',
    question: '<path d="M8 2.2l4.8 2.8v6L8 13.8 3.2 11V5z"/>',
    note: '<path d="M4.2 3.4h7.6a.8.8 0 0 1 .8.8v7.6a.8.8 0 0 1-.8.8H4.2a.8.8 0 0 1-.8-.8V4.2a.8.8 0 0 1 .8-.8zM5.6 6.6h4.8M5.6 9.4h3"/>',
  };
  A.kind = (k, extra = "") => `<svg class="kind ${extra}" data-kind="${k}" viewBox="0 0 16 16" aria-label="${k}">${K[k]}</svg>`;
  A.srcIc = (s) => A.ic(s === "voice" ? "mic" : s === "emg" ? "emg" : "text", "sm");
  A.srcName = (s) => (s === "voice" ? "Voice" : s === "emg" ? "Wristband" : "Typed");
  A.mark = (sz = 26) => `<svg width="${sz}" height="${sz}" viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="M5 23 14 6l9 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.6 16.2h8.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".38"/><circle cx="14" cy="6" r="3.1" fill="var(--accent)"/></svg>`;

  /* ------------------------------------------------------- relation art */
  // Edge geometry encodes the kind. Colour only reinforces it.
  A.relStyle = {
    related_to:   { w: 1.3, dash: "", arrow: null },
    extends:      { w: 1.6, dash: "", arrow: "chev" },
    depends_on:   { w: 1.6, dash: "7 5", arrow: "tri" },
    derived_from: { w: 1.7, dash: "1.5 5", cap: "round", arrow: "hollow" },
    contradicts:  { w: 1.8, dash: "", arrow: "bars" },
    duplicates:   { w: 4.2, dash: "", arrow: null, double: true },
    supersedes:   { w: 1.7, dash: "", arrow: "barTri" },
  };
  A.markerDefs = () => {
    const kinds = Object.keys(A.relStyle);
    return kinds.map((k) => {
      const c = `var(--rel-${k})`; const a = A.relStyle[k].arrow; if (!a) return "";
      const m = (id, inner, w = 12, rx = 9, start = false) => `<marker id="m-${k}${id}" viewBox="0 0 12 12" refX="${rx}" refY="6" markerWidth="${w}" markerHeight="12" markerUnits="userSpaceOnUse" orient="${start ? "auto-start-reverse" : "auto"}">${inner}</marker>`;
      if (a === "chev") return m("", `<path d="M2 1.5 9 6 2 10.5" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`);
      if (a === "tri") return m("", `<path d="M1 1.5 10 6 1 10.5z" fill="${c}"/>`);
      if (a === "hollow") return m("", `<path d="M1.5 2 9.5 6 1.5 10z" fill="var(--ground)" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"/>`);
      if (a === "barTri") return m("", `<path d="M1 1.5 8.5 6 1 10.5z" fill="${c}"/><path d="M11 1.5v9" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>`, 12, 11);
      if (a === "bars") return m("", `<path d="M7 1v10" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`, 12, 7, true);
      return "";
    }).join("");
  };
  /** A 30x12 swatch drawn with exactly the geometry the graph uses (for legends and inspectors). */
  A.relSwatch = (k, w = 34) => {
    const st = A.relStyle[k]; const c = `var(--rel-${k})`;
    const body = st.double
      ? `<path d="M1 6H${w - 1}" stroke="${c}" stroke-width="4.2"/><path d="M1 6H${w - 1}" stroke="var(--ground)" stroke-width="1.6"/>`
      : `<path d="M1 6H${w - (st.arrow ? 9 : 1)}" stroke="${c}" stroke-width="${st.w}" stroke-dasharray="${st.dash}" stroke-linecap="${st.cap || "butt"}" fill="none"/>`;
    let end = "";
    const e = w - 2;
    if (st.arrow === "chev") end = `<path d="M${e - 6} 2 ${e} 6 ${e - 6} 10" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (st.arrow === "tri") end = `<path d="M${e - 8} 2 ${e} 6 ${e - 8} 10z" fill="${c}"/>`;
    if (st.arrow === "hollow") end = `<path d="M${e - 8} 2.5 ${e} 6 ${e - 8} 9.5z" fill="var(--ground)" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"/>`;
    if (st.arrow === "barTri") end = `<path d="M${e - 8} 2 ${e - 2} 6 ${e - 8} 10z" fill="${c}"/><path d="M${e + .5} 2v8" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>`;
    const start = st.arrow === "bars" ? `<path d="M1.5 1.5v9" stroke="${c}" stroke-width="2" stroke-linecap="round"/><path d="M${w - 1.5} 1.5v9" stroke="${c}" stroke-width="2" stroke-linecap="round"/>` : "";
    const line = st.arrow === "bars" ? `<path d="M2 6H${w - 2}" stroke="${c}" stroke-width="${st.w}"/>` : body;
    return `<svg class="relsw" viewBox="0 0 ${w} 12" width="${w}" height="12" aria-hidden="true">${line}${end}${start}</svg>`;
  };

  /* --------------------------------------------------------- graph view */
  function el(n, attrs = {}, html = "") { const e = document.createElementNS(NS, n); for (const k in attrs) e.setAttribute(k, attrs[k]); if (html) e.innerHTML = html; return e; }
  function nodeShape(kind, r) {
    const s = r * 1.02;
    switch (kind) {
      case "task": return `<rect x="${-s}" y="${-s}" width="${2 * s}" height="${2 * s}" rx="${s * .34}"/>`;
      case "decision": { const d = s * 1.3; return `<path d="M0 ${-d} ${d} 0 0 ${d} ${-d} 0z" stroke-linejoin="round"/>`; }
      case "question": { const h = s * 1.12; const p = [0, 1, 2, 3, 4, 5].map((i) => { const a = Math.PI / 6 + (i * Math.PI) / 3 - Math.PI / 2; return [Math.cos(a) * h, Math.sin(a) * h]; }); return `<path d="M${p.map((q) => q.join(" ")).join("L")}z" stroke-linejoin="round"/>`; }
      case "note": return `<rect x="${-s * .86}" y="${-s}" width="${s * 1.72}" height="${2 * s}" rx="${s * .22}"/><path d="M${-s * .45} ${-s * .2}H${s * .45}M${-s * .45} ${s * .32}H${s * .1}" fill="none"/>`;
      default: return `<circle r="${s * 1.05}"/>`;
    }
  }
  const wrap = (t, n) => { const w = t.split(" "), L = [""]; w.forEach((x) => { if ((L[L.length - 1] + " " + x).trim().length > n && L[L.length - 1]) L.push(x); else L[L.length - 1] = (L[L.length - 1] + " " + x).trim(); }); return L.slice(0, 3); };

  /**
   * opts: { objects, rel, pos, selected:{type,id}|null, enabled:Set<kind>, mini, onSelect, labels:'all'|'focus'|'none', regions }
   */
  A.renderGraph = (svg, opts) => {
    const { objects = A.objects, rel = A.rel, pos = A.pos, selected = null, enabled = null, mini = false, onSelect = null, labels = "all", regions = false, bounds = [1000, 640] } = opts;
    const vb = bounds.length === 4 ? bounds : [0, 0, bounds[0], bounds[1]];
    svg.setAttribute("viewBox", vb.join(" "));
    svg.innerHTML = `<defs>${A.markerDefs()}</defs>`;
    const ids = new Set(objects.map((o) => o.id));
    const edges = rel.filter((r) => ids.has(r.s) && ids.has(r.t) && (!enabled || enabled.has(r.kind)));
    const R = (id) => (mini ? 7.5 + Math.min(A.deg(id), 6) * 1.1 : 12 + Math.min(A.deg(id), 7) * 2.1);
    // focus set
    let focusN = null, focusE = null;
    if (selected) {
      focusN = new Set(); focusE = new Set();
      if (selected.type === "node") { focusN.add(selected.id); edges.forEach((e) => { if (e.s === selected.id || e.t === selected.id) { focusN.add(e.s); focusN.add(e.t); focusE.add(e.id); } }); }
      else { const e = rel.find((x) => x.id === selected.id); if (e) { focusN.add(e.s); focusN.add(e.t); focusE.add(e.id); } }
    }
    if (regions) A.regions.forEach((g) => svg.appendChild(el("text", { x: g.x, y: g.y, class: "g-region" }, g.t)));
    const gE = el("g"); const gL = el("g"); const gN = el("g"); svg.append(gE, gN, gL);
    edges.forEach((e, i) => {
      const [x1, y1] = pos[e.s], [x2, y2] = pos[e.t];
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const st = A.relStyle[e.kind], rs = R(e.s) + 4, rt = R(e.t) + (st.arrow ? 9 : 4);
      const sx = x1 + ux * rs, sy = y1 + uy * rs, tx = x2 - ux * rt, ty = y2 - uy * rt;
      const bend = (i % 2 ? 1 : -1) * Math.min(38, len * 0.1);
      const cx = (sx + tx) / 2 - uy * bend, cy = (sy + ty) / 2 + ux * bend;
      const d = `M${sx.toFixed(1)} ${sy.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`;
      const dim = focusE && !focusE.has(e.id), isSel = selected && selected.type === "edge" && selected.id === e.id;
      const g = el("g", { class: "g-edge" + (dim ? " dim" : "") + (isSel ? " sel" : ""), "data-id": e.id });
      const col = `var(--rel-${e.kind})`;
      if (isSel) g.appendChild(el("path", { d, fill: "none", stroke: col, "stroke-width": 10, opacity: .18, "stroke-linecap": "round" }));
      g.appendChild(el("path", { d, fill: "none", stroke: col, "stroke-width": st.w * (isSel ? 1.25 : 1), "stroke-dasharray": st.dash, "stroke-linecap": st.cap || "butt", "marker-end": st.arrow && st.arrow !== "bars" ? `url(#m-${e.kind})` : null, ...(st.arrow === "bars" ? { "marker-end": `url(#m-${e.kind})`, "marker-start": `url(#m-${e.kind})` } : {}) }));
      if (st.double) g.appendChild(el("path", { d, fill: "none", stroke: "var(--ground)", "stroke-width": 1.7 }));
      if (!mini) { const hit = el("path", { d, fill: "none", stroke: "transparent", "stroke-width": 16, style: "cursor:pointer" }); hit.addEventListener("click", (ev) => { ev.stopPropagation(); onSelect && onSelect({ type: "edge", id: e.id }); }); g.appendChild(hit); }
      gE.appendChild(g);
      // edge label only when it is part of the current focus
      if (!mini && focusE && focusE.has(e.id)) {
        const lbl = A.REL[e.kind].label; const wv = lbl.length * 7 + 16;
        const lg = el("g", { transform: `translate(${(sx + 2 * cx + tx) / 4},${(sy + 2 * cy + ty) / 4})`, class: "g-elabel" });
        lg.append(el("rect", { x: -wv / 2, y: -10, width: wv, height: 20, rx: 4, fill: "var(--overlay)", stroke: col, "stroke-opacity": .6 }), el("text", { "text-anchor": "middle", y: 4.5, fill: col }, lbl));
        gL.appendChild(lg);
      }
    });
    objects.forEach((o) => {
      const p = pos[o.id]; if (!p) return; const r = R(o.id);
      const isSel = selected && selected.type === "node" && selected.id === o.id; const dim = focusN && !focusN.has(o.id);
      const g = el("g", { class: "g-node" + (isSel ? " sel" : "") + (dim ? " dim" : ""), transform: `translate(${p[0]},${p[1]})`, tabindex: mini ? null : 0, role: mini ? null : "button", "aria-label": mini ? null : `${o.kind}: ${o.title}` });
      if (isSel) g.appendChild(el("circle", { r: r + 11, fill: "var(--accent)", opacity: .13 }));
      const shape = el("g", { class: "shape" }, nodeShape(o.kind, r)); g.appendChild(shape);
      const showLbl = labels === "all" || (labels === "focus" && (isSel || (focusN && focusN.has(o.id)) || A.deg(o.id) >= 4));
      if (showLbl && !mini) {
        const lines = wrap(o.title, 20); const t = el("text", { class: "g-label" + (isSel ? " sel" : ""), "text-anchor": "middle", y: r + 21 });
        lines.forEach((ln, i) => t.appendChild(el("tspan", { x: 0, dy: i ? 17 : 0 }, ln))); g.appendChild(t);
      } else if (mini && (o.id === "o1" || A.deg(o.id) >= 2 || true)) {
        g.appendChild(el("text", { class: "g-label mini", "text-anchor": "middle", y: r + 14 }, o.title.length > 17 ? o.title.slice(0, 16) + "…" : o.title));
      }
      if (!mini) {
        g.addEventListener("click", (ev) => { ev.stopPropagation(); onSelect && onSelect({ type: "node", id: o.id }); });
        g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onSelect && onSelect({ type: "node", id: o.id }); } });
      }
      gN.appendChild(g);
    });
  };
  A.graphCss = `
    .g-region{ font:italic 400 15px var(--serif); fill:var(--ink-4); letter-spacing:.01em; }
    .g-node{ cursor:pointer; transition:opacity var(--t-med) var(--ease); outline:none; }
    .g-node .shape *{ fill:var(--ground); stroke:var(--ink-2); stroke-width:1.5; transition:stroke var(--t-fast), fill var(--t-fast); }
    .g-node .shape path[fill=none]{ fill:none; }
    .g-node:hover .shape *{ stroke:var(--ink); }
    .g-node.sel .shape *{ stroke:var(--accent); stroke-width:2; fill:var(--accent-soft); }
    .g-node:focus-visible .shape *{ stroke:var(--accent); stroke-width:2.2; }
    .g-node.dim,.g-edge.dim{ opacity:.34; }
    .g-edge{ transition:opacity var(--t-med) var(--ease); }
    .g-label{ font:450 15.5px var(--serif); fill:var(--ink-2); paint-order:stroke; stroke:var(--ground); stroke-width:4px; stroke-linejoin:round; pointer-events:none; }
    .g-label.sel{ fill:var(--ink); font-weight:550; }
    .g-label.mini{ font-size:11.5px; }
    .g-elabel text{ font:500 12.5px var(--sans); }
    [data-kindtint="on"] .g-node .shape *{ stroke:var(--ink-2); }
  `;

  /* ------------------------------------------------------------ lineage */
  // word diff (LCS): deterministic, same input -> same output
  A.wordDiff = (a, b) => {
    const t = (s) => s.split(/(\s+)/).filter((x) => x.length);
    const x = t(a), y = t(b); const n = x.length, m = y.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = []; const push = (k, s) => { const l = out[out.length - 1]; if (l && l.k === k) l.s += s; else out.push({ k, s }); };
    let i = 0, j = 0;
    while (i < n && j < m) { if (x[i] === y[j]) { push("eq", x[i]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) { push("del", x[i++]); } else { push("ins", y[j++]); } }
    while (i < n) push("del", x[i++]); while (j < m) push("ins", y[j++]);
    return out;
  };
  A.diffHtml = (segs) => segs.map((g) => (g.k === "eq" ? g.s : g.k === "ins" ? `<ins>${g.s}</ins>` : `<del>${g.s}</del>`)).join("");
  A.rev = (id) => A.revs.find((r) => r.id === id);
  A.revStat = (id, parentId) => {
    const r = A.rev(id), p = parentId ? A.rev(parentId) : null; if (!p) return { add: r.body.split(/\s+/).length, del: 0 };
    const d = A.wordDiff(p.body, r.body); const c = (k) => d.filter((s) => s.k === k).reduce((n, s) => n + s.s.split(/\s+/).filter(Boolean).length, 0);
    return { add: c("ins"), del: c("del"), title: p.title !== r.title };
  };
  A.revCaption = (r) => {
    if (r.origin === "initial") return "First captured";
    if (r.origin === "merge") return `Merged ${r.parents.join(" + ")}`;
    const s = A.revStat(r.id, r.parents[0]);
    return `+${s.add} −${s.del} words${s.title ? " · title" : ""}`;
  };
  A.laneY = [76, 176];
  A.colX = (c, w) => 80 + c * ((w - 170) / 4);

  /** Structured, left-to-right rail: lanes + git-style orthogonal joins. */
  A.renderLineage = (svg, opts) => {
    const { revs = A.revs, selected, onSelect, w = 900, h = 270, mini = false } = opts;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const X = (c) => A.colX(c, w), Y = (l) => A.laneY[l] + 26;
    const NW = 54, NH = 32;
    let out = `<defs><marker id="la" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1.5 8.5 5 1 8.5z" fill="var(--ink-3)"/></marker></defs>`;
    // lane rails + labels
    out += `<g class="l-lane"><line x1="24" x2="${w - 24}" y1="${Y(0)}" y2="${Y(0)}"/><line x1="24" x2="${w - 24}" y1="${Y(1)}" y2="${Y(1)}"/></g>`;
    // edges
    const rr = 14;
    revs.forEach((r) => r.parents.forEach((pid) => {
      const p = A.rev(pid); const x1 = X(p.col) + NW / 2, y1 = Y(p.lane), x2 = X(r.col) - NW / 2, y2 = Y(r.lane);
      let d; const sel = selected && (selected === r.id || selected === pid);
      if (y1 === y2) d = `M${x1} ${y1}H${x2 - 1}`;
      else if (y2 > y1) d = `M${x1} ${y1}H${x1 + 10}Q${x1 + 10 + rr} ${y1} ${x1 + 10 + rr} ${y1 + rr}V${y2 - rr}Q${x1 + 10 + rr} ${y2} ${x1 + 10 + rr * 2} ${y2}H${x2 - 1}`;
      else d = `M${x1} ${y1}H${x2 - 10 - rr * 2}Q${x2 - 10 - rr} ${y1} ${x2 - 10 - rr} ${y1 - rr}V${y2 + rr}Q${x2 - 10 - rr} ${y2} ${x2 - 10} ${y2}H${x2 - 1}`;
      const merge = r.parents.length > 1;
      out += `<path d="${d}" class="l-edge${sel ? " sel" : ""}${merge ? " merge" : ""}" marker-end="url(#la)"/>`;
    }));
    revs.forEach((r) => {
      const x = X(r.col), y = Y(r.lane); const cur = r.current, sel = selected === r.id;
      const tag = { initial: "capture", user_edit: "edit", distillation: "from capture", merge: "merge", system: "system" }[r.origin];
      out += `<g class="l-node${cur ? " cur" : ""}${sel ? " sel" : ""} o-${r.origin}" data-id="${r.id}" tabindex="0" role="button" aria-label="Revision ${r.id}${cur ? ", current" : ""}" transform="translate(${x},${y})">`;
      if (sel) out += `<rect x="${-NW / 2 - 5}" y="${-NH / 2 - 5}" width="${NW + 10}" height="${NH + 10}" rx="9" class="l-halo"/>`;
      out += `<rect x="${-NW / 2}" y="${-NH / 2}" width="${NW}" height="${NH}" rx="7" class="l-box"/>`;
      if (r.origin === "merge") out += `<path d="M${-NW / 2 + 5} ${NH / 2 - 5}h${NW - 10}" class="l-mergebar"/>`;
      out += `<text class="l-id" y="4.5" text-anchor="middle">${r.id}</text>`;
      if (!mini) {
        out += `<text class="l-tag" y="${-NH / 2 - 9}" text-anchor="middle">${cur ? "current" : tag}</text>`;
        out += `<text class="l-cap" y="${NH / 2 + 18}" text-anchor="middle">${A.revCaption(r)}</text><text class="l-when" y="${NH / 2 + 34}" text-anchor="middle">${r.at}</text>`;
      }
      out += `</g>`;
    });
    svg.innerHTML = out;
    svg.querySelectorAll(".l-node").forEach((n) => {
      const go = () => onSelect && onSelect(n.dataset.id);
      n.addEventListener("click", go); n.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  };
  A.lineageCss = `
    .l-lane line{ stroke:var(--line-soft); stroke-width:1; stroke-dasharray:2 6; }
    .l-lanelabel{ font:italic 400 13px var(--serif); fill:var(--ink-4); }
    .l-edge{ fill:none; stroke:var(--ink-4); stroke-width:1.6; transition:stroke var(--t-fast); }
    .l-edge.merge{ stroke:var(--ink-3); }
    .l-edge.sel{ stroke:var(--accent); }
    .l-node{ cursor:pointer; outline:none; }
    .l-box{ fill:var(--ground); stroke:var(--ink-3); stroke-width:1.4; transition:all var(--t-fast); }
    .l-node:hover .l-box{ stroke:var(--ink); }
    .l-node.o-initial .l-box{ stroke-dasharray:0; }
    .l-node.o-distillation .l-box{ stroke:var(--pencil); }
    .l-mergebar{ stroke:var(--ink-2); stroke-width:1.6; stroke-linecap:round; }
    .l-node.cur .l-box{ fill:var(--accent); stroke:var(--accent); }
    .l-node.cur .l-id{ fill:var(--accent-ink); }
    .l-node.cur .l-mergebar{ stroke:var(--accent-ink); }
    .l-node.sel .l-box{ stroke:var(--ink); stroke-width:1.8; }
    .l-node.cur.sel .l-box{ stroke:var(--ink); }
    .l-halo{ fill:none; stroke:var(--accent); stroke-opacity:.45; stroke-width:1; }
    .l-node:focus-visible .l-halo,.l-node:focus-visible .l-box{ stroke:var(--accent); stroke-width:2.2; }
    .l-id{ font:650 14px var(--sans); fill:var(--ink); }
    .l-tag{ font:500 12.5px var(--sans); fill:var(--ink-3); }
    .l-node.cur .l-tag{ fill:var(--accent); }
    .l-cap{ font:450 13px var(--sans); fill:var(--ink-2); }
    .l-when{ font:400 12px var(--sans); fill:var(--ink-3); }
  `;

  /* a tiny rail used in rows (Home › Recently evolving) */
  A.sparkRail = (shape, n) => {
    const nodes = shape === "linear" ? [[8, 10], [30, 10], [52, 10], [74, 10], [96, 10]] : shape === "branch" ? [[8, 8], [34, 8], [60, 8], [60, 20], [90, 8]] : [[8, 8], [32, 8], [32, 20], [60, 8], [84, 8]];
    const E = shape === "linear" ? [[0, 1], [1, 2], [2, 3], [3, 4]] : shape === "branch" ? [[0, 1], [1, 2], [1, 3], [2, 4]] : [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4]];
    const last = nodes.length - 1;
    return `<svg width="104" height="28" viewBox="0 0 104 28" aria-hidden="true">${E.map(([a, b]) => `<path d="M${nodes[a][0]} ${nodes[a][1]}L${nodes[b][0]} ${nodes[b][1]}" stroke="var(--ink-4)" stroke-width="1.4" fill="none"/>`).join("")}${nodes.map((p, i) => `<rect x="${p[0] - 4.5}" y="${p[1] - 4.5}" width="9" height="9" rx="2.5" fill="${i === last ? "var(--accent)" : "var(--ground)"}" stroke="${i === last ? "var(--accent)" : "var(--ink-3)"}" stroke-width="1.3"/>`).join("")}</svg>`;
  };

  /* shared shell */
  A.rail = (active, opts = {}) => `
    <aside class="rail" aria-label="Primary">
      <div class="brand">${A.mark()}<b>Arthur</b></div>
      <button class="capture-btn">${A.ic("plus")}Capture<kbd>⌘N</kbd></button>
      <nav class="nav">
        ${[["home", "Home"], ["ideas", "Ideas", opts.ideas ?? 12], ["connections", "Connections"], ["evolution", "Evolution"]].map(([k, l, c]) => `<a href="#${k}" ${active === k ? 'aria-current="page"' : ""}>${A.ic(k)}${l}${c ? `<span class="count">${c}</span>` : ""}</a>`).join("")}
        <a href="#ask" style="color:var(--ink-4)" title="Not built yet">${A.ic("ask")}Ask Arthur<span class="soon">soon</span></a>
      </nav>
      <div style="flex:1"></div>
      <nav class="nav"><a href="#settings" ${active === "settings" ? 'aria-current="page"' : ""}>${A.ic("settings")}Settings</a></nav>
      <div class="rail-foot"><b><i class="dot"></i>Ready</b><span>Stored on this device</span></div>
    </aside>`;
})();
