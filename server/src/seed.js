import { hashPassword } from './auth/passwords.js';
import { buildPlayersRepo } from './repos/playersRepo.js';
import { buildBankrollRepo } from './repos/bankrollRepo.js';
import { buildTournamentPresetsRepo } from './repos/tournamentsRepo.js';
import { seededPresets } from './tournament/presets.js';

/** Seeds the coach account from env on first boot (M1 §3). Idempotent. */
export async function seedCoach(db, config) {
  const playersRepo = buildPlayersRepo(db);
  const bankrollRepo = buildBankrollRepo(db);

  if ((await playersRepo.countCoaches()) > 0) return null;

  const coach = await playersRepo.create({
    displayName: config.coachDisplayName,
    email: config.coachEmail,
    passwordHash: await hashPassword(config.coachInitialPassword),
    role: 'coach',
    mustChangePassword: false,
  });
  await bankrollRepo.createAccount(coach.id);
  return coach;
}

/** Seeds the four TOURNAMENTS §2 presets on an empty catalog. Idempotent. */
export async function seedTournamentPresets(db) {
  const repo = buildTournamentPresetsRepo(db);
  if ((await repo.count()) > 0) return 0;
  let n = 0;
  for (const config of seededPresets()) {
    await repo.create({ name: config.name, description: config.description, config });
    n += 1;
  }
  return n;
}
