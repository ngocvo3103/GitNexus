
const { hashPassword, createToken } = require('../services/authService');

function login(username, password) {
  const hashed = hashPassword(password);
  return createToken(username);
}

function logout(token) {
  return { success: true };
}

module.exports = { login, logout };
