import { auth, db, doc, getDoc, functions, httpsCallable } from "./firebase.js";

// The unified workspace deliberately sits above the older administrative tools.
// The latter remain available for historical/advanced functions during migration.
const $ = selector => document.querySelector(selector);
const E = value => String(value ?? "").replace(/[&<>"']/g, ch =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const api = httpsCallable(functions, "institutionCommand");
const snapshotApi = httpsCallable(functions, "institutionSnapshot");
let institution = null, user = null, state = null, activeTab = "overview", loadingKey = 0, busy = false, legacyMounted = false;
const flash = message => {
  const el = $("#institutionNewMessage");
  if (el) { el.textContent = message; el.hidden = false; }
  else window.TheoriaDialog?.alert?.(message);
};
const action = (label, key, extra = "", buttonClass = "secondary-btn small-btn") =>
  '<button type="button" class="' + buttonClass + '" data-ias-action="' + E(key) + '" ' + extra + '>' + E(label) + '</button>';
const count = values => Array.isArray(values) ? values.length : 0;
const records = name => Array.isArray(state?.[name]) ? state[name] : [];
const selected = (id, label, values) =>
  '<label>' + E(label) + '<select name="' + E(id) + '" required>' +
  values.map(pair => '<option value="' + E(pair[0]) + '">' + E(pair[1]) + '</option>').join("") + '</select></label>';
const field = (id, label, type = "text", value = "", required = true) =>
  '<label>' + E(label) + '<input name="' + E(id) + '" type="' + E(type) + '" value="' +
  E(value) + '" ' + (required ? "required" : "") + ' maxlength="180"></label>';
const empty = message => '<div class="ias-empty">' + E(message) + '</div>';
const line = (title, subtitle, actions = "") =>
  '<article class="ias-entry"><div><strong>' + E(title) + '</strong><p>' + E(subtitle) +
  '</p></div><div class="ias-entry-actions">' + actions + '</div></article>';
const list = (items, renderer, message) =>
  items.length ? items.map(renderer).join("") : empty(message || "No records to display.");
const studentName = uid => records("members").find(x => x.studentUid === uid)?.studentName ||
  records("applications").find(x => x.studentUid === uid)?.studentName || uid;
const offeringName = offeringId =>
  records("offerings").find(o => o.id === offeringId)?.title || offeringId;
const tabs = [
  ["overview", "Overview", "layout-dashboard"], ["admissions", "Admissions", "clipboard-list"],
  ["students", "Students", "users"], ["registration", "Registration", "book-open-check"],
  ["academics", "Academic setup", "calendar-days"], ["staff", "Faculty & staff", "shield-check"],
  ["district", "District & affiliations", "building-2"], ["reports", "Reporting", "bar-chart-3"],
  ["history", "Audit history", "history"]
];
async function load() {
  if (!institution || !user) return;
  const key = ++loadingKey, root = $("#institutionAdminNew");
  if (!root) return;
  root.innerHTML = '<section class="ias-workspace"><p class="ias-muted">Loading secure institutional records…</p></section>';
  try {
    const result = await snapshotApi({ institutionId: institution.id });
    if (key !== loadingKey || !institution || institution.id !== result.data.institution.id) return;
    state = result.data;
    render();
  } catch (error) {
    if (key !== loadingKey) return;
    state = null;
    root.innerHTML = '<section class="ias-workspace"><h2>Institution administration</h2>' +
      '<p class="ias-muted">This workspace is only available to authorized staff. ' +
      'Students can use the school catalog above.</p>' +
      '<p class="ias-notice">' + E(error.message || "Unable to load workspace.") + '</p>' +
      '<div id="iasStudentTools"></div></section>';
    await studentTools();
  }
}
async function studentTools() {
  const host = $("#iasStudentTools");
  if (!host || !institution || !user) return;
  try {
    const invitationEmail = String(user.email || "").trim().toLowerCase();
    if (invitationEmail) {
      const invitation = await getDoc(doc(db, "institutions", institution.id, "invitations", invitationEmail));
      if (invitation.exists() && invitation.data().status === "pending") {
        host.innerHTML += '<div class="ias-notice"><strong>Staff invitation pending</strong><p>You were invited to ' +
          E(institution.name) + ' as ' + E(invitation.data().role) + '.</p>' +
          action("Accept invitation", "acceptInvite", "", "primary-btn small-btn") + '</div>';
      }
    }
  } catch (error) { console.warn("Institution staff invitation", error); }
  if (institution.kind !== "school") return;
  const profile = await getDoc(doc(db, "users", user.uid));
  if (profile.data()?.role !== "student") return;
  host.innerHTML += '<div class="ias-apply"><h3>Apply to this school</h3>' +
    '<p>Submit an application for review by the admissions team. If you already requested school membership, that request will still be reviewed.</p>' +
    '<form id="iasApplyForm" class="ias-form">' + field("gradeLevel", "Grade / academic level", "text", "", false) +
    field("program", "Intended program", "text", "", false) +
    '<label>Additional information<textarea name="notes" maxlength="1500" rows="3"></textarea></label>' +
    '<button class="primary-btn" type="submit">Submit application</button></form></div>';
}
function render() {
  const root = $("#institutionAdminNew");
  if (!root || !state) return;
  document.body.classList.add("theoria-institution-upgraded");
  root.innerHTML = '<section class="ias-workspace">' +
    '<div class="ias-head"><div><div class="eyebrow">Theoria · Institutional Operations</div>' +
    '<h2>' + E(state.institution.name) + '</h2><p class="ias-muted">' +
    E(state.institution.kind === "district" ? "District leadership workspace" : "School command center") +
    ' · Role: ' + E(state.role.replaceAll("_", " ")) + '</p></div>' +
    '<div class="ias-tools">' + action("Refresh", "refresh") +
    action("Additional tools", "legacy") + '</div></div>' +
    '<div id="institutionNewMessage" class="ias-notice" role="status" hidden></div>' +
    '<div class="ias-nav" role="tablist" aria-label="Institution operations">' +
    tabs.map(([key, name]) => '<button type="button" role="tab" aria-selected="' +
      (activeTab === key) + '" class="' + (activeTab === key ? "active" : "") +
      '" data-ias-tab="' + key + '">' + E(name) + '</button>').join("") + '</div>' +
    '<div id="iasContent">' + body() + '</div></section>';
}
function tile(value, label) {
  return '<div class="ias-tile"><strong>' + E(value) + '</strong><span>' + E(label) + '</span></div>';
}
function body() {
  if (activeTab === "overview") {
    const active = records("members").filter(x => x.status === "active").length;
    return '<div class="ias-stat-grid">' + tile(active, "Active memberships (loaded)") +
      tile(records("applications").filter(x => x.status === "pending").length, "Pending applications") +
      tile(records("requests").filter(x => x.status === "pending").length, "Course requests") +
      tile(records("registrations").filter(x => x.status === "active").length, "Active registrations (loaded)") +
      '</div><div class="ias-two-column"><section><h3>Review queue</h3>' +
      list(records("applications").filter(x => x.status === "pending").slice(0,8),
        x => line(x.studentName, "New admissions application", action("Review", "admission", 'data-uid="' + E(x.studentUid) + '"')),
        "No outstanding admissions applications.") + '</section><section><h3>Institution essentials</h3>' +
      '<p class="ias-muted">School enrollment, course placement, academic years, faculty assignments, and student history share one workspace.</p>' +
      action("Edit institution", "editInstitution") + action("Enrollment policies", "policies") +
      (state.role === "owner" ? action("Archive institution", "archiveInstitution") : "") +
      '<p class="ias-small">All counts are limited to the first 80 records per category. Use reports/export tools for larger populations.</p></section></div>';
  }
  if (activeTab === "admissions") return '<div class="ias-section-head"><h3>Admissions & membership review</h3></div>' +
    '<h4>Applications</h4>' +
    list(records("applications").filter(x => x.status === "pending"),
      x => line(x.studentName, [x.gradeLevel, x.program, x.notes].filter(Boolean).join(" · ") || "Awaiting review",
        action("Approve", "decideAdmission", 'data-uid="' + E(x.studentUid) + '" data-decision="approve"') +
        action("Decline", "decideAdmission", 'data-uid="' + E(x.studentUid) + '" data-decision="decline"')),
      "No pending applications.") +
    '<h4>Existing membership requests</h4>' +
    list(records("members").filter(x => x.status === "pending"),
      x => line(x.studentName || x.studentUid, "Pending institution membership",
        action("Approve", "decideMembership", 'data-uid="' + E(x.studentUid) + '" data-decision="approve"') +
        action("Decline", "decideMembership", 'data-uid="' + E(x.studentUid) + '" data-decision="decline"')),
      "No membership requests.");
  if (activeTab === "students") return '<div class="ias-section-head"><h3>Students & annual enrollment</h3>' +
    action("Rollover academic year", "rollover") + action("Transfer student", "transferStudent") + '</div>' +
    list(records("members").filter(x => x.status === "active"), x => {
      const enrollment = records("academicEnrollments").find(y => y.studentUid === x.studentUid);
      return line(x.studentName || x.studentUid, "UID: " + x.studentUid +
        " · " + (enrollment?.academicYear || "Academic year not assigned") +
        (enrollment?.gradeLevel ? " · " + enrollment.gradeLevel : ""));
    }, "No active students.");
  if (activeTab === "registration") {
    const ready = records("members").filter(x => x.status === "active");
    return '<div class="ias-section-head"><h3>Course registration & class rosters</h3>' +
      action("Publish offering", "createOffering") + action("Register students", "register") + action("Bulk enroll", "bulkRegister") + '</div>' +
      '<h4>Published course offerings</h4>' + list(records("offerings"), o =>
        line((o.code || "") + " · " + o.title,
          "Term: " + (o.term || "Unassigned") + " · Seats: " + (o.seatsTaken || 0) +
          "/" + (o.capacity || "Unlimited") + " · Section: " + (o.sectionId || "Not linked"),
          action("Link section", "linkOffering", 'data-offering="' + E(o.id) + '"')),
        "No course offerings; publish one using the school catalog above.") +
      '<h4>Outstanding course requests</h4>' + list(records("requests").filter(r => r.status === "pending"),
        r => line(studentName(r.studentUid), offeringName(r.offeringId),
          action("Approve", "decideRequest", 'data-id="' + E(r.id) + '" data-decision="approved"') +
          action("Decline", "decideRequest", 'data-id="' + E(r.id) + '" data-decision="declined"')),
        "No outstanding course requests.") +
      '<h4>Active registrations</h4>' +
      list(records("registrations").filter(x => x.status === "active"),
        r => line(studentName(r.studentUid), offeringName(r.offeringId) + " · " + (r.term || ""),
          action("Withdraw", "withdraw", 'data-offering="' + E(r.offeringId) + '" data-uid="' + E(r.studentUid) + '"')),
        "No active registrations.") +
      '<p class="ias-small">Students admitted: ' + ready.length +
      '. Registered sections are written atomically to course rosters and the student dashboard.</p>';
  }
  if (activeTab === "academics") return '<div class="ias-section-head"><h3>Academic years & programs</h3>' +
    action("Add academic term", "newTerm") + action("Add department", "newDepartment") + '</div>' +
    '<h4>Academic terms</h4>' + list(records("terms"), t => line(t.title, t.startDate + " – " + t.endDate), "No terms recorded.") +
    '<h4>Departments</h4>' + list(records("departments"), d => line(d.name, d.description || ""), "No departments recorded.") +
    '<p class="ias-muted">Advanced scheduling, grade certification and guardian communication remain accessible under Additional tools.</p>';
  if (activeTab === "staff") return '<div class="ias-section-head"><h3>Faculty & staff access</h3>' +
    action("Invite staff", "inviteStaff") + '</div>' +
    list(records("staff"), s => line(s.displayName || s.email, s.role + " · " + s.email,
      state.role === "owner" ? action("Revoke role", "removeStaff", 'data-uid="' + E(s.uid) + '"') : ""),
      "No active staff assigned.") +
    '<h4>Pending invitations</h4>' +
    list(records("invitations").filter(x => x.status === "pending"),
      inv => line(inv.email, "Role: " + inv.role), "No outstanding invitations.");
  if (activeTab === "district") return '<div class="ias-section-head"><h3>District governance</h3>' +
    (state.institution.kind === "school" ? action("Request affiliation", "requestDistrict") :
      state.role === "owner" ? action("Create district school", "createSchool") : "") + '</div>' +
    (state.institution.kind === "district"
      ? '<h4>Schools in district</h4>' +
        list(state.schools || [], school => line(school.name, school.verified ? "Verified institution" : "Unverified institution"),
          "No schools linked.") +
        '<h4>Affiliation requests</h4>' +
        list(records("districtRequests").filter(r => r.status === "pending"), r =>
          line(r.schoolName || r.schoolId, "School ID: " + r.schoolId,
            action("Accept school", "acceptDistrict", 'data-school="' + E(r.schoolId) + '"')), "No requests.")
      : '<p class="ias-muted">Schools can request affiliation with a district. The district must approve the relationship before district staff can administer the school.</p>' +
        '<p>Current district ID: <code>' + E(state.institution.parentDistrictId || "Independent") + '</code></p>');
  if (activeTab === "reports") {
    const byStatus = {};
    records("registrations").forEach(r => byStatus[r.status || "unknown"] = (byStatus[r.status || "unknown"] || 0) + 1);
    return '<div class="ias-section-head"><h3>Institutional summary</h3>' +
      action("Export loaded records", "export") + '</div><div class="ias-stat-grid">' +
      tile(count(records("members")), "Loaded memberships") +
      tile(count(records("offerings")), "Course offerings") +
      tile(count(records("staff")), "Assigned staff") +
      tile(count(records("academicEnrollments")), "Enrollment records") +
      '</div><h4>Registration states</h4>' +
      list(Object.entries(byStatus), x => line(x[0], x[1] + " students"), "No registrations.") +
      '<p class="ias-small">These summaries are not district-wide certified totals. Large institutions require paginated reporting.</p>';
  }
  if (activeTab === "history") return '<div class="ias-section-head"><h3>Administrative event history</h3></div>' +
    list(records("auditEvents").slice().reverse(),
      row => line(row.action || "Administrative action",
        (row.studentUid ? "Student " + row.studentUid + " · " : "") +
        (row.offeringId ? "Offering " + row.offeringId + " · " : "") +
        "Actor: " + (row.createdBy || "Unknown")), "No logged changes yet.");
  return "";
}
function modal(title, fields, save) {
  const root = $("#modalRoot");
  if (!root) return;
  root.innerHTML = '<div class="modal-backdrop institution-modal-backdrop"><div class="modal institution-dialog" role="dialog" aria-modal="true" aria-label="' +
    E(title) + '"><div class="modal-header"><h2>' + E(title) +
    '</h2><button type="button" class="secondary-btn" id="iasClose">Close</button></div>' +
    '<form id="iasForm" class="institution-form">' + fields +
    '<div id="iasFormError" role="alert"></div><button class="primary-btn" type="submit">Save</button></form></div></div>';
  $("#iasClose").onclick = () => { root.innerHTML = ""; };
  $("#iasForm").onsubmit = async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("[type=submit]");
    if (busy) return;
    busy = true; button.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const result = await save(values);
      root.innerHTML = "";
      await load();
      flash(result?.message || "Saved successfully.");
    } catch (error) {
      const el = $("#iasFormError"); if (el) el.textContent = error.message || "Unable to save.";
    } finally { busy = false; button.disabled = false; }
  };
}
const command = (actionName, payload = {}) => api({ action: actionName, institutionId: institution.id, ...payload }).then(r => r.data);
const idField = (name, label, value = "") => field(name, label, "text", value);
const chooser = (name, label, items) => selected(name, label, items.length ? items : [["", "No options available"]]);
async function handle(button) {
  if (!institution || !user || busy) return;
  const name = button.dataset.iasAction;
  if (name === "refresh") return load();
  if (name === "legacy") {
    document.body.classList.toggle("theoria-show-legacy");
    if (document.body.classList.contains("theoria-show-legacy") && !legacyMounted) {
      legacyMounted = true;
      window.TheoriaSchoolAdmin?.mount(institution, user);
    }
    button.textContent = document.body.classList.contains("theoria-show-legacy") ?
      "Hide additional tools" : "Additional tools";
    return;
  }
  if (name === "archiveInstitution") {
    if (state.role !== "owner") return;
    const confirmation = await window.TheoriaDialog?.confirm?.(
      "Archive this institution? Students will no longer find it in the active directory. Existing records will be preserved.");
    if (!confirmation) return;
    try { await command("archiveInstitution"); flash("Institution archived. Historical records are preserved."); }
    catch (error) { flash(error.message || "Archive failed."); }
    return load();
  }
  if (name === "removeStaff") {
    if (state.role !== "owner") return;
    if (!await window.TheoriaDialog?.confirm?.("Remove this staff member’s institutional access?")) return;
    try { await command("removeStaff", { staffUid: button.dataset.uid }); await load(); flash("Staff access revoked."); }
    catch (error) { flash(error.message || "Role revocation failed."); }
    return;
  }
  if (name === "acceptInvite") {
    await command("acceptInvitation", { email: user.email });
    await load(); flash("Staff role accepted."); return;
  }
  if (name === "editInstitution") return modal("Institution details",
    idField("name", "Institution name", state.institution.name) +
    '<label>Description<textarea name="description" maxlength="750">' +
    E(state.institution.description || "") + '</textarea></label>',
    values => command("updateInstitution", values));
  if (name === "policies") return modal("Enrollment policy",
    selected("requireAdmissionsReview", "Admissions approval", [["true", "Staff review required"], ["false", "Review not required (future automation)"]]) +
    selected("allowStudentApplications", "Student applications", [["true", "Enabled"], ["false", "Disabled"]]) +
    selected("registrationOpen", "Open registration", [["false", "Closed"], ["true", "Open"]]) +
    '<label>Admission instructions<textarea name="admissionInstructions" maxlength="600"></textarea></label>',
    values => command("setSetting", {
      requireAdmissionsReview: values.requireAdmissionsReview === "true",
      allowStudentApplications: values.allowStudentApplications === "true",
      registrationOpen: values.registrationOpen === "true",
      admissionInstructions: values.admissionInstructions
    }));
  if (name === "decideAdmission" || name === "decideMembership" || name === "decideRequest" ||
      name === "acceptDistrict" || name === "withdraw") {
    const choice = button.dataset.decision, uid = button.dataset.uid, requestId = button.dataset.id;
    const approved = await window.TheoriaDialog?.confirm?.("Confirm " + name.replaceAll("_", " ") + " action?");
    if (!approved) return;
    try {
      busy = true;
      if (name === "acceptDistrict") await command("approveDistrictLink", { schoolId: button.dataset.school });
      else if (name === "withdraw") await command("withdraw", { offeringId: button.dataset.offering, studentUid: uid });
      else await command(name, name === "decideRequest" ? { requestId, decision: choice } :
        { studentUid: uid, decision: choice });
      await load(); flash("Decision recorded.");
    } catch (error) { flash(error.message || "Action failed."); }
    finally { busy = false; }
    return;
  }
  if (name === "inviteStaff") return modal("Invite staff",
    field("email", "Institutional email", "email") +
    chooser("role", "Assigned role", [
      ["instructor", "Instructor"], ["registrar", "Registrar"], ["counselor", "Counselor"],
      ["department_head", "Department head"], ["staff", "Staff"],
      ["assistant_principal", "Assistant principal"], ["principal", "Principal"],
      ["district_admin", "District administrator"]
    ]), values => command("inviteStaff", values));
  if (name === "createOffering") return modal("Publish catalog course",
    idField("courseId", "Official published catalog course ID") +
    field("term", "Academic term") +
    field("openDate", "Registration opens", "date") +
    field("closeDate", "Registration closes", "date") +
    '<p class="ias-small">Theoria validates the official course and registration window on the server. You can copy the course ID from the Courses catalog.</p>',
    values => command("createOffering", values));
  if (name === "linkOffering") return modal("Link section to offering",
    idField("sectionId", "Existing Theoria section ID") +
    '<p class="ias-small">The section must teach the same course and belong to an institution-affiliated instructor.</p>',
    values => command("linkOffering", { offeringId: button.dataset.offering, sectionId: values.sectionId }));
  if (name === "register" || name === "bulkRegister") {
    const offerings = records("offerings").filter(o => o.sectionId);
    if (!offerings.length) return flash("Link a published offering to a teaching section first.");
    const members = records("members").filter(m => m.status === "active");
    if (!members.length) return flash("Approve a student membership first.");
    const selectOffering = chooser("offeringId", "Course offering", offerings.map(o => [o.id, o.title + " · " + o.term]));
    if (name === "register") return modal("Register student in class",
      chooser("studentUid", "Admitted student", members.map(s => [s.studentUid, s.studentName || s.studentUid])) +
      selectOffering, values => command("register", values));
    return modal("Bulk course registration", selectOffering +
      '<label>Student UIDs (comma or line separated, maximum 25)<textarea name="uids" rows="6" required></textarea></label>' +
      '<p class="ias-small">Each enrollment is a separate atomic transaction. Failed rows are reported explicitly.</p>',
      async values => {
        const ids = [...new Set(values.uids.split(/[,\n\s]+/).map(x => x.trim()).filter(Boolean))];
        if (!ids.length || ids.length > 25) throw Error("Provide 1–25 student UIDs.");
        const result = await command("bulkRegister", {
          items: ids.map(studentUid => ({ studentUid, offeringId: values.offeringId }))
        });
        const errors = result.results.filter(x => !x.ok);
        if (errors.length) return { message: result.results.filter(x => x.ok).length +
          " enrolled; " + errors.length + " failed: " + errors.map(x => x.studentUid + " (" + x.message + ")").join("; ") };
        return { message: "All " + ids.length + " students enrolled." };
      });
  }
  if (name === "rollover") return modal("Roll student to next academic year",
    chooser("studentUid", "Student", records("academicEnrollments").filter(x => x.status === "active")
      .map(s => [s.studentUid, s.studentName || s.studentUid])) +
    field("academicYear", "New academic year", "text", "2027–2028") +
    field("gradeLevel", "New grade / level", "text", "", false),
    values => command("rollover", values));
  if (name === "createSchool") return modal("Create district school",
    field("name", "New school name") +
    '<label>Description<textarea name="description" maxlength="750"></textarea></label>',
    values => command("createSchool", values));
  if (name === "transferStudent") return modal("Transfer student to another school",
    chooser("studentUid", "Currently enrolled student",
      records("members").filter(m => m.status === "active")
        .map(m => [m.studentUid, m.studentName || m.studentUid])) +
    idField("destinationId", "Destination Theoria school ID") +
    field("academicYear", "Destination academic year") +
    field("gradeLevel", "Destination grade / level", "text", "", false) +
    '<p class="ias-small">You must be authorized in both schools. Existing academic records remain with their origin school. Active registrations must be withdrawn first.</p>',
    values => command("transferStudent", values));
  if (name === "requestDistrict") return modal("Request district affiliation",
    idField("districtId", "Theoria district ID") +
    '<p class="ias-small">The district must explicitly approve the request.</p>',
    values => command("requestDistrictLink", values));
  if (name === "newTerm") return modal("Add academic term",
    field("title", "Term name") + field("startDate", "Starts", "date") + field("endDate", "Ends", "date"),
    values => command("createTerm", values));
  if (name === "newDepartment") return modal("Create department",
    field("name", "Department name") +
    '<label>Description<textarea name="description" maxlength="500"></textarea></label>',
    values => command("createDepartment", values));
  if (name === "export") {
    const exportData = { exportedAt: new Date().toISOString(), institution: state.institution,
      membership: state.members, applications: state.applications, registrations: state.registrations,
      offerings: state.offerings, academicEnrollments: state.academicEnrollments };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = href; a.download = "theoria-institution-" + institution.id + ".json"; a.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
}
document.addEventListener("click", event => {
  const tab = event.target.closest("[data-ias-tab]");
  if (tab) { activeTab = tab.dataset.iasTab; render(); return; }
  const actionButton = event.target.closest("[data-ias-action]");
  if (actionButton) handle(actionButton).catch(error => flash(error.message || "Unable to complete action."));
});
document.addEventListener("submit", async event => {
  if (event.target?.id !== "iasApplyForm") return;
  event.preventDefault();
  const submit = event.target.querySelector("[type=submit]");
  if (busy) return;
  busy = true; submit.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(event.target));
    const result = await command("apply", values);
    event.target.innerHTML = '<p class="ias-notice">' +
      (result.status === "active" ? "You have been enrolled under this school’s automatic admissions policy." :
        "Application submitted to admissions.") + '</p>';
  } catch (error) { window.TheoriaDialog?.alert?.(error.message || "Application failed."); }
  finally { busy = false; submit.disabled = false; }
});
window.TheoriaInstitutionAdmin = {
  mount(nextInstitution, nextUser) {
    institution = nextInstitution; user = nextUser;
    activeTab = "overview"; state = null; legacyMounted = false;
    document.body.classList.remove("theoria-show-legacy", "theoria-institution-upgraded");
    if (institution && user) load().catch(console.error);
  }
};

window.dispatchEvent(new Event("theoria:institution-admin-ready"));
