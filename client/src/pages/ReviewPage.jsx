/**
 * /review/:handId — the route is reserved in M3 because exported hands
 * carry a review_url whose shape is locked forever (CONTRACT §4.4).
 * M6 replaces this placeholder with the real replay/annotation page.
 */
export default function ReviewPage({ player, handId, onLogout }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-4 py-3 flex items-center justify-between">
        <a href="/" className="text-xl font-semibold text-emerald-400">FeltSide</a>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-slate-400">{player.display_name}</span>
          <button onClick={onLogout} className="text-slate-500 hover:text-slate-300">
            Sign out
          </button>
        </div>
      </header>
      <main className="max-w-3xl mx-auto p-4">
        <div className="border border-dashed border-slate-800 rounded-xl p-10 text-center">
          <h2 className="text-lg font-medium mb-2">Hand review</h2>
          <p className="text-slate-500 mb-1">
            Action-by-action replay lands in M6. This link is permanent — come back.
          </p>
          <p className="text-slate-600 font-mono text-sm break-all">{handId}</p>
          <a href="/" className="inline-block mt-6 rounded-md bg-slate-800 hover:bg-slate-700 px-4 py-2 text-sm">
            Back to lobby
          </a>
        </div>
      </main>
    </div>
  );
}
