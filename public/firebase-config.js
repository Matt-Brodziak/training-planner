// STEP 4 of the README: paste your Firebase web app config here.
// Firebase console -> Project settings (gear) -> General -> Your apps -> Web app -> "SDK setup and configuration" -> Config.
//
// These values are NOT secret (every Firebase web app ships them to the browser).
// Your data is protected by Google sign-in + firestore.rules, and your Garmin key never goes here.
export const firebaseConfig = {
  apiKey: "AIzaSyBd8pBpD5GxCDlQx3A-wRr7c-0KhNfX2zM",

  authDomain: "matt-training-2a84a.web.app",

  projectId: "matt-training-2a84a",

  storageBucket: "matt-training-2a84a.firebasestorage.app",

  messagingSenderId: "49948039229",

  appId: "1:49948039229:web:3be94ee0374e832d853254",

  measurementId: "G-DS3BSKKYTZ"

};

// Must match REGION in functions/index.js
export const FUNCTIONS_REGION = "europe-west1";
