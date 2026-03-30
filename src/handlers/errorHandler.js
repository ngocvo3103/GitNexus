
const { logError } = require('../helpers/logger');

function handleError(err) {
  logError(err.message);
  return { error: err.message };
}

function formatError(err) {
  logError('format: ' + err.message);
  return { code: err.code || 500, message: err.message };
}

module.exports = { handleError, formatError };
