
function validateInput(input) {
  if (!input) throw new Error('Required');
  return true;
}

function validateEmail(email) {
  return /^[^@]+@[^@]+$/.test(email);
}

function sanitize(str) {
  return String(str).replace(/[<>]/g, '');
}

module.exports = { validateInput, validateEmail, sanitize };
