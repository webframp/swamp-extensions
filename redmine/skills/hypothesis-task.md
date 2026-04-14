---
name: hypothesis-task
description: Use when creating a hypothesis-driven Redmine task for uncertain work requiring experimentation — guides the hypothesis format, time-boxing, learning goals, and outcome recording.
---

# Hypothesis-Driven Task

Create a hypothesis-driven task in Redmine using the `@webframp/redmine` model. Use this when the solution is unclear and experimentation is needed. For well-defined work with known steps, use the `create-task` skill instead.

## The Hypothesis Format

Every hypothesis-driven task uses this core structure:

```
We believe that [specific change or approach]
Will result in [expected measurable outcome]
We will know we have succeeded when [concrete success criteria]
```

This is not optional decoration — it is the task description's foundation.

## Task Template

Use this description template for the `create_issue` method's `description` argument:

```markdown
**We believe that**
[Hypothesis: what we think will solve the problem or improve the situation]

**Will result in**
[Expected outcome: the measurable impact or benefit we expect]

**We will know we have succeeded when**
[Success criteria: specific, measurable evidence that validates or invalidates the hypothesis]

**Context:**
[Why we are exploring this and what problem we are solving]

**Approach:**
1. [Step 1]
2. [Step 2]
3. [Step 3]

**Time box:** [Maximum hours to spend]

**Learning goals:**
[What we want to learn regardless of outcome]

**Rollback plan:**
[How to undo changes if the experiment fails]
```

## Subject Convention

Prefix with the hypothesis context:

- POC: static build of GKD CLI
- Experiment: Redis session store for auth service
- Spike: evaluate Cilium as CNI replacement

## Workflow

1. **Find parent story** — run `list_issues` filtered by Story tracker
2. **Look up trackers** — run `list_trackers` to find the Task tracker ID
3. **Look up users** — run `list_users` to find the assignee's ID
4. **Create the task** — run `create_issue` with:
   - `subject`: prefixed with POC/Experiment/Spike
   - `trackerId`: Task tracker ID
   - `description`: filled-in hypothesis template above
   - `parentIssueId`: parent story ID
   - `assignedToId`: person running the experiment
   - `estimatedHours`: time box duration
   - `statusId`: 1 (New)

## Recording Outcomes

When closing the task, use `update_issue` to add a notes comment documenting the outcome:

| Outcome | Meaning |
|---------|---------|
| **Validated** | Hypothesis proved true, measurements met targets |
| **Invalidated** | Hypothesis proved false, measurements did not meet targets |
| **Inconclusive** | Need more information or a different approach |

**A failed hypothesis is still a success** — the team learned something. Close the task with status Closed and prefix the title with `[failed]` if invalidated. The learning is the deliverable.

## Outcome Comment Template

```markdown
**Outcome:** [Validated / Invalidated / Inconclusive]

**What we learned:**
[Key findings from the experiment]

**Evidence:**
[Data, measurements, or observations that support the outcome]

**Recommendation:**
[Next steps based on what we learned]
```

## Time-Boxing Rules

- Set `estimatedHours` to the maximum time allowed
- Typical range: 2-16 hours (never open-ended)
- If the time box expires without a clear result, the outcome is Inconclusive
- Document what was learned and decide whether to run another experiment or change approach
