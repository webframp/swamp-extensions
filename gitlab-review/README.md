# @webframp/gitlab-review

AI-assisted GitLab merge request review. Fetches diffs, stores versioned
review drafts, gates on human approval, and posts comments via the GitLab
REST API. No CLI dependencies. Designed to run from an agent harness with
`@dougschaefer/writing-voice` for tone-consistent output.

## Prerequisites

- GitLab personal access token with `api` scope
- A swamp vault to store the token

## Installation

```bash
swamp extension pull @webframp/gitlab-review
```

## Setup

```bash
# Create a vault for GitLab credentials
swamp vault create local_encryption gitlab

# Store your token
echo "$GITLAB_TOKEN" | swamp vault put gitlab TOKEN

# Create the model instance
swamp model create @webframp/gitlab-review mr-reviewer
```

Edit the model definition to wire the vault:

```yaml
globalArguments:
  host: git.example.org
  token: ${{ vault.get("gitlab", "TOKEN") }}
```

## Methods

| Method | Description | Inputs |
|--------|-------------|--------|
| `get_mr_diff` | Fetch MR metadata and file diffs | `project`, `iid` |
| `analyze` | Store a review draft | `project`, `iid`, `body` |
| `edit_draft` | Revise draft (new version, history retained) | `project`, `iid`, `body` |
| `update_review` | Edit an existing MR comment in place | `project`, `iid`, `noteId` |
| `approve_mr` | Approve MR without commenting | `project`, `iid` |
| `unapprove_mr` | Remove approval (request changes) | `project`, `iid` |
| `post_review` | Post draft as comment, optionally approve | `project`, `iid`, `action?` |

The `action` parameter on `post_review` accepts: `comment` (default),
`approve`, or `request_changes`.

## Resources

| Resource | Description | Retention |
|----------|-------------|-----------|
| `mrDiff` | MR metadata and file diffs | 7d, 5 versions |
| `reviewDraft` | Draft comment (editable) | 7d, 10 versions |
| `reviewPosted` | Record of posted comments | 30d, 5 versions |

The `reviewDraft` retains 10 versions. Compare drafts before approving:

```bash
diff <(swamp data get mr-reviewer reviewDraft-group~repo-123 --version 1 --json | jq -r '.content.body') \
     <(swamp data get mr-reviewer reviewDraft-group~repo-123 --version 3 --json | jq -r '.content.body')
```

## Writing Voice Setup

This extension produces better reviews when paired with
`@dougschaefer/writing-voice`. The voice profile tells the agent *how* to
write; the extension handles *where* the output goes.

### 1. Pull and create a voice instance

```bash
swamp extension pull @dougschaefer/writing-voice
swamp model create @dougschaefer/writing-voice voice
```

### 2. Configure globalArguments

Edit the model YAML (`models/@dougschaefer/writing-voice/<uuid>.yaml`):

```yaml
globalArguments:
  organizationName: "Your Org"
  voiceIdentity: |
    Direct, technically grounded. Questions over directives.
    Acknowledge good work plainly. State opinions with evidence.
  tiers:
    - name: technical-review
      description: "Substantive code review"
      register: polished
  proseRules: |
    - Questions over directives: "Is there a reason...?" not "You should..."
    - No em-dashes. Period and new sentence.
    - No filler phrases. Cut "in terms of", "the fact that", "in order to".
    - If a sentence exceeds 25 words, split or cut.
    - Match feedback length to observation weight.
  positioningFramework: "Reviews share knowledge, not gatekeep."
  documentTypes:
    - name: code-review
      defaultTier: technical-review
      structure: "Observations → Suggestions with rationale → Scoped verdict"
  audiences:
    - name: engineering-peers
      readingFor: "Actionable feedback"
      depthLevel: technical
      guidance: "Assume stack familiarity. Probe intent."
  antiPatterns: []
  killList:
    - "LGTM"
    - "nit:"
    - "maybe consider"
    - "leverage"
    - "utilize"
```

