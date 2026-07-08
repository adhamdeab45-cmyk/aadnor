import { auth, db, ref, onAuthStateChanged, onValue } from "./firebase.js";
import { api } from "./api.js";

export const state = {
  user: null,
  profile: null,
  agent: null,
  unsubProfile: null,
  listeners: new Set()
};

export function watchState(fn) {
  state.listeners.add(fn);
  fn(state);
  return () => state.listeners.delete(fn);
}
function emit() { state.listeners.forEach(fn => fn(state)); }

export function initAuthState({ agentMode = false } = {}) {
  return onAuthStateChanged(auth, async (user) => {
    state.user = user || null;
    state.profile = null;
    state.agent = null;
    if (state.unsubProfile) state.unsubProfile();
    state.unsubProfile = null;
    emit();
    if (!user) return;
    if (!agentMode) {
      try { await api.syncProfile({}); } catch (_) {}
      state.unsubProfile = onValue(ref(db, `users/${user.uid}`), snap => {
        state.profile = snap.val() || null;
        emit();
      });
    } else {
      state.unsubProfile = onValue(ref(db, `agents/${user.uid}`), snap => {
        state.agent = snap.val() || null;
        emit();
      });
    }
  });
}
