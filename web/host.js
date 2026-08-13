const canvas = document.getElementById("canvas");
const promptEl = document.getElementById("prompt");
const statusEl = document.getElementById("status");
const sourceEl = document.getElementById("source");
const chipEl = document.getElementById("chip");
const autoEl = document.getElementById("autosend");
const fixitEl = document.getElementById("fixit");
const prevEl = document.getElementById("prev");
const nextEl = document.getElementById("next");
const posEl = document.getElementById("pos");

const params = new URLSearchParams(location.search);
const MODE = params.get("mode") || "iframe";   // iframe | raw | raw-bare
const LIBS = params.get("libs") || "open";     // open | allowlist

const MARKER = "<!--SHELL-END-->";
const SHELL_LIMIT = 8192;
const SHELL_TIMEOUT = 8000;
const TAIL = 12;            // chars held back so a trailing ``` fence never hits the page
const ACTION_DEBOUNCE = 300;
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' data: https://unpkg.com">`;

let messages = [];
let controller = null;
let lastPage = "";
let preludeSrc = "";
let actionBuf = [];
let actionTimer = null;
let pageErrors = [];
let streaming = false;
let viewIdx = -1;           // which assistant page is on screen, -1 = welcome
let navigating = false;     // guards popstate loops
let pendingRewind = null;

fetch("prelude.js").then(r => r.text()).then(t => preludeSrc = t);

const pages = () => messages.map((m, mi) => ({ ...m, mi })).filter(m => m.role === "assistant");


/* ---------- raw mode engine: same-document rendering + harness instrumentation ---------- */

const rawRoot = document.createElement("div");
rawRoot.id = "raw-root";
const loadedSrcs = new Set();
let registry = null;        // per-turn ledger of everything the page registered
let taintDepth = 0;
let executing = false;

// only raw (instrumented) records - raw-bare gets untouched globals, thats the whole point
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
    window.__rt = RT;  // sweep needs the originals
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
    console.log("[cb] sweep", JSON.stringify({ timers: registry.timers.size, intervals: registry.intervals.size, rafs: registry.rafs.size, listeners: registry.listeners.length, styles: registry.headNodes.length }));
    registry = null;
}

// body/html selectors cant match inside a scoped container - point them at the root instead
const scopeCss = (css) => `@scope (#raw-root) {\n${css.replace(/(^|[,\s{}])(body|html)(?=[\s,{.:#[])/g, "$1#raw-root")}\n}`;

