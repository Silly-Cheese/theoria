import {
  auth, db, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, updateProfile,
  doc, getDoc, setDoc, serverTimestamp
} from "./firebase.js";

const state = { role: "student", user: null, profile: null };
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const authShell = $("#authShell");
const appShell = $("#appShell");
const authError = $("#authError");
const signInForm = $("#signInForm");
const registerForm = $("#registerForm");
const sidebar = $("#sidebar");
const toast = $("#toast");

function showToast(message){
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function humanizeFirebaseError(error){
  const code = error && error.code ? error.code : "";
  const map = {
    "auth/invalid-credential":"The email or password is incorrect.",
    "auth/email-already-in-use":"An account already exists with this email.",
    "auth/weak-password":"Choose a stronger password with at least six characters.",
    "auth/invalid-email":"Enter a valid email address.",
    "auth/too-many-requests":"Too many attempts were made. Please try again later."
  };
  return map[code] || (error && error.message) || "Something went wrong. Please try again.";
}

function switchAuthTab(tab){
  const register = tab === "register";
  $$(".auth-tab").forEach(btn => btn.classList.toggle("active", btn.dataset.authTab === tab));
  signInForm.classList.toggle("hidden", register);
  registerForm.classList.toggle("hidden", !register);
  $("#authHeading").textContent = register ? "Begin your studies." : "Welcome back.";
  $("#authIntro").textContent = register
    ? "Create an account for your Theoria academic environment."
    : "Sign in to continue to your sections, academic work, and progress.";
  authError.textContent = "";
}

async function loadProfile(user){
  const snap = await getDoc(doc(db,"users",user.uid));
  if(snap.exists()) return snap.data();
  return {
    displayName:user.displayName || (user.email ? user.email.split("@")[0] : "Theoria User"),
    email:user.email,
    role:"student"
  };
}

function applyRole(role){
  const instructor = role === "instructor";
  $$(".instructor-only").forEach(el => el.classList.toggle("hidden", !instructor));
  $$(".student-only").forEach(el => el.classList.toggle("hidden", instructor));
  $("#profileRole").textContent = instructor ? "Instructor" : "Student";
  $("#welcomeSubtitle").textContent = instructor
    ? "Manage your theological courses, sections, assessments, and academic records."
    : "Your theological studies, sections, academic work, and progress in one place.";
}

function renderUser(user,profile){
  const name = (profile && profile.displayName) || user.displayName || (user.email ? user.email.split("@")[0] : "Theoria User");
  const first = name.trim().split(/\s+/)[0];
  $("#profileName").textContent = name;
  $("#profileAvatar").textContent = (name.trim()[0] || "T").toUpperCase();
  $("#welcomeTitle").textContent = "Welcome, " + first + ".";
  state.role = profile && profile.role === "instructor" ? "instructor" : "student";
  applyRole(state.role);
}

function setPage(page){
  $$(".page").forEach(el => el.classList.toggle("active", el.id === "page-" + page));
  $$(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.page === page));
  const active = document.querySelector('.nav-item[data-page="' + page + '"]');
  $("#breadcrumbCurrent").textContent = active ? active.textContent.trim() : page.charAt(0).toUpperCase()+page.slice(1);
  sidebar.classList.remove("open");
  window.scrollTo({top:0,behavior:"smooth"});
}

$$(".auth-tab").forEach(btn => btn.addEventListener("click",() => switchAuthTab(btn.dataset.authTab)));

$$(".role-option").forEach(btn => {
  btn.addEventListener("click",() => {
    state.role = btn.dataset.role;
    $$(".role-option").forEach(option => option.classList.toggle("selected", option === btn));
  });
});

signInForm.addEventListener("submit",async event => {
  event.preventDefault();
  authError.textContent = "";
  const button = signInForm.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "Signing in…";
  try{
    await signInWithEmailAndPassword(auth,$("#signInEmail").value.trim(),$("#signInPassword").value);
  }catch(error){
    authError.textContent = humanizeFirebaseError(error);
  }finally{
    button.disabled = false;
    button.textContent = "Sign in to Theoria";
  }
});

registerForm.addEventListener("submit",async event => {
  event.preventDefault();
  authError.textContent = "";
  const name = $("#registerName").value.trim();
  const email = $("#registerEmail").value.trim();
  const password = $("#registerPassword").value;
  const button = registerForm.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "Creating account…";
  try{
    const credential = await createUserWithEmailAndPassword(auth,email,password);
    await updateProfile(credential.user,{displayName:name});
    await setDoc(doc(db,"users",credential.user.uid),{
      displayName:name,
      email:email,
      role:state.role,
      createdAt:serverTimestamp(),
      updatedAt:serverTimestamp()
    });
  }catch(error){
    authError.textContent = humanizeFirebaseError(error);
  }finally{
    button.disabled = false;
    button.textContent = "Create Theoria account";
  }
});

$("#signOutBtn").addEventListener("click",async () => {
  await signOut(auth);
  showToast("Signed out of Theoria.");
});

$("#mobileMenuBtn").addEventListener("click",() => sidebar.classList.toggle("open"));
$$(".nav-item").forEach(btn => btn.addEventListener("click",() => setPage(btn.dataset.page)));
$$("[data-go]").forEach(btn => btn.addEventListener("click",() => setPage(btn.dataset.go)));

$("#quickJoinBtn").addEventListener("click",() => {
  setPage("sections");
  setTimeout(() => { const el=$("#joinCodeInput"); if(el) el.focus(); },50);
});

$("#quickCreateBtn").addEventListener("click",() => {
  setPage("sections");
  showToast("Section creation arrives in Phase 2.");
});

const createCourseBtn = $("#createCourseBtn");
if(createCourseBtn) createCourseBtn.addEventListener("click",() => showToast("Course creation arrives in Phase 2."));
const createSectionBtn = $("#createSectionBtn");
if(createSectionBtn) createSectionBtn.addEventListener("click",() => showToast("Section creation arrives in Phase 2."));

$("#joinCodeBtn").addEventListener("click",() => {
  const code = $("#joinCodeInput").value.trim().toUpperCase();
  if(!code) return showToast("Enter the join code provided by your instructor.");
  showToast("Join-code verification will be activated in Phase 2.");
});

$("#joinCodeInput").addEventListener("input",event => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g,"");
});

onAuthStateChanged(auth,async user => {
  state.user = user;
  if(!user){
    state.profile = null;
    authShell.classList.remove("hidden");
    appShell.classList.add("hidden");
    return;
  }
  try{
    state.profile = await loadProfile(user);
  }catch(error){
    console.error("Unable to load Theoria profile:",error);
    state.profile = {
      displayName:user.displayName || "Theoria User",
      email:user.email,
      role:"student"
    };
  }
  renderUser(user,state.profile);
  authShell.classList.add("hidden");
  appShell.classList.remove("hidden");
  setPage("home");
});
