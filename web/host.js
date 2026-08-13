const canvas = document.getElementById("canvas");
const promptEl = document.getElementById("prompt");
const statusEl = document.getElementById("status");
const sourceEl = document.getElementById("source");

const MARKER = "<!--SHELL-END-->";
const SHELL_LIMIT = 8192;   // no marker by this many chars -> stop waiting, render what we have
const SHELL_TIMEOUT = 8000;
const TAIL = 12;            // chars held back so a trailing ``` fence never hits the page

let messages = [];
let controller = null;
let lastPage = "";

// fresh same-origin iframe per turn - throwing the realm away is the cleanup strategy
function newFrame() {
    const frame = document.createElement("iframe");
    frame.id = "page";
    canvas.replaceChildren(frame);
    return frame.contentDocument;
}

async function send() {
    const text = promptEl.value.trim();
    if (!text) return;
    controller?.abort();
    controller = new AbortController();
    messages.push({ role: "user", content: text });
    promptEl.value = "";
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
            } else if (event.t === "error") {
                clearTimeout(shellTimer);
                statusEl.textContent = "error: " + event.message.slice(0, 120);
            }
        }
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
