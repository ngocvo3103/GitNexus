package helpers

fun formatResponse(data: Map<String, Any>): Map<String, Any> {
    return data + mapOf("formatted" to true, "status" to 200)
}

fun formatError(err: String): Map<String, Any> {
    return mapOf("status" to 500, "error" to err)
}

fun formatMessage(msg: String): String {
    return "[MSG] $msg"
}

fun formatDate(timestamp: Long): String {
    return timestamp.toString()
}
