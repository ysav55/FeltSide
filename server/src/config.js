import 'dotenv/config';

export function loadConfig(env = process.env) {
  const required = (name) => {
    const v = env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
  };

  return {
    port: Number(env.PORT || 3001),
    databaseUrl: env.SUPABASE_DB_URL || null, // required at boot, not for tests
    jwtSecret: required('JWT_SECRET'),
    jwtExpiresIn: env.JWT_EXPIRES_IN || '12h',
    coachEmail: required('COACH_EMAIL'),
    coachInitialPassword: required('COACH_INITIAL_PASSWORD'),
    coachDisplayName: env.COACH_DISPLAY_NAME || 'Coach',
    clientOrigin: env.CLIENT_ORIGIN || 'http://localhost:5173',
  };
}
