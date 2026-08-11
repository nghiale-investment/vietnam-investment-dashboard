# Vietnam Research RAW Markdown Mirror

This public repository is a short-lived transport mirror of recent Markdown
documents under `Research Vault/01.RAW` on the primary research machine.

## Purpose

- Preserve the RAW directory structure.
- Share only Markdown (`.md`) files between machines.
- Retain only a rolling 14-calendar-day window.
- Exclude source documents, databases, generated files, and application state.

## Source-of-truth policy

The primary Research Vault is the source of truth. This repository is a
distribution mirror, not an ingestion source or a replacement for the vault.
The primary machine publishes changes; secondary machines normally pull and
consume them.

## Contents

All mirrored research documents are stored under `RAW/`, using paths relative
to `Research Vault/01.RAW`. Every Markdown file anywhere under RAW is eligible
when it was added or modified inside the inclusive 14-day window ending on the
current date in `Asia/Ho_Chi_Minh`. Filename and document date do not control
eligibility, so newly added undated or older-dated documents are included.

## Primary-machine publishing

From the Vietnam Equity Research OS workspace, run:

```bash
python3 tools/sync_recent_raw_markdown.py --days 14
cd raw-md-sync
git add -A
git commit -m 'Refresh rolling RAW Markdown window'
git push
```

The sync tool removes expired files from the mirror. The ignore rules prevent
non-Markdown RAW content from being committed.

## Secondary-machine use

Clone once:

```bash
git clone https://github.com/nghiale-investment/vietnam-research-raw-md.git
```

Refresh later from inside the clone:

```bash
git pull --ff-only
```
