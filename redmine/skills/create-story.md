---
name: create-story
description: Use when creating a Redmine story issue with the @webframp/redmine model — guides subject line convention, template structure, category selection, and parent theme linking.
---

# Create Story

Create a well-formed Redmine story using the `@webframp/redmine` model.

## Subject Line Convention

All stories follow this format:

```
Technology | Service | Objective
```

Examples:
- ADDS | LDAP | Implement Geographic Redundancy
- Kubernetes | Monitoring | Add Resource Quota Alerts
- Exchange | Mailbox Management | Automate Mailbox Provisioning

## Story Template

Use this description template for the `create_issue` method's `description` argument:

```markdown
**Background:**
[Context for this work. Why is it needed? How does it fit into larger goals?]

**Objective:**
[Clear statement of what needs to be accomplished. Specific and actionable.]

**Success criteria:**
[How we know this work is done. Measurable, testable, or demonstrable.]

**Documentation to update:**
[List documentation that needs to be created or updated.]
```

## Categories

Every story must have one:

| Category | When |
|----------|------|
| Fires | Urgent, unplanned (outages, critical security, data loss) |
| Operational Change | Planned maintenance (patching, updates, config changes) |
| Improvements | Enhancements (refactoring, optimization, tech debt) |
| Projects | New capabilities (features, new infrastructure) |

## Workflow

1. **Look up trackers** — run `list_trackers` to find the Story tracker ID
2. **Look up parent theme** (if applicable) — run `list_issues` filtered by Theme tracker to find parent
3. **Create the story** — run `create_issue` with:
   - `subject`: `Technology | Service | Objective` format
   - `trackerId`: Story tracker ID
   - `description`: filled-in template above
   - `parentIssueId`: parent theme ID (if applicable)
   - `statusId`: 1 (New)
4. **Do NOT set** `assignedToId` or due date — stories are pulled by capacity, not pushed

## Story Creation Checklist

Before submitting, verify:

- [ ] Subject follows `Technology | Service | Objective` convention
- [ ] Story is child of relevant Theme (if applicable)
- [ ] Background provides context and rationale
- [ ] Objective is clear and specific
- [ ] Success criteria are measurable and testable
- [ ] Documentation to update is identified
- [ ] Category assigned (Fires, Operational Change, Improvements, Projects)
- [ ] Status set to New

## State Lifecycle

Stories move through: **New** -> **Design** -> **Ready** -> **In Progress** -> **Review** -> **Closed**

- Simple stories can skip Design and Review: New -> Ready -> In Progress -> Closed
- Stories are NOT assigned until someone pulls them
- No due dates — work is pulled based on capacity
- WIP limit: 4 stories per team
