package helpers

fun logRequest(msg: String) {
    println("[REQ] $msg")
}

fun logError(msg: String) {
    System.err.println("[ERR] $msg")
}

fun logInfo(msg: String) {
    println("[INFO] $msg")
}

fun createLogEntry(level: String, msg: String): Map<String, Any> {
    return mapOf("level" to level, "msg" to msg, "ts" to System.currentTimeMillis())
}
