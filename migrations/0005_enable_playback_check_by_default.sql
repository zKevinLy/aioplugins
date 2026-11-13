-- The playback check ("remove streams that cannot be played") is now on by
-- default. Saved settings are stored in full, so anyone who saved before has
-- "enabled": false written down, which would keep it off. Turn it on for every
-- saved setup. This also turns it on for anyone who switched it off on
-- purpose; they can untick it again in the editor.
UPDATE user_config
SET settings = json_set(settings, '$.probe.enabled', json('true'))
WHERE json_valid(settings)
  AND json_type(settings, '$.probe') = 'object';
