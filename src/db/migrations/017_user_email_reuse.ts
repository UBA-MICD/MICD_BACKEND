/**
 * Migration 017 — let a deleted user's email be invited again.
 *
 * User deletion is a soft-delete (status 'deleted'; the row is kept for the
 * audit trail and zenodo_config.created_by). Under the original
 * `UNIQUE (email)` that kept the address taken forever, so an admin could never
 * re-create someone they had removed. Uniqueness now applies only to rows that
 * are not deleted: at most ONE live account per email, any number of deleted
 * tombstones. A re-created user is a brand-new row (new id), never the old one
 * brought back.
 *
 * Every statement is idempotent (all migrations run on every boot):
 *   - drop whatever single-column UNIQUE constraint sits on users.email (its
 *     name differs on databases converged from the legacy marketplace schema);
 *   - create the partial unique index;
 *   - void any still-redeemable invite / password-reset code of an already
 *     deleted user, so a stale emailed link can't act on a tombstone.
 *
 * Seeds in 002/006 no longer rely on `ON CONFLICT (email)` (there is no full
 * unique index to infer any more) — they use `WHERE NOT EXISTS` instead.
 */
export const migration017 = {
  id: "017_user_email_reuse",
  sql: `
    DO $$
    DECLARE c record;
    BEGIN
      FOR c IN
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_attribute a
            ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
         WHERE con.conrelid = 'users'::regclass
           AND con.contype = 'u'
           AND a.attname = 'email'
           AND array_length(con.conkey, 1) = 1
      LOOP
        EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname);
      END LOOP;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS users_email_live_key
      ON users (email) WHERE status <> 'deleted';

    UPDATE user_invites SET consumed_at = NOW()
     WHERE consumed_at IS NULL
       AND user_id IN (SELECT id FROM users WHERE status = 'deleted');
    UPDATE password_resets SET consumed_at = NOW()
     WHERE consumed_at IS NULL
       AND user_id IN (SELECT id FROM users WHERE status = 'deleted');
  `,
};
