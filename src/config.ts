// Typed environment loader. Reads from Bun's process.env once at boot and
// exposes a frozen, typed config object with sane defaults so the app runs
// out of the box (no .env required for local poking).

const env = process.env;

const str = (key: string, fallback: string): string => {
  const v = env[key];
  return v === undefined || v === "" ? fallback : v;
};

const int = (key: string, fallback: number): number => {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
};

const bool = (key: string, fallback: boolean): boolean => {
  const v = env[key];
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1";
};

export const config = {
  port: int("PORT", 3000),
  dbPath: str("DB_PATH", "./data/app.db"),

  uploadDir: str("UPLOAD_DIR", "./data/uploads"),
  mediaMaxBytes: int("MEDIA_MAX_BYTES", 5 * 1024 * 1024),

  jwtSecret: str("JWT_SECRET", "change-me-locally"),
  accessTokenTtl: str("ACCESS_TOKEN_TTL", "15m"),
  refreshTokenTtl: str("REFRESH_TOKEN_TTL", "7d"),

  corsOrigin: str("CORS_ORIGIN", "https://app.social.localhost"),
  cookieSecure: bool("COOKIE_SECURE", true),
  csrfEnabled: bool("CSRF_ENABLED", true),

  simEnabled: bool("SIM_ENABLED", true),
  simIntervalMs: int("SIM_INTERVAL_MS", 4000),
  simActionsPerTick: int("SIM_ACTIONS_PER_TICK", 1),
  simControlEnabled: bool("SIM_CONTROL_ENABLED", true),
} as const;

export type Config = typeof config;
