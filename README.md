# Theoria

**Advanced Theological Studies**

Theoria is a sophisticated theological learning, assessment, mastery, and academic-record platform with a restrained university-style identity.

## Generation roadmap

1. ✅ Foundation & Design
2. ✅ Courses & Sections
3. ✅ Assessments & Examinations
4. ✅ Analytics, Records & Final Polish

## Firebase architecture

Theoria intentionally uses only:

- **Firebase Authentication**
- **Cloud Firestore**
- Firebase Hosting for the static site, if desired

There is **no Firebase Storage dependency** and no Cloud Functions dependency.

Project ID: `theoria-79433`

Enable **Email/Password** in Firebase Authentication.

Deploy with:

```bash
firebase deploy --only firestore:rules,hosting
```

## Completed platform

### Courses & Sections
- Reusable theological course frameworks
- Units, topics, learning objectives, essential knowledge, and competencies
- Teaching sections with join codes and QR enrollment
- Student rosters and accommodations
- Assignments, resources, readings, and coursework gradebook

### Assessments & Examinations
- Reusable Item Bank
- Multiple choice / multiple select
- Short response and essay
- Passage, primary-source, and argument analysis
- Oral examinations and disputations
- Semester I Examination
- Comprehensive Final Examination
- Content and competency blueprints
- Anonymous candidate-number grading
- Formal exam preflight acknowledgment
- Timers, autosave, navigation, mark-for-review, and submission receipts
- Instructor-only answer keys
- Horizontal grading and objective auto-scoring
- Manual result release

### Grading Pathways

**Examination Pathway**
- Semester I Examination: default 35%
- Comprehensive Final Examination: default 65%

**Composite Pathway**
- Coursework: default 60%
- Semester I Examination: default 15%
- Comprehensive Final Examination: default 25%

Students formally choose their pathway before the configured deadline. Coursework continues to be graded under either pathway.

### Mastery & Analytics
- Competency mastery snapshots
- Topic mastery evidence
- Section mastery averages
- Student mastery profiles
- Students-needing-support view
- Item analysis
- Mean question performance
- Objective-response distributions
- Coursework and mastery section summaries
- Mastery remains separate from the course grade

### Progress & Grade Projection
- Live coursework percentage
- Semester-exam performance
- Comprehensive-final performance
- Pathway-aware final-grade projection
- Projection is explicitly distinct from a certified final grade

### Final Grade Audit & Certification
Before certification, Theoria checks:

- Grading pathway selected
- Semester I Examination complete
- Comprehensive Final Examination complete
- Coursework grade available when the Composite Pathway requires it
- No unresolved grade appeals

The instructor then explicitly certifies the final grade.

### Academic Records
Certified records include:

- Student and course identity
- Record ID
- Record version
- Grading pathway
- Coursework result
- Semester I Examination result
- Comprehensive Final result
- Certified final percentage
- Letter grade
- Academic mastery
- Print-friendly formal record

Theoria records document performance within the platform and do not claim outside accreditation unless separately established.

### Record Amendments
A certified grade is not silently overwritten. If a later change requires recertification:

1. The instructor provides an amendment reason.
2. The record version increases.
3. A permanent history entry preserves the certification/amendment event and its record snapshot.
4. The current record is recertified.

### Grade Appeals
- Students may appeal a specific coursework or assessment result.
- Appeals are recorded with status and rationale.
- Instructor decisions remain in Firestore.
- Pending appeals block final-grade certification.
- If an appeal changes a grade after certification, the instructor uses the amendment workflow.

### Academic Portfolios
Instructor-curated portfolios can reference a student's strongest existing coursework and assessment records without needing Firebase Storage. Portfolios can include:

- Featured academic work
- Performance results
- Instructor academic commentary

### Firestore-only security model
- Students cannot read assessment answer keys.
- Question access requires an active assessment attempt.
- Students can change only their own active exam submission.
- Unreleased assessment results remain instructor-only.
- Students can read only their own mastery, portfolio, appeals, academic record, and record history.
- Only the section owner can calculate mastery snapshots, curate portfolios, decide appeals, or certify/amend records.

## Firestore structure

```
users/{uid}
  enrollments/{sectionId}

system/owner

courses/{courseId}
  units/{unitId}
    topics/{topicId}
  competencies/{competencyId}
  items/{itemId}

sections/{sectionId}
  members/{uid}
  assignments/{assignmentId}
  resources/{resourceId}
  grades/{assignmentId_studentId}
  assessmentRefs/{assessmentId}
  assessmentGrades/{assessmentId_studentId}
  gradingPathways/{uid}
  mastery/{uid}
  academicRecords/{uid}
  portfolios/{uid}
  appeals/{appealId}
  recordHistory/{historyId}

assessments/{assessmentId}
  questions/{questionId}
  keys/{questionId}
  submissions/{uid}
    events/{eventId}
  results/{uid}

joinCodes/{THR-XXXXX}
```

## Status

The four planned generation phases are complete. Future work should be normal feature additions, bug fixes, design refinements, or course-specific improvements rather than additional foundational phases.
