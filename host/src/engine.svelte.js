// the host engine - stream machine, render modes, and the conversation TREE.
// nodes are pages, edges are what triggered them (typed prompt or ui event).
// event edges are memoized: re-clicking the same thing re-renders the cached child, no model call.

const params = new URLSearchParams(location.search);
export const MODE = params.get("mode") || "iframe";   // iframe | raw | raw-bare
export const LIBS = params.get("libs") || "open";

const MARKER = "<!--SHELL-END-->";
const SHELL_LIMIT = 8192;
const SHELL_TIMEOUT = 8000;
const TAIL = 12;
const ACTION_DEBOUNCE = 300;
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' data: https://unpkg.com https://tile.openstreetmap.org">`;

export const ui = $state({
    status: "",
    hint: "",
    pos: "",
    canPrev: false,
    canNext: false,
    chip: null,        // { label }
    fixit: null,
    auto: true,
    streaming: false,
    hasPage: false,
    source: "",
    backVisible: false,
    onLive: true,
    trigger: null,     // { kind, label } of the node on screen
    timelineOpen: false,
    timeline: [],      // [{ id, label, kind, depth, isCurrent }]
});

let canvas = null;
let controller = null;
let preludeSrc = "";
let actionBuf = [];
let actionTimer = null;
let pageErrors = [];
let chipAction = null;

// conversation tree
let nodes = {};        // id -> { id, parent, trigger: {kind, text, label, key}, html, ts }
let order = [];        // creation order
let current = null;    // node id on screen
let convId = crypto.randomUUID();

const node = (id) => nodes[id];
const latest = () => order[order.length - 1] || null;
const children = (id) => order.filter(n => nodes[n].parent === id);

function path(id) {
    const chain = [];
    for (let n = node(id); n; n = node(n.parent)) chain.unshift(n);
    return chain;
}

const apiMessages = (id) => path(id).flatMap(n => [
    { role: "user", content: n.trigger.text },
    { role: "assistant", content: n.html },
]);


/* ---------- raw mode engine (unchanged mechanics) ---------- */

const rawRoot = document.createElement("div");
rawRoot.id = "raw-root";
const loadedSrcs = new Set();
let registry = null;
let taintDepth = 0;
let executing = false;

const tracking = () => MODE === "raw" && (executing || taintDepth > 0);

const taint = (fn) => typeof fn !== "function" ? fn : function (...a) {
    taintDepth++;
    try { return fn.apply(this, a); } finally { taintDepth--; }
};

if (MODE === "raw") {
    const RT = {
        setTimeout: window.setTimeout.bind(window),
        setInterval: window.setInterval.bind(window),
        raf: window.requestAnimationFrame.bind(window),
        addEL: EventTarget.prototype.addEventListener,
    };
    window.setTimeout = (fn, ...a) => { const id = RT.setTimeout(taint(fn), ...a); if (tracking()) registry?.timers.add(id); return id; };
    window.setInterval = (fn, ...a) => { const id = RT.setInterval(taint(fn), ...a); if (tracking()) registry?.intervals.add(id); return id; };
    window.requestAnimationFrame = (fn) => { const id = RT.raf(taint(fn)); if (tracking()) registry?.rafs.add(id); return id; };
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
        if (tracking() && (this === window || this === document)) {
            const wrapped = taint(fn);
            registry?.listeners.push([this, type, wrapped]);
            return RT.addEL.call(this, type, wrapped, opts);
        }
        return RT.addEL.call(this, type, fn, opts);
    };
}

function sweep() {
    if (!registry) return;
    for (const id of registry.timers) clearTimeout(id);
    for (const id of registry.intervals) clearInterval(id);
    for (const id of registry.rafs) cancelAnimationFrame(id);
    for (const [t, type, fn] of registry.listeners) t.removeEventListener(type, fn);
    for (const n of registry.headNodes) n.remove();
    registry = null;
}

const scopeCss = (css) => `@scope (#raw-root) {\n${css.replace(/(^|[,\s{}])(body|html)(?=[\s,{.:#[])/g, "$1#raw-root")}\n}`;

