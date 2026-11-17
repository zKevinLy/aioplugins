-- Curated default plugins.
--
-- An admin maintains one shared selection of plugins (plus middleware
-- settings). Accounts that follow it are served that selection instead of
-- their own, so a change by the admin reaches them immediately.

-- Single row (id = 1). Empty until an admin publishes a selection.
CREATE TABLE IF NOT EXISTS curated_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sources TEXT NOT NULL DEFAULT '[]',
  settings TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- 1 = follows the curated default, 0 = uses the account's own selection.
-- New and existing accounts both default to following it.
ALTER TABLE users ADD COLUMN follow_curated INTEGER NOT NULL DEFAULT 1;

-- Following the curated default replaces what an account was serving, so keep
-- each existing selection as a saved profile. Nothing is lost, and it can be
-- loaded again from the Profiles panel after unsubscribing. Accounts that
-- already have a profile with this ID are left alone.
INSERT OR IGNORE INTO profiles (id, user_id, name, sources, updated_at)
SELECT 'pre-curated', user_id, 'Before curated plugins', sources, updated_at
FROM user_config
WHERE CASE WHEN json_valid(sources)
            THEN json_array_length(sources) > 0
            ELSE 0 END;
