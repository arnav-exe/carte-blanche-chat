import json
import re
import time
from pathlib import Path

import anthropic

from config import MODEL, EFFORT, MAX_TOKENS, FIXTURE, THEME, PIPELINE, BRIEF_MODEL

KEEP_PAGES = 2  # last n assistant pages stay verbatim - older ones collapse to their page-summary

SYSTEM = (Path(__file__).parent / "prompts" / "system.md").read_text()
if THEME:
    SYSTEM += f'\n\ntheme pin:\n- use data-theme="{THEME}" on <html> and build within that palette unless the user explicitly asks for a different look.'

BRIEF_SYSTEM = "you are the creative director of a two stage page generator. users state goals, not layouts - weigh 2-3 candidate presentations (eg for places: globe vs street map vs photo-hero with pins; for data: chart vs cards vs bespoke d3) and commit to the one that best serves the subject and mood. reply with a terse brief for the renderer: 3-7 lines covering the chosen presentation + why, content outline, palette/type vibe grounded in the subject's world, and which toolbox libraries to use (if any). no html, no prose padding."

client = anthropic.Anthropic()

_fixture_count = 0


# older assistant pages become one-line stand-ins - the summary is frozen so the cache prefix stays stable
def _window(messages: list):
    idxs = [i for i, m in enumerate(messages) if m["role"] == "assistant"]
    cut = set(idxs[:-KEEP_PAGES]) if len(idxs) > KEEP_PAGES else set()
    out = []
    for i, m in enumerate(messages):
        if i in cut:
            summ = re.search(r'name="page-summary" content="([^"]*)"', m["content"]) or re.search(r"<title>([^<]*)</title>", m["content"])
            label = summ.group(1) if summ else "untitled page"
            out.append({"role": "assistant", "content": f'[page {idxs.index(i) + 1}: "{label}" - full html omitted, ask user to revisit if needed]'})
        else:
            out.append(m)
    return out


def _stream_kwargs(model, system, messages, max_tokens, effort):
    kwargs = {
        "model": model,
        "max_tokens": max_tokens,
        "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        "messages": messages,
    }
    if effort:
        kwargs["output_config"] = {"effort": effort}
    return kwargs


def stream_page(messages: list):
    global _fixture_count
    if FIXTURE:  # replay recorded streams - free harness dev, no tokens burned
        p = Path(FIXTURE)
        if p.is_dir():
            files = sorted(p.glob("*.jsonl"))
            p = files[min(_fixture_count, len(files) - 1)]
            _fixture_count += 1
        for line in open(p):
            time.sleep(0.012)
            yield json.loads(line)
        return

    messages = _window(messages)

    if PIPELINE == "staged":  # small smart brief, then the renderer streams the bulk
        brief = client.messages.create(**_stream_kwargs(BRIEF_MODEL or MODEL, BRIEF_SYSTEM, messages, 800, "low"))
        text = "".join(b.text for b in brief.content if b.type == "text")
        messages = messages[:-1] + [{"role": "user", "content": messages[-1]["content"] + "\n\n[planner brief - follow unless it conflicts with the request]\n" + text}]

    kwargs = _stream_kwargs(MODEL, SYSTEM, messages, MAX_TOKENS, EFFORT)
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