function execScript(sn) {
    const s = document.createElement("script");
    if (sn.type) s.type = sn.type;
    if (sn.src) {
        if (loadedSrcs.has(sn.src)) return;
        loadedSrcs.add(sn.src);
        s.src = sn.src;
        s.async = false;
    } else {
        s.textContent = MODE === "raw" && sn.type !== "module" ? `(() => {\n${sn.textContent}\n})()` : sn.textContent;
    }
    executing = true;
    try { rawRoot.appendChild(s); } finally { executing = false; }
}

function rawInstall(html) {
    if (MODE === "raw") sweep();
    registry = { timers: new Set(), intervals: new Set(), rafs: new Set(), listeners: [], headNodes: [] };
    if (!rawRoot.isConnected) canvas.replaceChildren(rawRoot);
    rawRoot.replaceChildren();

    const parsed = new DOMParser().parseFromString(html, "text/html");
    for (const n of [...parsed.head.children]) {
        if (n.tagName === "LINK" && n.href) {
            if ([...document.head.querySelectorAll("link")].some(l => l.href === n.href)) continue;
            const link = n.cloneNode();
            document.head.appendChild(link);
            if (MODE === "raw") registry.headNodes.push(link);
        } else if (n.tagName === "STYLE") {
            const st = document.createElement("style");
            st.textContent = MODE === "raw" ? scopeCss(n.textContent) : n.textContent;
            document.head.appendChild(st);
            if (MODE === "raw") registry.headNodes.push(st);
        } else if (n.tagName === "SCRIPT") {
            execScript(n);
        }
    }
    for (const n of [...parsed.body.childNodes]) {
        if (n.tagName === "SCRIPT") execScript(n);
        else rawRoot.appendChild(document.importNode(n, true));
    }
}

function safeCut(s) {
    const lastOpen = s.lastIndexOf("<");
    const lastClose = s.lastIndexOf(">");
    let cut = lastClose < lastOpen ? lastOpen : s.length;
    const scriptOpen = s.lastIndexOf("<script");
    if (scriptOpen !== -1 && s.indexOf("</script", scriptOpen) === -1) cut = Math.min(cut, scriptOpen);
    return cut;
}

function rawAppendHtml(html) {
    html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs, body) => {
        const srcm = attrs.match(/src=["']([^"']+)["']/i);
        const typem = attrs.match(/type=["']([^"']+)["']/i);
        execScript({ src: srcm ? new URL(srcm[1], location.href).href : "", textContent: body, type: typem ? typem[1] : "" });
        return "";
    });
    const clean = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<\/(body|html)>/gi, "");
    if (clean.trim()) rawRoot.insertAdjacentHTML("beforeend", clean);
}


/* ---------- renderers ---------- */

function makeRenderer() {
    if (MODE === "iframe") {
        let doc = null;
        return {
            mount(html) {
                const frame = document.createElement("iframe");
                frame.id = "page";
                canvas.replaceChildren(frame);
                doc = frame.contentDocument;
                doc.open();
                if (LIBS === "allowlist") html = html.replace(/<head([^>]*)>/i, `<head$1>${CSP}`);
                doc.write(html);
                const s = doc.createElement("script");
                s.textContent = preludeSrc;
                (doc.head || doc.documentElement)?.appendChild(s);
            },
            append(t) { doc.write(t); },
            finish() { doc.close(); },
        };
    }
    let rbuf = "";
    return {
        mount(html) { rawInstall(html); },
        append(t) {
            rbuf += t;
            const cut = safeCut(rbuf);
            if (cut > 0) { rawAppendHtml(rbuf.slice(0, cut)); rbuf = rbuf.slice(cut); }
        },
        finish() { if (rbuf) rawAppendHtml(rbuf); rbuf = ""; },
    };
}

function renderStatic(html) {
    const r = makeRenderer();
    const run = () => { r.mount(html); r.finish(); };
    if (document.startViewTransition) document.startViewTransition(run);
    else run();
    ui.hasPage = true;
}


/* ---------- viewing + deck ---------- */

function syncUi() {
    const n = current ? node(current) : null;
    const idx = order.indexOf(current);
    ui.pos = order.length ? `${idx + 1}/${order.length}` : "";
    ui.canPrev = idx > 0;
    ui.canNext = idx >= 0 && idx < order.length - 1;
    ui.backVisible = !!n?.parent;
    ui.onLive = !order.length || current === latest();
    ui.trigger = n ? { kind: n.trigger.kind, label: n.trigger.label } : null;
    ui.timeline = order.map(id => ({
        id,
        label: nodes[id].trigger.label,
        kind: nodes[id].trigger.kind,
        depth: path(id).length - 1,
        isCurrent: id === current,
    }));
}

