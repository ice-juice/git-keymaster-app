//! D1 建表：先查 sqlite_master，已有 locker 则跳过。0001_locker.sql 没有 IF NOT EXISTS。

pub fn locker_table_exists(names: &[String]) -> bool {
    names.iter().any(|n| n == "locker")
}

pub fn should_apply_locker_migration(names: &[String]) -> bool {
    !locker_table_exists(names)
}

pub fn sqlite_master_probe_sql() -> &'static str {
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'locker'"
}

/// 去掉行注释后按分号切开，供 API Token 路径逐条执行。
pub fn split_sql_statements(sql: &str) -> Vec<String> {
    let without_line_comments: String = sql
        .lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");
    without_line_comments
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// 从 Cloudflare / wrangler 的 D1 JSON 里抽出 sqlite_master 的 name 列。
pub fn names_from_d1_json(value: &serde_json::Value) -> Vec<String> {
    let mut names = Vec::new();
    collect_names(value, &mut names);
    names
}

fn collect_names(value: &serde_json::Value, names: &mut Vec<String>) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                collect_names(item, names);
            }
        }
        serde_json::Value::Object(map) => {
            if let Some(name) = map.get("name").and_then(|v| v.as_str()) {
                if !name.is_empty() && !names.iter().any(|n| n == name) {
                    names.push(name.to_string());
                }
            }
            for (k, v) in map {
                if matches!(k.as_str(), "result" | "results" | "rows") {
                    collect_names(v, names);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skip_when_locker_already_in_master() {
        assert!(locker_table_exists(&["locker".into()]));
        assert!(!should_apply_locker_migration(&["locker".into()]));
        assert!(!locker_table_exists(&["d1_migrations".into()]));
        assert!(should_apply_locker_migration(&[]));
        assert!(should_apply_locker_migration(&["other".into()]));
    }

    #[test]
    fn split_embedded_sql_into_create_table_and_index() {
        let sql = include_str!("../../../assets/0001_locker.sql");
        let stmts = split_sql_statements(sql);
        assert_eq!(stmts.len(), 2);
        assert!(stmts[0].starts_with("CREATE TABLE locker"));
        assert!(stmts[1].starts_with("CREATE INDEX"));
        assert!(!stmts.iter().any(|s| s.to_ascii_uppercase().contains("IF NOT EXISTS")));
    }

    #[test]
    fn parse_master_names_from_cf_and_wrangler_shapes() {
        let cf = serde_json::json!({
            "result": [{ "results": [{ "name": "locker" }], "success": true }]
        });
        assert_eq!(names_from_d1_json(&cf), vec!["locker"]);

        let wrangler = serde_json::json!([
            { "results": [{ "name": "locker" }] }
        ]);
        assert_eq!(names_from_d1_json(&wrangler), vec!["locker"]);
        assert!(names_from_d1_json(&serde_json::json!({"result":[]})).is_empty());
    }
}
