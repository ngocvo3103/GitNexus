package service

fun findUser(id: String): Map<String, Any> {
    validateInput(id)
    val result = dbQuery("SELECT * FROM users WHERE id = $id")
    return formatResponse(result)
}

fun createUser(name: String): Map<String, Any> {
    validateInput(name)
    sanitizeInput(name)
    dbExecute("INSERT INTO users VALUES ('$name')")
    logRequest("user created")
    return formatResponse(mapOf("name" to name))
}

fun updateUser(id: String, name: String): Map<String, Any> {
    validateInput(id)
    validateInput(name)
    dbExecute("UPDATE users SET name = '$name' WHERE id = $id")
    logRequest("user updated")
    return formatResponse(mapOf("id" to id))
}

fun deleteUser(id: String): Boolean {
    validateInput(id)
    dbExecute("DELETE FROM users WHERE id = $id")
    logRequest("user deleted")
    return true
}
