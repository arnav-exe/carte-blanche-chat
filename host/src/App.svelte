<script>
    import { onMount } from "svelte";
    import { ArrowLeft } from "lucide-svelte";
    import { ui, initEngine, back } from "./engine.svelte.js";
    import Dock from "./Dock.svelte";

    let canvasEl;
    onMount(() => { initEngine(canvasEl); });
</script>

<div id="canvas" class="fixed inset-0" bind:this={canvasEl}>
    {#if !ui.hasPage}
        <div class="h-full grid place-content-center text-center gap-3 select-none">
            <h1 class="text-2xl font-light tracking-[0.4em] text-slate-200">carte&nbsp;blanche</h1>
            <p class="text-sm text-slate-500">ask for anything. the reply is the page.</p>
        </div>
    {/if}
</div>

{#if ui.backVisible}
    <button onclick={back} title="back to the page this came from (no regeneration)"
        class="fixed top-4 left-4 z-50 p-2.5 rounded-full bg-[#12141c]/70 backdrop-blur-xl border border-white/10 text-slate-300 hover:bg-[#1a1d28]/80 hover:text-white shadow-lg transition-colors">
        <ArrowLeft size={17} />
    </button>
{/if}

{#if ui.source}
    <pre class="fixed inset-x-0 top-0 bottom-24 z-40 overflow-auto p-6 bg-black/95 text-emerald-300 text-xs whitespace-pre-wrap break-all">{ui.source}</pre>
{/if}

<Dock />
