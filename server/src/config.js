import 'dotenv/config';

export function loadConfig(env = process.env) {
  const required = (name) => {
    const v = env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
  };

  const port = Number(env.PORT || 3001);

  return {
    port,
    databaseUrl: env.SUPABASE_DB_URL || null, // required at boot, not for tests
    // CONTRACT §2: the one static export/sync API key. Never logged.
    exportApiKey: required('EXPORT_API_KEY'),
    // CONTRACT §4.4: review_url base — format locked as <base>/review/<hand_id>.
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    jwtSecret: required('JWT_SECRET'),
    jwtExpiresIn: env.JWT_EXPIRES_IN || '12h',
    coachEmail: required('COACH_EMAIL'),
    coachInitialPassword: required('COACH_INITIAL_PASSWORD'),
    coachDisplayName: env.COACH_DISPLAY_NAME || 'Coach',
    clientOrigin: env.CLIENT_ORIGIN || 'http://localhost:5173',
  };
}
