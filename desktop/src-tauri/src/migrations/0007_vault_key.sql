-- v7: the vault key. The vault's data is encrypted with one random vault key, no
-- longer with a key made from the master password. The vault key is kept wrapped
-- (AES-256-GCM, bound to the slot's kind) by each way of opening the vault: the
-- master password, and a recovery code. Changing the password re-wraps the vault key;
-- a forgotten password is replaced with the recovery code.
--
-- Additive: the table starts empty. A vault with no 'password' row is still encrypted
-- with its master password's key; it moves to a vault key at its next unlock
-- (vault.rs), after a verified backup, all or nothing.

CREATE TABLE key_slots (
  kind TEXT PRIMARY KEY CHECK (kind IN ('password', 'recovery')),
  -- The recovery code's own Argon2id parameters (the password's are in
  -- vault_metadata): NULL for 'password'.
  kdf_salt BLOB CHECK (kdf_salt IS NULL OR length(kdf_salt) = 16),
  argon2_iterations INTEGER CHECK (argon2_iterations IS NULL OR argon2_iterations > 0),
  argon2_memory_size INTEGER CHECK (argon2_memory_size IS NULL OR argon2_memory_size > 0),
  argon2_parallelism INTEGER CHECK (argon2_parallelism IS NULL OR argon2_parallelism > 0),
  argon2_hash_length INTEGER CHECK (argon2_hash_length IS NULL OR argon2_hash_length > 0),
  -- The vault key, sealed with this slot's key: iv || ciphertext || tag (60 bytes).
  wrapped_key BLOB NOT NULL CHECK (length(wrapped_key) = 60),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
