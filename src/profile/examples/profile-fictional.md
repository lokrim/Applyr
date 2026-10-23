---
profile_version: 1
reviewed_on: "2026-10-23"
identity:
  legal_name: "Alex Morgan"
  preferred_name: "Alex"
  given_name: "Alex"
  family_name: "Morgan"
contact:
  email: "alex@example.com"
  phone: null
  address:
    city: "Example City"
    country_code: null
links:
  portfolio: "https://example.com/alex"
education:
  - id: example-degree
    institution: "Fictional Institute of Technology"
    degree: "Bachelor of Science"
    field: "Computer Science"
    start_date: "2023-08"
    end_date: "2027-05"
    expected: true
    coursework:
      - "Data Structures"
      - "Database Systems"
experience: []
projects:
  - id: task-board
    name: "Student Task Board"
    description: "Built a course project for organizing student tasks."
    technologies: ["TypeScript", "SQL"]
    achievements:
      - "Implemented filtering and keyboard-accessible task editing."
skills:
  - name: "TypeScript"
    evidence_refs: ["projects.task-board"]
  - name: "SQL"
    evidence_refs: ["projects.task-board"]
preferences:
  locations: ["Example City"]
  work_arrangements: ["hybrid", "remote"]
  available_from: "2027-06-01"
  internship_months: 3
  relocation: null
eligibility: []
answers:
  - id: about-me
    question: "Tell us about yourself."
    kind: verified
    fact_refs: ["education.example-degree", "projects.task-board"]
    reviewed_on: "2026-10-23"
  - id: relevant-project
    question: "Describe a relevant project."
    kind: verified
    fact_refs: ["projects.task-board"]
    reviewed_on: "2026-10-23"
  - id: work-preference
    question: "What working arrangements do you prefer?"
    kind: preference
    fact_refs: ["preferences.work_arrangements"]
    reviewed_on: "2026-10-23"
---

# Fictional example — not real candidate information

All names, institutions and experiences in this example are fictional. Do not use them in an application. Phone, country and employment eligibility are intentionally unknown.

## Answer: about-me

I am studying Computer Science at the Fictional Institute of Technology, with an expected graduation in May 2027. My coursework includes data structures and databases. I built a student task board using TypeScript and SQL.

## Answer: relevant-project

For a course project, I built a student task board using TypeScript and SQL. I implemented task filtering and keyboard-accessible editing. I would be happy to explain the design choices and what I would improve.

## Answer: work-preference

I prefer hybrid or remote work. I would discuss the role's specific working arrangements before confirming availability.
