import json
import time
from pathlib import Path

import anthropic
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

import llm

ROOT = Path(__file__).parent.parent
RUNS = ROOT / "runs"

app = FastAPI()


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
                    yield f"data: {json.dumps(event)}\n\n"
            except anthropic.APIError as e:  # surface as an event so the dock can show it
                yield f"data: {json.dumps({'t': 'error', 'message': str(e)})}\n\n"
        (run_dir / "page.html").write_text("".join(page))

    return StreamingResponse(gen(), media_type="text/event-stream")


app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
