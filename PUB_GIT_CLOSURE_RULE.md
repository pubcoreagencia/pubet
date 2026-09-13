# PUB Git Stage Closure Rule

**Effective:** 2026-09-13 | **Mandatory**

A stage is CLOSED/COMPLETE/PASS only after implementation, required tests/gates, clean working tree, commit, publication to the official remote, and verification that GitHub reflects the intended state. A local commit alone never closes a stage.

Sequence: `IMPLEMENT → TEST → COMMIT → PUSH → VERIFY REMOTE → DECLARE CLOSED → NEXT STAGE`

If publication is withheld, record **IMPLEMENTED LOCALLY / NOT YET PUBLISHED** and do not call the stage complete. Verify the previous remote state before starting the next stage. GitHub is the source of truth.
