-- Add customisable visibility settings to share tokens
ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{"showChart": true, "showLog": true, "showItemLabels": true}';
