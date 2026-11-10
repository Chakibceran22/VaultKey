-- v4: the group an account is shown in on the Accounts page (Games, Money…), when
-- it was chosen by hand. Accounts without a row here are grouped by a guess made
-- in the UI from their website's name, so improving that guess needs no migration.
-- Additive only: no existing table or row is touched.
CREATE TABLE account_categories (
  account_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES credentials(id) ON DELETE CASCADE
) STRICT;
