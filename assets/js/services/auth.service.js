import { auth, googleProvider, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "../core/firebase.js";
import { api } from "../core/api.js";
import { cleanText } from "../core/utils.js";

export async function loginEmail(email, password) {
  email = cleanText(email); password = cleanText(password);
  if (!email || !password) throw new Error("اكتب الإيميل وكلمة السر");
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (e) {
    if (String(e.code || e.message).includes("auth/invalid-credential") || String(e.code || e.message).includes("auth/user-not-found")) {
      await createUserWithEmailAndPassword(auth, email, password);
    } else throw e;
  }
  await api.syncProfile({});
}
export async function loginGoogle() {
  await signInWithPopup(auth, googleProvider);
  await api.syncProfile({});
}
export async function logout() { await signOut(auth); }
