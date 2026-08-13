const canvas = document.getElementById("canvas");
const promptEl = document.getElementById("prompt");
const statusEl = document.getElementById("status");
const sourceEl = document.getElementById("source");
const chipEl = document.getElementById("chip");
const autoEl = document.getElementById("autosend");
const fixitEl = document.getElementById("fixit");

const MARKER = "<!--SHELL-END-->";
const SHELL_LIMIT = 8192;   // no marker by this many chars -> stop waiting, render what we have
const SHELL_TIMEOUT = 8000;
const TAIL = 12;            // chars held back so a trailing ``` fence never hits the page
const ACTION_DEBOUNCE = 300;  // rapid ui.emit bursts collapse into one turn

let messages = [];
let controller = null;
let lastPage = "";
let preludeSrc = "";
let actionBuf = [];
let actionTimer = null;
let pageErrors = [];
let streaming = false;

fetch("prelude.js").then(r => r.text()).then(t => preludeSrc = t);

// fresh same-origin iframe per turn - throwing the realm away is the cleanup strategy
function newFrame() {
    const frame = document.createElement("iframe");
    frame.id = "page";
    canvas.replaceChildren(frame);
    return frame.contentDocument;
}

async function sendMessage(text) {
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
    let buf = "";
    let phase = "scan";   // scan -> shell -> live
    let pending = "";     // pre-doctype chatter (fences etc)
    let shellBuf = "";    // old page stays visible + interactive while this fills
    let tail = "";
    let page = "";
    let doc = null;
    let outQ = "";        // writes queue here until the view transition actually mounts the frame
    let closed = false;
    let shellTimer = null;

    const flushQ = () => {
        if (!doc) return;
        if (outQ) { doc.write(outQ); outQ = ""; }
        if (closed) doc.close();
    };

    // the signature moment: old page transitions out, new shell paints in one go.
    // startViewTransition runs its callback async, hence the queue above
    const goLive = (html) => {
        clearTimeout(shellTimer);
        phase = "live";
        tShell = performance.now() - t0;
        page += html;
        const mount = () => {
            doc = newFrame();
            doc.open();
            doc.write(html);
            const s = doc.createElement("script");
            s.textContent = preludeSrc;
            (doc.head || doc.documentElement)?.appendChild(s);
            flushQ();
        };
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
                if (phase !== "live") goLive(shellBuf || pending);  // marker or even doctype never came
                const flush = tail.replace(/\s*```\s*$/, "");
                tail = "";
                outQ += flush;
                page += flush;
                closed = true;
                flushQ();
                lastPage = page;
                messages.push({ role: "assistant", content: page });
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

// events flowing back from the generated page
window.addEventListener("message", (e) => {
    if (e.source !== document.getElementById("page")?.contentWindow) return;
    const d = e.data;
    if (!d || !d.kind) return;
    if (d.kind === "user_action") {
        console.log("[cb] user_action", JSON.stringify(d));
        actionBuf.push(d);
        clearTimeout(actionTimer);
        actionTimer = setTimeout(flushActions, ACTION_DEBOUNCE);
    } else if (d.kind === "page_error") {
        console.log("[cb] page_error", JSON.stringify(d));
        pageErrors.push(d);
        statusEl.textContent = "page error: " + (d.message || "").slice(0, 90);
        maybeFixit();
    }
});

// errors during streaming wait until the page settles, then the chip offers a repair turn
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

// rapid bursts collapse to the last event per action name
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

document.getElementById("send").onclick = send;
promptEl.onkeydown = (e) => { if (e.key === "Enter") send(); };

document.getElementById("reset").onclick = () => {
    controller?.abort();
    location.reload();
};

document.getElementById("src").onclick = () => {
    sourceEl.textContent = lastPage || "(nothing rendered yet)";
    sourceEl.hidden = !sourceEl.hidden;
};
