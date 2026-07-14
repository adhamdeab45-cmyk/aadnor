window.ADNOR_CONFIG = {
  version: 'V302_FIREBASE_ONLY',
  functionsRegion: 'us-central1',
  firebase: {
    apiKey: 'AIzaSyC3QDYwjgPWHkd8hM9l1RNpUIzdywOwv1g',
    authDomain: 'adhamnnn-8a4d2.firebaseapp.com',
    databaseURL: 'https://adhamnnn-8a4d2-default-rtdb.firebaseio.com',
    projectId: 'adhamnnn-8a4d2',
    storageBucket: 'adhamnnn-8a4d2.firebasestorage.app',
    messagingSenderId: '812431761704',
    appId: '1:812431761704:web:2b85a0532574cc4378301d',
    measurementId: 'G-59WKJBRDG8'
  },
  defaults: {
    currency: 'USD',
    drawType: 'daily',
    siteName: 'ADNOR'
  }
};

(function initFirebase(){
  if (!window.firebase) throw new Error('Firebase SDK failed to load.');
  if (!firebase.apps.length) firebase.initializeApp(window.ADNOR_CONFIG.firebase);
  let analytics=null;
  try { if (typeof firebase.analytics === 'function') analytics=firebase.analytics(); } catch (e) { console.warn('Analytics unavailable',e); }
  window.ADNOR = {
    app: firebase.app(),
    auth: firebase.auth(),
    db: firebase.database(),
    storage: firebase.storage(),
    analytics
  };
  ADNOR.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(console.warn);
})();
