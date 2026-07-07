/**
 * Preset helpers (TOURNAMENTS §§1-2): blind-ladder generation and the four
 * seeded presets. Ladders grow ~30–40% per level (rounded to clean chips);
 * BB ante from level 4 (Turbo/Hyper: level 3). All coach-editable.
 */

const ROUND_STEPS = [25, 50, 100, 200, 500, 1000, 2000, 5000];

function roundChip(v) {
  const step = ROUND_STEPS.find((s) => v <= s * 40) ?? ROUND_STEPS[ROUND_STEPS.length - 1];
  // The BB rounds to DOUBLE the chip step so sb = bb/2 always lands on a
  // whole chip (a 275 BB would make a 137.5 SB — chips are integers).
  const unit = step * 2;
  return Math.max(unit, Math.round(v / unit) * unit);
}

/** Generate an explicit ladder: sb=bb/2, ~35%/level growth, ante from level N. */
export function generateLadder({ levels = 20, bb1 = 200, growth = 1.35, anteFromLevel = 4 }) {
  const ladder = [];
  let bb = bb1;
  for (let level = 1; level <= levels; level++) {
    const rounded = roundChip(bb);
    ladder.push({
      level,
      sb: rounded / 2,
      bb: rounded,
      bb_ante: level >= anteFromLevel ? rounded : 0, // BB ante = one BB (modern standard)
    });
    bb = rounded * growth;
  }
  return ladder;
}

function preset({ name, description, stackBb, levelMin, anteFromLevel, lateReg, reentryUntil, addonAfter, breaksEvery, buyIn }) {
  return {
    name,
    description,
    buy_in: buyIn,
    table_size: 6,
    starting_stack_bb: stackBb,
    level_duration_min: levelMin,
    blind_ladder: generateLadder({ bb1: 200, anteFromLevel }),
    ante: { type: 'bb_ante', from_level: anteFromLevel },
    late_reg_until_level: lateReg,
    reentry: { allowed: true, until_level: reentryUntil, max: 2 },
    // Add-on cost: one buy-in (standard practice; §1 leaves the price to the
    // preset — decisions/0011).
    addon: { allowed: true, at_break_after_level: addonAfter, chips: stackBb * 200, cost: buyIn },
    breaks: { every_n_levels: breaksEvery, minutes: 5 },
    action_timer_sec: 30,
    payout_table: 'standard',
    icm_overlay: true,
    deals_enabled: true,
  };
}

/** The §2 seeded set. */
export function seededPresets() {
  return [
    preset({
      name: 'Lesson Turbo', description: 'Fits inside a lesson slot (~75 min).',
      stackBb: 50, levelMin: 8, anteFromLevel: 3, lateReg: 4, reentryUntil: 4,
      addonAfter: 4, breaksEvery: 4, buyIn: 5_000,
    }),
    preset({
      name: 'Standard Evening', description: 'The weekly school event (~2.5 h).',
      stackBb: 75, levelMin: 15, anteFromLevel: 4, lateReg: 6, reentryUntil: 6,
      addonAfter: 6, breaksEvery: 6, buyIn: 10_000,
    }),
    preset({
      name: 'Deep Teach', description: 'Deep-stack play practice (~4 h).',
      stackBb: 150, levelMin: 25, anteFromLevel: 4, lateReg: 8, reentryUntil: 8,
      addonAfter: 8, breaksEvery: 6, buyIn: 20_000,
    }),
    preset({
      name: 'Hyper', description: 'Push/fold & ICM drills (~40 min).',
      stackBb: 30, levelMin: 5, anteFromLevel: 3, lateReg: 3, reentryUntil: 3,
      addonAfter: 3, breaksEvery: 6, buyIn: 2_500,
    }),
  ];
}

/** Level row for a 1-based level, clamped to the ladder end. */
export function ladderLevel(config, level) {
  const ladder = config.blind_ladder;
  return ladder[Math.min(Math.max(level, 1), ladder.length) - 1];
}

/** Starting stack in chips (§1: bb_level1 × starting_stack_bb). */
export function startingStack(config) {
  return config.blind_ladder[0].bb * config.starting_stack_bb;
}
