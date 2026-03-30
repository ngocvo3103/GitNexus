package data

fun dbQuery(sql: String): Map<String, Any> {
    logRequest("query: $sql")
    return mapOf("rows" to emptyList<Any>())
}

fun dbExecute(sql: String): Boolean {
    logRequest("execute: $sql")
    return true
}

fun dbConnect(url: String): Boolean {
    return true
}

fun dbClose() {
}
