//! 构建期嵌进程序的分享 Worker 脚本与建表 SQL。

pub const WORKER_SCRIPT: &str = include_str!("../../../assets/file-locker.js");
pub const LOCKER_MIGRATION_SQL: &str = include_str!("../../../assets/0001_locker.sql");
const COMPATIBILITY_DATE_RAW: &str = include_str!("../../../assets/compatibility_date.txt");

pub const SCRIPT_NAME: &str = "file-locker";
pub const D1_NAME: &str = "file-locker";
pub const D1_BINDING: &str = "DB";
pub const R2_BINDING: &str = "LOCKER_BUCKET";
pub const HMAC_SECRET_NAME: &str = "LOCKER_HMAC_SECRET";
pub const CRON: &str = "* * * * *";

pub fn compatibility_date() -> &'static str {
    COMPATIBILITY_DATE_RAW.trim()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_sql_has_locker_table_without_if_not_exists() {
        assert!(LOCKER_MIGRATION_SQL.contains("CREATE TABLE locker"));
        assert!(
            !LOCKER_MIGRATION_SQL.to_ascii_uppercase().contains("IF NOT EXISTS"),
            "0001_locker.sql 不能带 IF NOT EXISTS，第 5 步必须先探后建"
        );
    }

    #[test]
    fn embedded_worker_looks_like_file_locker() {
        assert!(WORKER_SCRIPT.contains("file-locker"));
        assert!(WORKER_SCRIPT.len() > 1000);
        assert_eq!(compatibility_date(), "2026-10-01");
    }
}
