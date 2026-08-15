<script>
    import { MessageSquare, MousePointerClick, X } from "lucide-svelte";
    import { ui, timelineJump, nodeHtml } from "./engine.svelte.js";

    // thumbnails are the real page html with scripts stripped - pure visual, no js cost
    const thumb = (id) => nodeHtml(id).replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<script[^>]*>/gi, "");
</script>

{#if ui.timelineOpen}
    <div class="fixed bottom-24 left-1/2 -translate-x-1/2 z-40 w-[min(880px,calc(100vw-2rem))] rounded-2xl bg-[#12141c]/85 backdrop-blur-2xl border border-white/10 shadow-2xl p-3">
        <div class="flex items-center justify-between mb-2 px-1">
            <span class="text-[11px] uppercase tracking-widest text-slate-500">conversation timeline</span>
            <button onclick={() => ui.timelineOpen = false} class="p-1 rounded-full hover:bg-white/10 text-slate-400"><X size={14} /></button>
        </div>
        <div class="flex gap-3 overflow-x-auto pb-1">
            {#each ui.timeline as t (t.id)}
                <button onclick={() => timelineJump(t.id)}
                    class="shrink-0 w-40 text-left rounded-xl overflow-hidden border transition-all
                           {t.isCurrent ? 'border-indigo-400/70 ring-2 ring-indigo-400/30' : 'border-white/10 hover:border-white/30'}"
                    style="margin-top: {Math.min(t.depth, 4) * 6}px">
                    <div class="h-24 bg-white overflow-hidden pointer-events-none">
                        <iframe title={t.label} srcdoc={thumb(t.id)} loading="lazy" tabindex="-1"
                            class="w-[640px] h-[384px] origin-top-left pointer-events-none border-0" style="transform: scale(0.25)"></iframe>
                    </div>
                    <div class="flex items-center gap-1.5 px-2 py-1.5 bg-black/30">
                        <span class="text-slate-500 shrink-0">
                            {#if t.kind === "event"}<MousePointerClick size={11} />{:else}<MessageSquare size={11} />{/if}
                        </span>
                        <span class="text-[10.5px] text-slate-300 truncate">{t.label}</span>
                    </div>
                </button>
            {/each}
        </div>
    </div>
{/if}
