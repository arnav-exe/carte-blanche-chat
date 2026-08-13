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
})();
