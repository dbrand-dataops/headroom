-- Seed default configuration
-- signup_mode controls what tier new users receive on registration

INSERT INTO config (key, value) VALUES
  ('signup_mode', '"launch"'),
  ('launch_tier', '"full"'),
  ('freemium_tier', '"free"'),
  ('donation_amounts', '[300, 500, 1000]'),
  ('donation_enabled', 'true'),
  ('subscription_enabled', 'false'),
  ('subscription_price_monthly_pence', '399'),
  ('max_items_free', '5'),
  ('max_history_days_free', '7'),
  ('registration_consent_text', '"By creating an account you agree that Headroom will store your email address, an encrypted version of your password, and the bucket entries you log. This data is used solely to provide the service. You can export or permanently delete all your data at any time from your account settings. Your data is stored on servers in the EU/US operated by Render. No data is shared with third parties except Stripe for payment processing if you choose to make a donation or subscription."')
ON CONFLICT (key) DO NOTHING;
