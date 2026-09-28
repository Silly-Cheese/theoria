import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  writeBatch,
  Timestamp,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAMAHfaKZOqMxFsTENzTx6XzfHtqGQl6RM",
  authDomain: "theoria-79433.firebaseapp.com",
  projectId: "theoria-79433",
  messagingSenderId: "177649286844",
  appId: "1:177649286844:web:c978ed8f99aed6dc62dab9"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export {
  app, auth, db,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where, orderBy, writeBatch, Timestamp,
  serverTimestamp
};
