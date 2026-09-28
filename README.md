# Theoria

**Advanced Theological Studies**

Theoria is a theological learning and assessment platform with a restrained university-style visual identity and an academic workflow inspired by structured course systems such as AP Classroom.

## Generation roadmap

1. ✅ Foundation & Design
2. ✅ Courses & Sections
3. ⬜ Assessments & Examinations
4. ⬜ Analytics, Records & Final Polish

## Phase 2 capabilities

### Courses
- Reusable course frameworks
- Course code, discipline, level, status, and description
- Units
- Topics
- Learning objectives
- Essential knowledge
- Academic competencies
- Topic-to-competency mapping

### Sections
- Create live teaching sections from reusable courses
- Academic term, section number, format, start/end dates
- Automatically generated join codes
- QR-code enrollment display
- Open/close enrollment
- Regenerate join codes
- Student enrollment records
- Instructor roster

### Academic work
- Assignments with multiple theological activity types
- Draft/published workflow
- Due dates and point values
- Section readings and resources
- Primary sources, Scripture readings, articles, books, PDFs, lecture notes, and research links

### Gradebook
- Instructor gradebook by student and assignment
- Editable scores and instructor comments
- Live coursework percentage
- Student grade view kept conceptually separate from future mastery/final certification

### Authorization
- Course and section ownership rules
- Membership-aware assignment/resource access
- Students can only read their own grade records
- First instructor account becomes the platform owner
- Later self-registrations cannot simply elevate themselves to instructor

## Firebase project

Project ID: `theoria-79433`

Enable **Email/Password** in Firebase Authentication.

Deploy both security rules and Hosting after pulling the latest repository:

```bash
firebase deploy --only firestore:rules,storage,hosting
```

## Data model

```
users/{uid}
  enrollments/{sectionId}

system/owner

courses/{courseId}
  units/{unitId}
    topics/{topicId}
  competencies/{competencyId}

sections/{sectionId}
  members/{uid}
  assignments/{assignmentId}
  resources/{resourceId}
  grades/{assignmentId}_{studentId}

joinCodes/{THR-XXXXX}
```

## Next: Phase 3

Phase 3 will add the formal assessment and examination engine: Item Bank, assessment blueprints, advanced question types, rubrics, anonymous grading, semester examinations, Comprehensive Final Examination, oral examinations, disputations, and the Examination vs. Composite grading pathways.
