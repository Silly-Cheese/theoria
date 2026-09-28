# Theoria

**Advanced Theological Studies**

Theoria is a theological learning and assessment platform with a restrained university-style identity and an academic workflow inspired by structured systems such as AP Classroom.

## Generation roadmap

1. ✅ Foundation & Design
2. ✅ Courses & Sections
3. ✅ Assessments & Examinations
4. ⬜ Analytics, Records & Final Polish

## Firebase architecture

Theoria intentionally uses only:

- **Firebase Authentication**
- **Cloud Firestore**
- Firebase Hosting for the static site, if desired

There is **no Firebase Storage dependency** and no Cloud Functions dependency.

Project ID: `theoria-79433`

Enable **Email/Password** in Firebase Authentication.

Deploy the current rules and site with:

```bash
firebase deploy --only firestore:rules,hosting
```

## Phase 3 capabilities

### Item Bank
- Reusable course-owned assessment items
- Multiple choice and multiple select
- Short response and essay
- Passage analysis
- Primary-source analysis
- Argument analysis
- Oral-examination prompts
- Disputation prompts
- Difficulty and cognitive-level metadata
- Unit, topic and competency tagging
- Instructor-only answer keys and rubrics

### Assessment Builder
- Academic Exercises
- Unit Evaluations
- Semester I Examinations
- Comprehensive Final Examinations
- Oral Examinations
- Disputations
- Content and competency blueprints
- Weighted examination sections
- Scheduling windows
- Timed administration
- Anonymous candidate-number grading
- Question randomization and backtracking controls
- Draft, Published and Closed states

### Formal examination experience
- Required pre-exam acknowledgment
- Candidate numbers
- Timers with accommodation multipliers
- Autosaved Firestore responses
- Mark-for-review
- Question navigator
- Optional calculator accommodation
- Large-text examination mode
- Submission receipt
- Firestore event logging for leaving the exam tab

### Secure Firestore separation
- Students do not receive answer-key documents
- Question access requires an active assessment attempt
- Students may modify only their own active submission
- Unreleased results remain instructor-only
- Released results include domain performance
- Objective scoring occurs only in the instructor session

### Grading
- Candidate-by-candidate evaluation
- Horizontal grading by question
- Objective-item auto-scoring
- Rubric reference while grading
- Instructor comments
- Examination-domain scores
- Manual result release

### Grading Pathways
- **Examination Pathway**
  - Semester I Examination: default 35%
  - Comprehensive Final Examination: default 65%
- **Composite Pathway**
  - Coursework: default 60%
  - Semester I Examination: default 15%
  - Comprehensive Final Examination: default 25%
- Instructor-defined selection deadline
- Student acknowledgment and pathway selection
- Locked selection after the deadline

### Assessment accommodations
- Time multipliers
- Break permission
- Calculator permission
- Large-text interface
- Reduced-distraction designation

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

assessments/{assessmentId}
  questions/{questionId}
  keys/{questionId}
  submissions/{uid}
    events/{eventId}
  results/{uid}

joinCodes/{THR-XXXXX}
```

## Phase 4

Phase 4 will concentrate on mastery analytics, question analysis, academic portfolios, grade projection, final-grade audit and certification, formal academic records, appeals/amendments, and final UI/UX polish.