export function view(id, { push = true } = {}) {
    if (!node(id)) return;
    current = id;
    renderStatic(node(id).html);
    if (push) history.pushState({ node: id }, "", `#n-${order.indexOf(id) + 1}`);
    syncUi();
    idb.save();
}

export function back() { if (node(current)?.parent) view(node(current).parent); }
export function goLatest() { if (latest()) view(latest()); }
export function scrub(delta) {
    const idx = order.indexOf(current) + delta;
    if (idx >= 0 && idx < order.length) view(order[idx]);
}
export function timelineJump(id) { view(id); }

window.addEventListener("popstate", (e) => {
    if (e.state?.node && node(e.state.node)) view(e.state.node, { push: false });
});


/* ---------- idb: tree, one conversation slot ---------- */

const idb = {
    db: null,
    open: () => new Promise((res) => {
        const rq = indexedDB.open("carte-blanche", 2);
        rq.onupgradeneeded = () => {
            if (!rq.result.objectStoreNames.contains("conv")) rq.result.createObjectStore("conv", { keyPath: "id" });
        };
        rq.onsuccess = () => { idb.db = rq.result; res(); };
        rq.onerror = () => res();
    }),
    save() { this.db?.transaction("conv", "readwrite").objectStore("conv").put({ id: "current", nodes, order, current, convId, ts: Date.now() }); },
    load: () => new Promise((res) => {
        if (!idb.db) return res(null);
        const rq = idb.db.transaction("conv").objectStore("conv").get("current");
        rq.onsuccess = () => res(rq.result || null);
        rq.onerror = () => res(null);
    }),
    clear() { this.db?.transaction("conv", "readwrite").objectStore("conv").delete("current"); },
};

// v1 slots stored a flat messages array - fold it into a chain of nodes
function migrateV1(saved) {
    const out = { nodes: {}, order: [], current: null };
    let parent = null;
    for (let i = 0; i + 1 < saved.messages.length; i += 2) {
        const text = saved.messages[i].content;
        const id = crypto.randomUUID();
        out.nodes[id] = {
            id, parent, ts: Date.now(),
            trigger: { kind: text.startsWith("[ui event]") ? "event" : "prompt", text, label: text.slice(0, 80), key: null },
            html: saved.messages[i + 1].content,
        };
        out.order.push(id);
        parent = id;
    }
    out.current = parent;
    return out;
}


/* ---------- generation ---------- */

