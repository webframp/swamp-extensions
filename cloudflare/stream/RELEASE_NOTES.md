## 2026.08.21.1

**Changed:** Removed endpoints whose request body is exclusively
multipart/form-data (e.g. object/file uploads), which cfApi's JSON helper cannot
serve. Same generator fix as workers-scripts in #352, now caught up for these 7
services.