function execScript(node) {
    const s = document.createElement("script");
    if (node.type) s.type = node.type;  // modules etc - wrapping them would break imports
    if (node.src) {
        if (loadedSrcs.has(node.src)) return;
        loadedSrcs.add(node.src);
        s.src = node.src;
        s.async = false;
    } else {
        s.textContent = MODE === "raw" && node.type !== "module" ? `(() => {\n${node.textContent}\n})()` : node.textContent;
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

// streamed chunks can split tags - only flush up to a safe boundary
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


/* ---------- renderers: one interface, three modes ---------- */

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

// scrubbing + restores render a stored page in one shot
function renderStatic(html) {
    const r = makeRenderer();
    const mount = () => { r.mount(html); r.finish(); };
    if (document.startViewTransition) document.startViewTransition(mount);
    else mount();
}


/* ---------- history deck: scrub, pushState, truncate-on-past-send ---------- */

function updateDeck() {
    const p = pages();
    posEl.textContent = p.length ? `${viewIdx + 1}/${p.length}` : "";
    prevEl.disabled = viewIdx <= 0;
    nextEl.disabled = viewIdx >= p.length - 1;
}

function navigate(i, { push = true } = {}) {
    const p = pages();
    if (i < 0 || i >= p.length) return;
    viewIdx = i;
    renderStatic(p[i].content);
    lastPage = p[i].content;
    if (push) history.pushState({ turn: i }, "", `#t${i + 1}`);
    statusEl.textContent = i === p.length - 1 ? "" : `viewing turn ${i + 1} of ${p.length}`;
    updateDeck();
}

prevEl.onclick = () => navigate(viewIdx - 1);
nextEl.onclick = () => navigate(viewIdx + 1);
window.addEventListener("popstate", (e) => {
    if (typeof e.state?.turn === "number") { navigating = true; navigate(e.state.turn, { push: false }); navigating = false; }
});


/* ---------- tiny idb wrapper: one conversation slot, survives refresh ---------- */

const idb = {
    db: null,
    open: () => new Promise((res) => {
        const rq = indexedDB.open("carte-blanche", 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore("conv", { keyPath: "id" });
        rq.onsuccess = () => { idb.db = rq.result; res(); };
        rq.onerror = () => res();
    }),
    save() {
        if (!this.db) return;
        this.db.transaction("conv", "readwrite").objectStore("conv").put({ id: "current", messages, ts: Date.now() });
    },
    load: () => new Promise((res) => {
        if (!idb.db) return res(null);
        const rq = idb.db.transaction("conv").objectStore("conv").get("current");
        rq.onsuccess = () => res(rq.result?.messages || null);
        rq.onerror = () => res(null);
    }),
    clear() { this.db?.transaction("conv", "readwrite").objectStore("conv").delete("current"); },
};


/* ---------- streaming turn ---------- */

async function sendMessage(text) {
    // sending while viewing an old page rewinds the conversation - confirm via chip, not a blocking dialog
    const p = pages();
    if (viewIdx >= 0 && viewIdx < p.length - 1 && !pendingRewind) {
        pendingRewind = { text, keep: p[viewIdx].mi + 1 };
        chipEl.textContent = `⏪ rewind to turn ${viewIdx + 1} and send`;
        chipEl.hidden = false;
        chipEl.onclick = () => {
            const r = pendingRewind;
            pendingRewind = null;
            chipEl.hidden = true;
            messages = messages.slice(0, r.keep);
            sendMessage(r.text);
        };
        statusEl.textContent = "sending from the past rewinds the turns after it";
        return;
    }
    pendingRewind = null;

    controller?.abort();
    controller = new AbortController();
    actionBuf = [];
    clearTimeout(actionTimer);
    chipEl.hidden = true;
    fixitEl.hidden = true;
    pageErrors = [];
    streaming = true;
    messages.push({ role: "user", content: text });
    statusEl.textContent = "thinking...";

    const t0 = performance.now();
    let tShell = 0;

    const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages }),
        signal: controller.signal,
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const renderer = makeRenderer();
    let buf = "";
    let phase = "scan";
    let pending = "";
    let shellBuf = "";
    let tail = "";
    let page = "";
    let mounted = false;
    let outQ = "";
    let closed = false;
    let shellTimer = null;

    const flushQ = () => {
        if (!mounted) return;
        if (outQ) { renderer.append(outQ); outQ = ""; }
        if (closed) renderer.finish();
    };

    const goLive = (html) => {
        clearTimeout(shellTimer);
        phase = "live";
        tShell = performance.now() - t0;
        page += html;
        console.log("[cb] vt swap");
        const mount = () => { renderer.mount(html); mounted = true; flushQ(); };
        if (document.startViewTransition) document.startViewTransition(mount);
        else mount();
        statusEl.textContent = "rendering...";
    };

    const writeLive = (text) => {
        const chunk = tail + text;
        outQ += chunk.slice(0, -TAIL);
        page += chunk.slice(0, -TAIL);
        tail = chunk.slice(-TAIL);
        flushQ();
    };

    const write = (text) => {
        if (phase === "scan") {
            pending += text;
            const m = pending.search(/<!doctype|<html/i);
            if (m === -1) return;
            phase = "shell";
            text = pending.slice(m);
            pending = "";
            statusEl.textContent = "composing...";
            shellTimer = setTimeout(() => {
                if (phase === "shell") { goLive(shellBuf); shellBuf = ""; }
            }, SHELL_TIMEOUT);
        }
        if (phase === "shell") {
            shellBuf += text;
            const idx = shellBuf.indexOf(MARKER);
            if (idx >= 0) {
                const rest = shellBuf.slice(idx + MARKER.length);
                goLive(shellBuf.slice(0, idx));
                shellBuf = "";
                if (rest) writeLive(rest);
            } else if (shellBuf.length > SHELL_LIMIT) {
                goLive(shellBuf);
                shellBuf = "";
            }
            return;
        }
        if (phase === "live") writeLive(text);
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
            } else if (event.t === "done") {
                if (phase !== "live") goLive(shellBuf || pending);
                const flush = tail.replace(/\s*```\s*$/, "");
                tail = "";
                outQ += flush;
                page += flush;
                closed = true;
                flushQ();
                lastPage = page;
                messages.push({ role: "assistant", content: page });
                viewIdx = pages().length - 1;
                history.pushState({ turn: viewIdx }, "", `#t${viewIdx + 1}`);
                updateDeck();
                idb.save();
                const total = ((performance.now() - t0) / 1000).toFixed(1);
                const paint = (tShell / 1000).toFixed(1);
                const rate = Math.round(event.usage.out / ((performance.now() - t0) / 1000));
                if (event.stop_reason === "refusal") statusEl.textContent = "model declined - try rephrasing";
                else if (event.stop_reason === "max_tokens") statusEl.textContent = `truncated at ${event.usage.out} tok`;
                else statusEl.textContent = `paint ${paint}s · ${total}s · ${event.usage.out} tok (${rate}/s)`;
                streaming = false;
                maybeFixit();
            } else if (event.t === "error") {
                clearTimeout(shellTimer);
                streaming = false;
                statusEl.textContent = "error: " + event.message.slice(0, 120);
            }
        }
    }
}

