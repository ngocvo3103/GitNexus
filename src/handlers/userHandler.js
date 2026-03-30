
const { findById } = require('../services/userService');
const { validateInput } = require('../helpers/validator');

function getUser(id) {
  validateInput(id);
  return findById(id);
}

function createUser(data) {
  validateInput(data.name);
  return { id: Date.now(), ...data };
}

module.exports = { getUser, createUser };
