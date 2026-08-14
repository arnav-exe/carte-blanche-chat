<script>
    import { onMount } from "svelte";
    import gsap from "gsap";
    import { SendHorizontal, Code2, RotateCcw, ChevronLeft, ChevronRight, Zap, Sparkles, TriangleAlert, History } from "lucide-svelte";
    import { ui, sendMessage, navigate, chipClick, fixitClick, viewSource, reset, MODE } from "./engine.svelte.js";

    let dockEl;
    let inputEl;
    let value = $state("");
    let focused = $state(false);
    let near = $state(true);
    let hideTimer;
    let visible = true;

    // dock earns its exit: slides away when idle so the page takes the spotlight
    const wantVisible = () => near || focused || ui.streaming || !!ui.chip || !!ui.fixit || !ui.hasPage;

    function apply() {
        const want = wantVisible();
        if (want === visible) return;
        visible = want;
        gsap.to(dockEl, { y: want ? 0 : 96, autoAlpha: want ? 1 : 0, duration: 0.55, ease: "expo.out" });
    }

    $effect(() => { ui.streaming; ui.chip; ui.fixit; ui.hasPage; apply(); });

    function onMove(e) {
        const wasNear = near;
        near = window.innerHeight - e.clientY < 130;
        if (near) {
            clearTimeout(hideTimer);
        } else if (wasNear) {
            hideTimer = setTimeout(() => { near = false; apply(); }, 1800);
        }
        apply();
    }

    function submit() {
        const text = value.trim();
        if (!text) return;
        value = "";
        sendMessage(text);
    }

    onMount(() => {
        gsap.from(dockEl, { y: 40, autoAlpha: 0, duration: 0.9, ease: "expo.out", delay: 0.15 });
        const key = (e) => {
            if (e.key === "/" && document.activeElement !== inputEl) { e.preventDefault(); inputEl.focus(); }
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("keydown", key);
        return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("keydown", key); };
    });
</script>

<!-- reveal handle - the only trace of the dock when hidden -->
<div class="fixed bottom-0 left-1/2 -translate-x-1/2 w-24 h-5 z-40" onmouseenter={() => { near = true; apply(); }}>
    <div class="mx-auto mt-2 h-1 w-10 rounded-full bg-white/20"></div>
</div>

<div class="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 w-[min(720px,calc(100vw-2rem))]" bind:this={dockEl}>

    {#if ui.chip}
        <button onclick={chipClick}
            class="flex items-center gap-2 px-4 py-1.5 rounded-full text-sm backdrop-blur-xl border transition-colors
                   {ui.chip.kind === 'rewind' ? 'bg-sky-400/10 border-sky-300/30 text-sky-200 hover:bg-sky-400/20' : 'bg-amber-400/10 border-amber-300/30 text-amber-200 hover:bg-amber-400/20'}">
            {#if ui.chip.kind === "rewind"}<History size={14} />{:else}<Sparkles size={14} />{/if}
            {ui.chip.label}
        </button>
    {/if}

    {#if ui.fixit}
        <button onclick={fixitClick}
            class="flex items-center gap-2 px-4 py-1.5 rounded-full text-sm backdrop-blur-xl bg-red-400/10 border border-red-300/30 text-red-200 hover:bg-red-400/20 transition-colors">
            <TriangleAlert size={14} /> {ui.fixit}
        </button>
    {/if}

    <div class="flex items-center gap-2 w-full pl-5 pr-2 py-2 rounded-full bg-[#12141c]/75 backdrop-blur-2xl border border-white/10 shadow-[0_12px_48px_rgba(0,0,0,0.55)]">

        <div class="flex flex-col min-w-0 max-w-44 shrink-0">
            {#if ui.status}<span class="text-[11px] text-slate-400 truncate">{ui.status}</span>{/if}
            {#if ui.hint}<span class="text-[10px] text-slate-500 truncate">{ui.hint}</span>{/if}
        </div>

        <input bind:this={inputEl} bind:value
            onfocus={() => { focused = true; apply(); }}
            onblur={() => { focused = false; apply(); }}
            onkeydown={(e) => e.key === "Enter" && submit()}
            placeholder={ui.hasPage ? "ask for anything... ( / )" : "ask for anything..."}
            spellcheck="false" autocomplete="off"
            class="flex-1 min-w-0 bg-transparent outline-none text-[15px] placeholder:text-slate-500" />

        <label class="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer select-none shrink-0"
            title="auto-send page clicks - uncheck to confirm each one first">
            <input type="checkbox" bind:checked={ui.auto} class="accent-indigo-500 size-3" />
            <Zap size={12} />
        </label>

        <div class="flex items-center gap-0.5 shrink-0 text-slate-400">
            <button onclick={() => navigate(parseInt(ui.pos) - 2)} disabled={!ui.canPrev} class="p-1.5 rounded-full hover:bg-white/10 disabled:opacity-25"><ChevronLeft size={15} /></button>
            {#if ui.pos}<span class="text-[11px] tabular-nums">{ui.pos}</span>{/if}
            <button onclick={() => navigate(parseInt(ui.pos))} disabled={!ui.canNext} class="p-1.5 rounded-full hover:bg-white/10 disabled:opacity-25"><ChevronRight size={15} /></button>
        </div>

        <button onclick={submit} class="p-2.5 rounded-full bg-indigo-500 hover:bg-indigo-400 transition-colors shrink-0" title="send">
            <SendHorizontal size={15} />
        </button>
        <button onclick={viewSource} class="p-2.5 rounded-full hover:bg-white/10 text-slate-400 shrink-0" title="view page source"><Code2 size={15} /></button>
        <button onclick={reset} class="p-2.5 rounded-full hover:bg-white/10 text-slate-400 shrink-0" title="reset conversation"><RotateCcw size={15} /></button>
    </div>

    {#if MODE !== "iframe"}
        <span class="text-[10px] tracking-widest uppercase text-slate-600">{MODE} mode</span>
    {/if}
</div>
