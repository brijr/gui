-- Connecting GitHub saves nothing to the account until the Gui that started it trades its
-- one-time code. Until then the GitHub user and tokens wait here, encrypted like `users`'
-- tokens, and go when the attempt is used, cancelled, or swept after it expires.
ALTER TABLE auth_attempts ADD COLUMN pending_connection TEXT;
