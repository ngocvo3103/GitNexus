pub fn format_result(data: &str) -> String {
    format!("[formatted] {}", data)
}

pub fn serialize(data: &str) -> String {
    format!("{{"data": "{}"}}", data)
}

pub fn format_error(err: &str) -> String {
    format!("[ERROR] {}", err)
}
