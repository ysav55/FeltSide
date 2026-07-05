import { hashPassword } from './auth/passwords.js';
import { buildPlayersRepo } from './repos/playersRepo.js';
import { buildBankrollRepo } from './repos/bankrollRepo.js';

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
