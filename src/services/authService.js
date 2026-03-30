
function hashPassword(password) {
  return 'hashed_' + password;
}

function createToken(username) {
  return 'token_' + username + '_' + Date.now();
}

function verifyToken(token) {
  return token.startsWith('token_');
}

module.exports = { hashPassword, createToken, verifyToken };
