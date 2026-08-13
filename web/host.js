const canvas = document.getElementById("canvas");
const promptEl = document.getElementById("prompt");
const statusEl = document.getElementById("status");
const sourceEl = document.getElementById("source");

const TAIL = 12;  // chars held back so a trailing ``` fence never hits the page

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

    const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages }),
        signal: controller.signal,
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let pending = "";  // pre-document chatter (fences etc) accumulates here
    let tail = "";
    let page = "";
    let doc = null;

    const write = (text) => {
        if (!doc) {
            pending += text;
            const m = pending.search(/<!doctype|<html/i);
            if (m === -1) return;
            doc = newFrame();
            doc.open();
            text = pending.slice(m);
            pending = "";
            statusEl.textContent = "rendering...";
        }
        const chunk = tail + text;
        doc.write(chunk.slice(0, -TAIL));
        page += chunk.slice(0, -TAIL);
        tail = chunk.slice(-TAIL);
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
                const flush = tail.replace(/\s*```\s*$/, "");
                if (doc) { doc.write(flush); doc.close(); }
                page += flush;
                lastPage = page;
                messages.push({ role: "assistant", content: page });
                const secs = ((performance.now() - t0) / 1000).toFixed(1);
                if (event.stop_reason === "refusal") statusEl.textContent = "model declined - try rephrasing";
                else if (event.stop_reason === "max_tokens") statusEl.textContent = `truncated at ${event.usage.out} tok`;
                else statusEl.textContent = `${event.usage.out} tok · ${secs}s`;
            } else if (event.t === "error") {
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
