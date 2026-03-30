package service

fun authenticate(username: String, password: String): Map<String, Any> {
    validateInput(username)
    validateInput(password)
    val user = findUser(username)
    val hash = hashPassword(password)
    return formatResponse(mapOf("user" to user, "token" to createToken(username)))
}

fun hashPassword(password: String): String {
    validateInput(password)
    return "hashed_$password"
}

fun createToken(username: String): String {
    validateInput(username)
    logRequest("token created for $username")
    return "token_$username"
}

fun verifyToken(token: String): Boolean {
    validateInput(token)
    return token.startsWith("token_")
}

fun refreshToken(token: String): String {
    verifyToken(token)
    return createToken("refreshed")
}
