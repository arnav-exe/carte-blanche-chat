from pathlib import Path

import anthropic

from config import MODEL, EFFORT

MAX_TOKENS = 64000  # full pages are long, thinking counts against this too

SYSTEM = (Path(__file__).parent / "prompts" / "system.md").read_text()

client = anthropic.Anthropic()


# single pipeline for now - staged brief/render split comes later
def stream_page(messages: list):
    kwargs = {
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": [{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
        "messages": messages,
    }
    if EFFORT:
        kwargs["output_config"] = {"effort": EFFORT}

    if MODEL.startswith(("claude-opus-5", "claude-fable-5")):  # safety classifiers can decline - reroute server side instead of dying
        kwargs["betas"] = ["server-side-fallback-2026-06-01"]
        kwargs["fallbacks"] = [{"model": "claude-opus-4-8"}]
        ctx = client.beta.messages.stream(**kwargs)
    else:
        ctx = client.messages.stream(**kwargs)

    with ctx as stream:
        for text in stream.text_stream:
            yield {"t": "delta", "text": text}
        final = stream.get_final_message()

    yield {
        "t": "done",
        "stop_reason": final.stop_reason,
        "model": final.model,
        "usage": {
            "in": final.usage.input_tokens,
            "out": final.usage.output_tokens,
            "cache_read": final.usage.cache_read_input_tokens,
        },
    }
