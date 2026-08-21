## 2026.08.20.1

**Changed:** Bump @webframp/aws/adopt 2026.08.05.1 → 2026.08.20.1

**Changed:** Bump @webframp/aws/inventory 2026.08.05.1 → 2026.08.20.1

## 2026.08.15.1

**Changed:** Bump @webframp/aws/adopt 2026.08.02.1 → 2026.08.05.1

**Changed:** Bump @webframp/aws/inventory 2026.08.02.1 → 2026.08.05.1

## 2026.08.05.1

**Changed:** Bump @webframp/aws/adopt 2026.08.01.1 → 2026.08.02.1

**Changed:** Bump @webframp/aws/inventory 2026.08.01.1 → 2026.08.02.1

## 2026.08.02.1

**Changed:** Bump @webframp/aws/adopt 2026.07.30.1 → 2026.08.01.1

**Changed:** Bump @webframp/aws/inventory 2026.07.30.1 → 2026.08.01.1

## 2026.08.01.1

**Fixed:** Broken model-upgrade chain. The prior version bump (to `2026.07.31.1`) updated `version` but left the `upgrades` array terminating one step short, which blocks `swamp extension push` ("model upgrade chain errors"). That version never actually published — the registry was still serving `2026.07.29.1`. This release closes the chain with a no-op upgrade entry and republishes everything that had accumulated since `2026.07.29.1`.

## 2026.07.31.1

**Changed:** Bump @webframp/aws/adopt 2026.07.26.1 → 2026.07.30.1

**Changed:** Bump @webframp/aws/inventory 2026.07.24.1 → 2026.07.30.1

## 2026.07.29.1

**Fixed:** Terminate upgrade chain at current version (extension was uninstallable due to broken upgrade chain).

## 2026.07.27.1

**Changed:** Bump @webframp/aws/adopt 2026.07.21.1 → 2026.07.26.1

**Changed:** Bump @webframp/aws/inventory 2026.07.21.1 → 2026.07.24.1


## 2026.07.24.1

**Changed:** Bump dependency pins to latest published versions:
- @webframp/aws/adopt 2026.07.18.1 → 2026.07.21.1
- @webframp/aws/inventory 2026.07.18.1 → 2026.07.21.1
