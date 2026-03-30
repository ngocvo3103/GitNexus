
function logError(msg) {
  console.error('[ERROR]', msg);
}

function logInfo(msg) {
  console.log('[INFO]', msg);
}

function createEntry(level, msg) {
  return { level, msg, ts: Date.now() };
}

module.exports = { logError, logInfo, createEntry };