async function generate(trigger) {
    controller?.abort();
    controller = new AbortController();
    actionBuf = [];
    clearTimeout(actionTimer);
    ui.chip = null;
    ui.fixit = null;
    pageErrors = [];
    ui.streaming = true;
    ui.status = "thinking...";
    ui.hint = "";

    const parent = current;
    const nodeId = crypto.randomUUID();
    const t0 = performance.now();
    let tShell = 0;
    let doneMeta = null;

    const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            messages: [...(parent ? apiMessages(parent) : []), { role: "user", content: trigger.text }],
            conv: convId,
            node: nodeId,
            parent,
            trigger: { kind: trigger.kind, label: trigger.label },
        }),
        signal: controller.signal,
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    const freshPage = () => ({ renderer: makeRenderer(), phase: "scan", pending: "", shellBuf: "", tail: "", page: "", mounted: false, outQ: "", closed: false, shellTimer: null });
    let pg = freshPage();

    const flushQ = () => {
        if (!pg.mounted) return;
        if (pg.outQ) { pg.renderer.append(pg.outQ); pg.outQ = ""; }
        if (pg.closed) pg.renderer.finish();
    };

    const goLive = (html) => {
        clearTimeout(pg.shellTimer);
        pg.phase = "live";
        tShell = tShell || performance.now() - t0;
        pg.page += html;
        const cur = pg;
        const run = () => { cur.renderer.mount(html); cur.mounted = true; flushQ(); };
        if (document.startViewTransition) document.startViewTransition(run);
        else run();
        ui.status = "rendering...";
        ui.hasPage = true;
    };

    const writeLive = (text) => {
        const chunk = pg.tail + text;
        pg.outQ += chunk.slice(0, -TAIL);
        pg.page += chunk.slice(0, -TAIL);
        pg.tail = chunk.slice(-TAIL);
        flushQ();
    };

    const write = (text) => {
        if (pg.phase === "scan") {
            pg.pending += text;
            const m = pg.pending.search(/<!doctype|<html/i);
            if (m === -1) return;
            pg.phase = "shell";
            text = pg.pending.slice(m);
            pg.pending = "";
            ui.status = "composing...";
            pg.shellTimer = setTimeout(() => {
                if (pg.phase === "shell") { goLive(pg.shellBuf); pg.shellBuf = ""; }
            }, SHELL_TIMEOUT);
        }
        if (pg.phase === "shell") {
            pg.shellBuf += text;
            const idx = pg.shellBuf.indexOf(MARKER);
            if (idx >= 0) {
                const rest = pg.shellBuf.slice(idx + MARKER.length);
                goLive(pg.shellBuf.slice(0, idx));
                pg.shellBuf = "";
                if (rest) writeLive(rest);
            } else if (pg.shellBuf.length > SHELL_LIMIT) {
                goLive(pg.shellBuf);
                pg.shellBuf = "";
            }
            return;
        }
        if (pg.phase === "live") writeLive(text);
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop();
        for (const part of parts) {
            if (!part.startsWith("data: ")) continue;
            const event = JSON.parse(part.slice(6));
            if (event.t === "delta") {
                write(event.text);
            } else if (event.t === "phase") {
                ui.status = event.name === "reviewing" ? "reviewing the rendered page..." : event.name;
            } else if (event.t === "revision") {
                console.log("[cb] revision", JSON.stringify(event.notes));
                ui.status = "revising: " + (event.notes || "").replace(/\n/g, " ").slice(0, 70);
                clearTimeout(pg.shellTimer);
                pg = freshPage();
            } else if (event.t === "done") {
                if (pg.phase !== "live") goLive(pg.shellBuf || pg.pending);
                const flush = pg.tail.replace(/\s*```\s*$/, "");
                pg.tail = "";
                pg.outQ += flush;
                pg.page += flush;
                pg.closed = true;
                flushQ();
                doneMeta = event;

                nodes[nodeId] = { id: nodeId, parent, trigger, html: pg.page, ts: Date.now() };
                order.push(nodeId);
                current = nodeId;
                history.pushState({ node: nodeId }, "", `#n-${order.length}`);
                syncUi();
                idb.save();

                const total = ((performance.now() - t0) / 1000).toFixed(1);
                const paint = (tShell / 1000).toFixed(1);
                const rate = Math.round(event.usage.out / ((performance.now() - t0) / 1000));
                const rev = event.reviewed ? (event.verdict === "revise" ? " · reviewed+revised" : " · reviewed ✓") : "";
                if (event.stop_reason === "refusal") ui.status = "model declined - try rephrasing";
                else if (event.stop_reason === "max_tokens") ui.status = `truncated at ${event.usage.out} tok`;
                else ui.status = `paint ${paint}s · ${total}s · ${event.usage.out} tok (${rate}/s)${rev}`;
                ui.streaming = false;
                maybeFixit();
            } else if (event.t === "error") {
                clearTimeout(pg.shellTimer);
                ui.streaming = false;
                ui.status = "error: " + event.message.slice(0, 100);
            }
        }
    }
}

export function sendPrompt(text, label = null) {
    if (!text.trim()) return;
    generate({ kind: "prompt", text, label: label || (text.length > 60 ? text.slice(0, 57) + "..." : text), key: null });
}

function sendEvents(events) {
    const text = events.map(a => `[ui event] action=${a.action || "?"}${a.label ? ` label="${a.label}"` : ""}${a.data !== undefined ? " data=" + JSON.stringify(a.data) : ""}`).join("\n");
    const label = "clicked: " + (events[0].label || events[0].action) + (events.length > 1 ? ` +${events.length - 1}` : "");
    const key = events.map(a => `${a.action}|${a.label}|${JSON.stringify(a.data)}`).join("&");

    // memoized edge: same interaction from this page already has a generated child - just show it
    const hit = children(current).find(c => nodes[c].trigger.key === key);
    if (hit) {
        console.log("[cb] memo hit", key);
        ui.hint = "already generated - showing it";
        view(hit);
        return;
    }
    generate({ kind: "event", text, label, key });
}