function send() {
    const text = promptEl.value.trim();
    if (!text) return;
    promptEl.value = "";
    sendMessage(text);
}


/* ---------- events from the page: iframe posts messages, raw modes call straight in ---------- */

function handleUserAction(d) {
    console.log("[cb] user_action", JSON.stringify(d));
    actionBuf.push(d);
    clearTimeout(actionTimer);
    actionTimer = setTimeout(flushActions, ACTION_DEBOUNCE);
}

function handlePageError(d) {
    console.log("[cb] page_error", JSON.stringify(d));
    pageErrors.push(d);
    statusEl.textContent = "page error: " + (d.message || "").slice(0, 90);
    maybeFixit();
}

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

function flushActions() {
    const seen = {};
    for (const a of actionBuf) seen[a.action || a.label || "action"] = a;
    const events = Object.values(seen);
    actionBuf = [];
    if (!events.length) return;

    const text = events.map(a => `[ui event] action=${a.action || "?"}${a.label ? ` label="${a.label}"` : ""}${a.data !== undefined ? " data=" + JSON.stringify(a.data) : ""}`).join("\n");
    const label = (events[0].label || events[0].action) + (events.length > 1 ? ` +${events.length - 1}` : "");
    console.log("[cb] flush", JSON.stringify({ auto: autoEl.checked, text }));

    if (autoEl.checked) {
        sendMessage(text);
    } else {
        chipEl.textContent = "⚡ " + label;
        chipEl.hidden = false;
        chipEl.onclick = () => { chipEl.hidden = true; sendMessage(text); };
    }
}

function maybeFixit() {
    if (streaming || !pageErrors.length) return;
    fixitEl.textContent = "⚠ fix page" + (pageErrors.length > 1 ? ` (${pageErrors.length})` : "");
    fixitEl.hidden = false;
}

fixitEl.onclick = () => {
    const lines = pageErrors.slice(0, 3).map(e => e.message + (e.line ? ` (line ${e.line})` : ""));
    fixitEl.hidden = true;
    sendMessage("[page error] " + lines.join(" | ") + " - the page you rendered threw at runtime. fix the bug and re-render the corrected page.");
};


/* ---------- chrome ---------- */

document.getElementById("send").onclick = send;
promptEl.onkeydown = (e) => { if (e.key === "Enter") send(); };

document.getElementById("reset").onclick = () => {
    controller?.abort();
    idb.clear();
    location.href = location.pathname + location.search;
};

document.getElementById("src").onclick = () => {
    sourceEl.textContent = lastPage || "(nothing rendered yet)";
    sourceEl.hidden = !sourceEl.hidden;
};

// restore last conversation on load
idb.open().then(() => idb.load()).then((saved) => {
    if (saved?.length) {
        messages = saved;
        viewIdx = pages().length - 1;
        if (viewIdx >= 0) {
            renderStatic(pages()[viewIdx].content);
            lastPage = pages()[viewIdx].content;
            history.replaceState({ turn: viewIdx }, "", `#t${viewIdx + 1}`);
            statusEl.textContent = "restored";
        }
        updateDeck();
    }
});
console.log("[cb] mode", MODE, "libs", LIBS);
