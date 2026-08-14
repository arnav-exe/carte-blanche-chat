import hashlib
import json
import time
from pathlib import Path

import anthropic
import httpx
from fastapi import FastAPI
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

import llm

ROOT = Path(__file__).parent.parent
RUNS = ROOT / "runs"
IMG_CACHE = RUNS / "img"
UA = {"User-Agent": "carte-blanche-chat/0.1 (dev poc; github.com/arnav-exe/carte-blanche-chat)"}
IMG_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg"}

app = FastAPI()


def _openverse(q):
    try:
        r = httpx.get("https://api.openverse.org/v1/images/", params={"q": q, "page_size": 3}, headers=UA, timeout=8)
        return [res["url"] for res in r.json().get("results", []) if res.get("url")] if r.status_code == 200 else []
    except Exception:
        return []


def _wikimedia(q):
    try:
        params = {"action": "query", "generator": "search", "gsrsearch": q, "gsrnamespace": 6, "gsrlimit": 5, "prop": "imageinfo", "iiprop": "url", "iiurlwidth": 1200, "format": "json"}
        r = httpx.get("https://commons.wikimedia.org/w/api.php", params=params, headers=UA, timeout=8)
        if r.status_code != 200:
            return []
        pages = r.json().get("query", {}).get("pages", {})
        urls = [(p.get("imageinfo") or [{}])[0].get("thumburl") for p in pages.values()]
        return [u for u in urls if u and u.rsplit(".", 1)[-1].lower() in ("jpg", "jpeg", "png", "webp", "gif")]
    except Exception:
        return []


# lazy image proxy - model writes /img?q=..., we resolve via keyless providers and cache bytes to disk
@app.get("/img")
def img(q: str):
    IMG_CACHE.mkdir(parents=True, exist_ok=True)
    key = hashlib.md5(q.lower().strip().encode()).hexdigest()[:16]
    cached = list(IMG_CACHE.glob(key + ".*"))
    if cached:
        return FileResponse(cached[0])

    for url in (_openverse(q) + _wikimedia(q))[:5]:
        try:
            r = httpx.get(url, headers=UA, follow_redirects=True, timeout=12)
        except Exception:
            continue
        ctype = r.headers.get("content-type", "").split(";")[0]
        if r.status_code == 200 and ctype in IMG_EXT:
            path = IMG_CACHE / f"{key}.{IMG_EXT[ctype]}"
            path.write_bytes(r.content)
            return FileResponse(path)
    return Response(status_code=404)  # prelude swaps in a placeholder client side


# relay the model stream as sse, tee everything to runs/ for the gallery + fixtures
@app.post("/api/chat")
def chat(body: dict):
    def gen():
        run_dir = RUNS / time.strftime("%Y%m%d-%H%M%S")
        run_dir.mkdir(parents=True, exist_ok=True)
        page = []
        with open(run_dir / "stream.jsonl", "w") as log:
            try:
                for event in llm.stream_page(body["messages"]):
                    log.write(json.dumps(event) + "\n")
                    if event["t"] == "delta":
                        page.append(event["text"])
                    elif event["t"] == "revision":  # revised page replaces the draft in the gallery
                        page.clear()
                    yield f"data: {json.dumps(event)}\n\n"
            except anthropic.APIError as e:  # surface as an event so the dock can show it
                yield f"data: {json.dumps({'t': 'error', 'message': str(e)})}\n\n"
        (run_dir / "page.html").write_text("".join(page))

    return StreamingResponse(gen(), media_type="text/event-stream")


_static = ROOT / "host" / "dist" if (ROOT / "host" / "dist").exists() else ROOT / "web"  # svelte build, or the v1 shell as fallback
app.mount("/", StaticFiles(directory=_static, html=True), name="web")
