# @webframp/swamp-adoption

Guides new users through mapping their domain onto swamp primitives. Conducts
structured discovery interviews, produces versioned extension designs, and
generates implementation scaffolds.

Uses swamp to teach swamp — the adoption journey itself is modeled as typed,
versioned state.

## Prerequisites

- [swamp](https://github.com/swamp-club/swamp) CLI installed

## Installation

```bash
swamp extension pull @webframp/swamp-adoption
```

## Usage

### Create a model instance

```bash
swamp model create @webframp/swamp-adoption adoption \
  --global-arg userContext="SRE team managing AWS and GitLab" \
  --global-arg currentTools='["terraform","ansible"]' \
  --global-arg painPoints='["drift detection","secret rotation"]' \
  --global-arg swampExperience=installed
```

### Discover your system landscape

The `discover` method guides an agent-led interview to map your systems,
interactions, data flows, and pain points:

```bash
swamp model method run adoption discover
```

### Converting an existing skill instead

If you already have a skill (a `SKILL.md` or similar agent instructions) that
you're trying to formalize rather than mapping a domain from scratch, `discover`
will ask upfront whether that's the case. Answering yes routes you to
`import_skill`, which seeds both `landscape` and `extensionDesign` directly from
the skill's content — skipping the systems interview:

```bash
swamp model method run adoption import_skill --arg sourceSkill=.claude/skills/deploy-checklist/SKILL.md
```

From there, `scaffold` and `next` work the same as the `design`-driven path.

### Design an extension

After discovery, `design` helps you shape a swamp extension for the highest-pain
system:

```bash
swamp model method run adoption design
swamp model method run adoption design --arg system=gitlab
```

### Generate a scaffold

Once a design is finalized, `scaffold` produces working starter files:

```bash
swamp model method run adoption scaffold
swamp model method run adoption scaffold --arg outputFormat=stdout
```

### Get next suggestion

After building your first extension, `next` recommends what to tackle next based
on remaining pain in your landscape:

```bash
swamp model method run adoption next
```

## Methods

| Method         | Description                                                        |
| -------------- | -------------------------------------------------------------------- |
| `discover`     | Structured interview to map systems, interactions, and data flows    |
| `import_skill` | Convert an existing skill into a landscape stub and extension design |
| `design`       | Shape an extension design from landscape analysis                    |
| `scaffold`     | Generate implementation files from a design                          |
| `next`         | Suggest the next extension to build based on remaining pain          |

## Resources

| Resource          | Lifetime | Description                                        |
| ----------------- | -------- | -------------------------------------------------- |
| `landscape`       | infinite | Discovered system landscape from domain interviews |
| `extensionDesign` | infinite | Versioned extension design produced from landscape |
| `scaffold`        | 24h      | Generated file scaffold (ephemeral)                |

## License

Apache-2.0
