package helpers

fun validateInput(input: String): Boolean {
    if (input.isEmpty()) throw IllegalArgumentException("Invalid")
    return true
}

fun sanitizeInput(input: String): String {
    return input.replace("<", "").replace(">", "")
}

fun checkLength(input: String, max: Int = 255): Boolean {
    return input.length <= max
}

fun normalizeInput(input: String): String {
    return input.trim().lowercase()
}
