// In-memory session storage for multi-step interactions.
// Sessions expire after 10 minutes to prevent memory leaks.

const sessions = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000;

function createSession(data) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const timerId = setTimeout(() => sessions.delete(id), SESSION_TTL_MS);
  sessions.set(id, { ...data, _timerId: timerId });
  return id;
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session) return null;
  const { _timerId, ...data } = session;
  return data;
}

function updateSession(id, patch) {
  const session = sessions.get(id);
  if (!session) return null;
  Object.assign(session, patch);
  return getSession(id);
}

function deleteSession(id) {
  const session = sessions.get(id);
  if (session) clearTimeout(session._timerId);
  sessions.delete(id);
}

module.exports = { createSession, getSession, updateSession, deleteSession };
