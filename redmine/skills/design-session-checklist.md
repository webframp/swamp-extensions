---
name: design-session-checklist
description: Use when facilitating or preparing a design session for a Redmine story — provides before/during/after checklists, the design output template, and produces task issues from action items.
---

# Design Session Checklist

Facilitate a design session for a Redmine story and produce task issues from the results using the `@webframp/redmine` model.

## When Is a Design Session Required?

**Required:**
- Infrastructure change affecting multiple sites
- Security implications
- Team has uncertainties about the approach
- Estimated effort exceeds 5 days
- High-risk change

**Can skip (with Crew Lead + Team Lead approval):**
- Exceptionally simple work
- Crew Lead is confident in the approach
- Team Leads approve via chat

## Before the Session

- [ ] Story description is clear and complete (run `get_issue` to review)
- [ ] Participants identified and invited
- [ ] Facilitator assigned (usually Crew Lead)
- [ ] Pre-work reminder sent
- [ ] Mind mapping or collaboration tool ready

## During the Session

- [ ] Review story objective and success criteria
- [ ] Identify questions for oversight
- [ ] Explore solution approaches (at least 2 options)
- [ ] Identify knowledge gaps and experiments needed
- [ ] Consider documentation needs
- [ ] Complete security considerations
- [ ] Document the design session output

## After the Session

- [ ] Design output added to story description (via `update_issue`)
- [ ] Tasks created from action items (via `create_issue`)
- [ ] Story moved to Ready or In Progress (via `update_issue`)
- [ ] Team leads notified

## Design Session Output Template

After the session, update the story description by appending this output using `update_issue` with `notes`:

```markdown
## Design Session: [Story Title]

**Date:** [Date]
**Participants:** [Names]

### Design Questions
1. [Question 1]
2. [Question 2]

### Constraints
- [Constraint 1]
- [Constraint 2]

### Risks Identified
- [Risk 1]
- [Risk 2]

### Approach Options

**Option 1: [Name]**
Pros:
- [Pro 1]

Cons:
- [Con 1]

**Option 2: [Name]**
Pros:
- [Pro 1]

Cons:
- [Con 1]

### Recommended Approach
[Description of chosen approach and rationale]

### Security Considerations
[Security implications, mitigations, and checklist items addressed]

### Experiments Needed
1. [Experiment 1 with hypothesis]
2. [Experiment 2 with hypothesis]

### Action Items
- [ ] [Action 1] - @[Owner]
- [ ] [Action 2] - @[Owner]

### Decisions Made
- [Decision 1]
- [Decision 2]
```

## Producing Tasks from Action Items

For each action item identified in the design session:

1. **Decide task type** — Is the solution known (procedural) or uncertain (hypothesis-driven)?
   - Known solution: use the `create-task` skill
   - Needs experimentation: use the `hypothesis-task` skill
2. **Create the task** — run `create_issue` with the parent set to the story
3. **Assign the owner** listed in the action item

## Security Checklist

Address these during the design session and document in the output:

**Authentication/Authorization:**
- No hard-coded credentials
- Service accounts follow least privilege
- Server-side authorization checks

**Data Protection:**
- Sensitive data encrypted in transit (TLS 1.2+) and at rest
- Data retention follows policy
- PII/PHI handling compliant

**Network Security:**
- Firewall rules follow least privilege
- Only required ports/services exposed
- Network segmentation appropriate

**Input Validation:**
- All user input validated
- SQL injection and XSS protections

**Logging and Monitoring:**
- Security events logged
- Audit trail for sensitive actions

**Dependencies:**
- Scanned for vulnerabilities
- No known high/critical vulnerabilities

## Decision Trees

**Is security review required?**

| Condition | Required? |
|-----------|-----------|
| Auth/authz changes | Yes |
| New network services | Yes |
| Sensitive data handling changes | Yes |
| Public-facing or internet-exposed | Yes |
| High-risk systems (identity, finance) | Recommended |
| New third-party services | Recommended |
| All other work | Minimum: security checklist |
