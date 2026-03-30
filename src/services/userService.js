
const { formatUser } = require('./formatService');

function findById(id) {
  const user = { id, name: 'Test' };
  return formatUser(user);
}

function saveUser(user) {
  return { ...user, saved: true };
}

module.exports = { findById, saveUser };
