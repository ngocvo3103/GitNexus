
function formatUser(user) {
  return { ...user, displayName: user.name.toUpperCase() };
}

function formatDate(date) {
  return new Date(date).toISOString();
}

function formatError(err) {
  return { error: true, message: String(err) };
}

module.exports = { formatUser, formatDate, formatError };
