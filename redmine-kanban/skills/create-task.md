---
name: create-task
description: Use when creating a Redmine procedural task with the @webframp/redmine model — guides task template, action plan steps, parent story linking, and assignment.
---

# Create Task

Create a well-formed procedural Redmine task using the `@webframp/redmine` model. Use this for work with a known solution and clear steps. For uncertain work requiring experimentation, use the `hypothesis-task` skill instead.

## When to Use Procedural vs Hypothesis

| Signal | Task type |
|--------|-----------|
| Clear, known solution | Procedural (this skill) |
| Following an established procedure | Procedural |
| Predictable outcome, done before | Procedural |
| Solution unclear, needs experimentation | Hypothesis-driven |
| Learning or investigation required | Hypothesis-driven |
| Outcome uncertain | Hypothesis-driven |

## Subject Convention

Task subjects start with an **imperative action verb**:

- Configure load balancer health checks for staging
- Update OpenSSL to latest version on base image
- Migrate DNS records from legacy zone to new account

## Task Template

Use this description template for the `create_issue` method's `description` argument:

```markdown
**Background:**
[Context for this task. How does it contribute to the parent story?]

**Objective:**
[What specific action needs to be taken?]

**Success criteria:**
[How we know this is complete. Specific and testable.]

**Documentation to update:**
[List specific documentation pages or sections.]

**Help references/contact person:**
[Links to relevant documentation, contact information for SMEs.]

**Action plan steps:**
1. [Specific step with command or action]
2. [Next step]
3. [Verification step]
```

## Workflow

1. **Find parent story** — run `list_issues` filtered by Story tracker to locate the parent
2. **Look up trackers** — run `list_trackers` to find the Task tracker ID
3. **Look up users** — run `list_users` to find the assignee's ID
4. **Create the task** — run `create_issue` with:
   - `subject`: imperative verb format
   - `trackerId`: Task tracker ID
   - `description`: filled-in template above
   - `parentIssueId`: parent story ID
   - `assignedToId`: person doing the work
   - `estimatedHours`: time estimate
   - `statusId`: 1 (New)

## Task Checklist

Before submitting, verify:

- [ ] Subject starts with an action verb
- [ ] Task is child of parent story (or standalone if trivial)
- [ ] Background ties task to parent story's objective
- [ ] Action plan steps are specific and ordered
- [ ] Success criteria are testable
- [ ] Assigned to the person doing the work
- [ ] Estimated hours set
- [ ] Category matches parent story

## State Lifecycle

Tasks move through: **New** -> **Ready** -> **In Progress** -> **Review** -> **Closed**

- Simple tasks can skip Review: New -> Ready -> In Progress -> Closed
- WIP limit: 2 tasks per person
- Blocked tasks: prefix title with `[blocked]`, keep status as In Progress, add comment explaining the blocker
