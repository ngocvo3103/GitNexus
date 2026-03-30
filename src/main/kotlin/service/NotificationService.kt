package service

fun notify(userId: String, message: String) {
    validateInput(userId)
    validateInput(message)
    sendEmail(userId, message)
}

fun sendEmail(to: String, body: String) {
    sanitizeInput(body)
    logRequest("email sent to $to")
    formatMessage(body)
}

fun sendAlert(message: String) {
    logRequest("alert: $message")
    formatError(message)
}
