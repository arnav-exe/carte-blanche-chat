<script>
    import { MessageSquare, MousePointerClick, CornerDownRight } from "lucide-svelte";
    import { ui, goLatest } from "./engine.svelte.js";
</script>

{#if !ui.onLive && ui.trigger}
    <div class="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 pl-4 pr-2 py-1.5 rounded-full bg-[#12141c]/80 backdrop-blur-2xl border border-white/10 shadow-lg max-w-[min(600px,90vw)]">
        <span class="text-amber-300/80 shrink-0">
            {#if ui.trigger.kind === "event"}<MousePointerClick size={14} />{:else}<MessageSquare size={14} />{/if}
        </span>
        <span class="text-[12px] text-slate-300 truncate italic">{ui.trigger.label}</span>
        <span class="text-[11px] text-slate-500 tabular-nums shrink-0">{ui.pos}</span>
        <button onclick={goLatest}
            class="flex items-center gap-1 text-[11px] px-3 py-1 rounded-full bg-indigo-500/20 border border-indigo-400/30 text-indigo-200 hover:bg-indigo-500/35 transition-colors shrink-0">
            <CornerDownRight size={12} /> return to live
        </button>
    </div>
{/if}
