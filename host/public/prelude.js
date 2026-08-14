// injected by the host into every generated page - pages never load this themselves
(() => {
    window.ui = {
        emit(payload) {
            parent.postMessage({ kind: "user_action", ...payload }, "*");
        }
    };

    window.addEventListener("error", (e) => {
        parent.postMessage({ kind: "page_error", message: String(e.message || e.error), source: e.filename || "", line: e.lineno || 0 }, "*");
    });

    window.addEventListener("unhandledrejection", (e) => {
        parent.postMessage({ kind: "page_error", message: "unhandled rejection: " + String(e.reason) }, "*");
    });

    // broken <img> swaps to a quiet placeholder instead of the browser's broken-image icon
    window.addEventListener("error", (e) => {
        const t = e.target;
        if (t && t.tagName === "IMG" && !t.dataset.cbFallback) {
            t.dataset.cbFallback = "1";
            t.src = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260"><rect width="100%" height="100%" fill="#e5e2dc"/><text x="50%" y="50%" text-anchor="middle" fill="#9a958c" font-family="system-ui" font-size="15">image unavailable</text></svg>');
        }
    }, true);
})();
