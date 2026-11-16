use super::{create_migration_backup, Connection, Path, Result};

pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let _backup = create_migration_backup(conn, path, 32)?;
    let tx = conn.unchecked_transaction()?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name='context_window_limit')",
        [], |row| row.get(0),
    )?;
    if !exists {
        tx.execute_batch("ALTER TABLE sessions ADD COLUMN context_window_limit INTEGER
            CHECK (context_window_limit IS NULL OR context_window_limit IN (32000,64000,128000,256000,1000000));")?;
    }
    tx.pragma_update(None, "user_version", 33)?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migration_backup_path, Database, SCHEMA_VERSION};
    use crate::sessions::{create_session, get_session};

    #[test]
    fn session_context_v32_migration_preserves_history_defaults_and_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let id = {
            let db = Database::open(&path).unwrap();
            let session = create_session(&db, Some("Kept".into()), None, None, None, None).unwrap();
            db.conn().execute_batch("ALTER TABLE sessions DROP COLUMN context_window_limit; PRAGMA user_version=32;").unwrap();
            session.id
        };
        let db = Database::open(&path).unwrap();
        let session = get_session(&db, &id).unwrap().unwrap();
        assert_eq!(session.summary.title, "Kept");
        assert_eq!(session.summary.context_window_limit, None);
        let backup = Connection::open(migration_backup_path(&path, 32)).unwrap();
        let version: i64 = backup
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 32);
        assert!(backup
            .prepare("SELECT context_window_limit FROM sessions")
            .is_err());
        drop(backup);
        db.conn()
            .execute(
                "UPDATE sessions SET context_window_limit=64000 WHERE id=?1",
                [&id],
            )
            .unwrap();
        assert!(db
            .conn()
            .execute(
                "UPDATE sessions SET context_window_limit=123 WHERE id=?1",
                [&id]
            )
            .is_err());
        // A partially upgraded fixture with the column already present stays idempotent.
        db.conn().pragma_update(None, "user_version", 32).unwrap();
        drop(db);
        let reopened = Database::open(&path).unwrap();
        assert_eq!(
            get_session(&reopened, &id)
                .unwrap()
                .unwrap()
                .summary
                .context_window_limit,
            Some(64000)
        );
        let version: i64 = reopened
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }
}
