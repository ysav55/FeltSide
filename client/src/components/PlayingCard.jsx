const SUIT_GLYPH = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SUIT_COLOR = { s: 'text-slate-200', c: 'text-slate-200', h: 'text-red-400', d: 'text-red-400' };

export default function PlayingCard({ card, hidden = false, small = false }) {
  const size = small ? 'w-8 h-11 text-sm' : 'w-11 h-16 text-lg';
  if (!card || hidden) {
    return (
      <div className={`${size} rounded-md border border-slate-700 bg-gradient-to-br from-slate-700 to-slate-800`} />
    );
  }
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = card[1];
  return (
    <div className={`${size} rounded-md border border-slate-600 bg-slate-900 flex flex-col items-center justify-center font-semibold ${SUIT_COLOR[suit]}`}>
      <span>{rank}</span>
      <span className="leading-none">{SUIT_GLYPH[suit]}</span>
    </div>
  );
}
