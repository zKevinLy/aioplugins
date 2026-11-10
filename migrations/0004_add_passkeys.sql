CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS passkeys_user_id ON passkeys(user_id);

-- Single-use WebAuthn challenges (registration and login).
CREATE TABLE IF NOT EXISTS passkey_challenges (
  challenge TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  user_id TEXT,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS passkey_challenges_expires_at
ON passkey_challenges(expires_at);