### 3. Add reference documents (exemplars)

Paste your own past review comments as calibration:

```bash
swamp model method run voice add-reference \
  --input name=short-approval \
  --input content="ok by me for testing, curious to see how useful this is"

swamp model method run voice add-reference \
  --input name=scoped-approval \
  --input content="This is fine for now, but let's keep a close eye on the cost growth."
```

Reference documents anchor the voice in your actual cadence. They correct
residual AI tells more effectively than rules alone.

### 4. Add anti-patterns as you notice them

```bash
swamp model method run voice add-anti-pattern \
  --input name=em-dash-overuse \
  --input description="Em-dashes used as a crutch for parenthetical asides" \
  --input wrong="The matching heuristics — the confidence-tier approach — are right." \
  --input right="The matching heuristics are the right call. The confidence tiers help." \
  --input explanation="Break into two sentences. Em-dashes signal uncommitted thoughts."
```

## Workflow: Review with Approval Gate

Create a workflow that fetches the diff, loads the voice profile, generates a
draft, waits for human approval, then posts:

```yaml
name: mr-review
inputs:
  properties:
    project: { type: string }
    iid: { type: integer }
    action: { type: string, enum: [comment, approve, request_changes], default: approve }
  required: [project, iid]
jobs:
  - name: review
    steps:
      - name: fetch-voice
        task: { type: model_method, modelIdOrName: voice, methodName: get }
      - name: fetch-diff
        task:
          type: model_method
          modelIdOrName: mr-reviewer
          methodName: get_mr_diff
          inputs: { project: "${{ inputs.project }}", iid: "${{ inputs.iid }}" }
      - name: analyze
        dependsOn: [{ step: fetch-diff, condition: { type: succeeded } }, { step: fetch-voice, condition: { type: succeeded } }]
        task:
          type: model_method
          modelIdOrName: mr-reviewer
          methodName: analyze
          inputs: { project: "${{ inputs.project }}", iid: "${{ inputs.iid }}", body: "Placeholder" }
      - name: approval-gate
        dependsOn: [{ step: analyze, condition: { type: succeeded } }]
        task: { type: manual_approval, prompt: "Review draft. Use edit_draft to revise, then approve.", timeout: 86400 }
      - name: post-review
        dependsOn: [{ step: approval-gate, condition: { type: succeeded } }]
        task:
          type: model_method
          modelIdOrName: mr-reviewer
          methodName: post_review
          inputs: { project: "${{ inputs.project }}", iid: "${{ inputs.iid }}", action: "${{ inputs.action }}" }
```

## Driving Reviews from an Agent Harness

The workflow above provides structure, but the AI analysis itself happens
in the agent session. Here are prompts for driving the full cycle:

### Full review (workflow-based)

```
Review MR !42 in myorg/myapp. Run the mr-review workflow, then when it
suspends at the approval gate, read the diff data, generate a review using
the voice profile, store it via edit_draft, and tell me when it's ready
for my approval.
```

### Quick review (no workflow, direct methods)

```
Fetch the diff for myorg/myapp MR !2, review the code changes,
write your review following the voice profile, and store it via edit_draft.
Do not post until I approve.
```

### Revise a draft

```
Read the current review draft for myorg/myapp MR !42. The tone is too
formal in the third paragraph. Rewrite that section to be more direct,
then store via edit_draft.
```

### Post after review

```
The draft for myorg/myapp MR !2 looks good. Post it and approve.
```

```bash
swamp model method run mr-reviewer post_review \
  --input project=myorg/myapp --input iid=2 --input action=approve
```

### Update an already-posted comment

```
Update note 12345 on myorg/myapp MR !2 with the current draft.
```

```bash
swamp model method run mr-reviewer update_review \
  --input project=myorg/myapp --input iid=2 --input noteId=12345
```

## License

Apache-2.0
