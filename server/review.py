import base64
import json

import anthropic

from config import REVIEW_MODEL

REVIEW_SYSTEM = """you are a ruthless visual qa reviewer for model-generated webpages. you receive screenshots of the rendered page (viewport + full page), the user's request, and automated findings (axe-core a11y violations, console errors).

check, in order of severity:
1. broken/empty centerpieces: black voids, unrendered canvases, missing content, error text on page
2. occlusion: any element covering or colliding with other content
3. legibility: contrast failures, unreadably small markers/labels, text over busy backgrounds
4. subject fit: does the palette/mood suit the request (a holiday should not look like a funeral)
5. does the page actually answer what the user asked
6. genericness: does it look like a stock template or a known ai-default look (cream+serif+terracotta, near-black+acid-green, purple gradient on white) instead of an identity built for THIS subject? on a request that deserved character, a template look is worth a revise

reply with EXACTLY this format:
- first: your findings as a terse numbered list of concrete, actionable fixes - what is wrong and what to do instead. max 6 items. write "no significant issues" if the page is fine. do not nitpick taste on a page that already has a committed, subject-grounded identity.
- then the FINAL line, alone: APPROVE or REVISE"""

client = anthropic.Anthropic()


# render the html headless, grab evidence: screenshots + axe violations + console errors.
# fresh browser per call - sync playwright is thread-bound and fastapi's threadpool hops threads
def snapshot(html: str):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)[:200]))
        page.set_content(html, wait_until="load")
        page.wait_for_timeout(3500)  # cdn libs, fonts, canvases, entry animations

        shot_top = page.screenshot()
        shot_full = page.screenshot(full_page=True)

        axe = []
        try:
            page.add_script_tag(url="https://cdn.jsdelivr.net/npm/axe-core@4/axe.min.js")
            result = page.evaluate("async () => await axe.run()")
            axe = [f"{v['id']} ({v['impact']}): {v['description'][:100]} x{len(v['nodes'])}" for v in result["violations"]][:6]
        except Exception as e:  # axe is evidence, not a gate
            axe = [f"axe failed: {e}"][:1]

        browser.close()
    return shot_top, shot_full, axe, errors


def critique(user_request: str, html: str):
    shot_top, shot_full, axe, errors = snapshot(html)

    findings = ""
    if errors:
        findings += "console errors:\n" + "\n".join(errors[:4]) + "\n"
    if axe:
        findings += "axe-core violations:\n" + "\n".join(axe)

    msg = client.messages.create(
        model=REVIEW_MODEL,
        max_tokens=600,
        system=REVIEW_SYSTEM,
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": f"user asked for: {user_request}"},
                {"type": "text", "text": "viewport:"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode(shot_top).decode()}},
                {"type": "text", "text": "full page:"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode(shot_full).decode()}},
                {"type": "text", "text": findings or "no automated findings"},
            ],
        }],
    )
    text = "".join(b.text for b in msg.content if b.type == "text").strip()
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    verdict = "revise" if lines and lines[-1].upper().startswith("REVISE") else "approve"
    notes = "\n".join(lines[:-1]) if lines else ""
    return verdict, notes, msg.usage.output_tokens