/* ---------- page events ---------- */

function handleUserAction(d) {
    console.log("[cb] user_action", JSON.stringify(d));
    actionBuf.push(d);
    clearTimeout(actionTimer);
    actionTimer = setTimeout(flushActions, ACTION_DEBOUNCE);
}

function handlePageError(d) {
    console.log("[cb] page_error", JSON.stringify(d));
    pageErrors.push(d);
    ui.hint = "page error: " + (d.message || "").slice(0, 80);
    maybeFixit();
}

function flushActions() {
    const seen = {};
    for (const a of actionBuf) seen[a.action || a.label || "action"] = a;
    const events = Object.values(seen);
    actionBuf = [];
    if (!events.length) return;
    console.log("[cb] flush", JSON.stringify({ auto: ui.auto, n: events.length }));

    if (ui.auto) {
        sendEvents(events);
    } else {
        ui.chip = { label: "clicked: " + (events[0].label || events[0].action) + (events.length > 1 ? ` +${events.length - 1}` : "") };
        chipAction = () => { ui.chip = null; sendEvents(events); };
    }
}

function maybeFixit() {
    if (ui.streaming || !pageErrors.length) return;
    ui.fixit = "fix page" + (pageErrors.length > 1 ? ` (${pageErrors.length})` : "");
}

export function chipClick() { chipAction?.(); }

export function fixitClick() {
    const lines = pageErrors.slice(0, 3).map(e => e.message + (e.line ? ` (line ${e.line})` : ""));
    ui.fixit = null;
    sendPrompt("[page error] " + lines.join(" | ") + " - the page you rendered threw at runtime. fix the bug and re-render the corrected page.", "fix page");
}

export const nodeHtml = (id) => nodes[id]?.html || "";

export function viewSource() {
    ui.source = ui.source ? "" : (current ? node(current).html : "(nothing rendered yet)");
}

export function reset() {
    controller?.abort();
    idb.clear();
    location.href = location.pathname + location.search;
}


/* ---------- init ---------- */

export async function initEngine(canvasEl) {
    canvas = canvasEl;
    preludeSrc = await fetch("/prelude.js").then(r => r.text());

    window.addEventListener("message", (e) => {
        if (e.source !== document.getElementById("page")?.contentWindow) return;
        const d = e.data;
        if (!d || !d.kind) return;
        if (d.kind === "user_action") handleUserAction(d);
        else if (d.kind === "page_error") handlePageError(d);
    });

    if (MODE !== "iframe") {
        window.ui = { emit: (payload) => handleUserAction({ kind: "user_action", ...payload }) };
        window.addEventListener("error", (e) => {
            if (e.target && e.target.tagName === "IMG") {
                if (!e.target.dataset.cbFallback) {
                    e.target.dataset.cbFallback = "1";
                    e.target.src = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260"><rect width="100%" height="100%" fill="#e5e2dc"/><text x="50%" y="50%" text-anchor="middle" fill="#9a958c" font-family="system-ui" font-size="15">image unavailable</text></svg>');
                }
                return;
            }
            if (e.message) handlePageError({ kind: "page_error", message: String(e.message), line: e.lineno || 0 });
        }, true);
    }

    await idb.open();
    let saved = await idb.load();
    if (saved?.messages) saved = { ...migrateV1(saved), convId: crypto.randomUUID() };
    if (saved?.order?.length) {
        nodes = saved.nodes;
        order = saved.order;
        current = saved.current || latest();
        convId = saved.convId || convId;
        renderStatic(node(current).html);
        history.replaceState({ node: current }, "", `#n-${order.indexOf(current) + 1}`);
        ui.status = "restored";
        syncUi();
    }

    window.__cb = { get tree() { return { nodes, order, current, convId }; }, ui, scrub, view, back, goLatest, sendPrompt };  // debug handle for dev tooling
    console.log("[cb] mode", MODE, "libs", LIBS, "conv", convId);
}
