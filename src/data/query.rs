use crate::data::format::format_result;

pub fn run_query(sql: &str) -> String {
    let raw = format!("result_{}", sql);
    format_result(&raw)
}

pub fn build_query(table: &str) -> String {
    format!("SELECT * FROM {}", table)
}
