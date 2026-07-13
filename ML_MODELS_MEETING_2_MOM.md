# Minutes of Meeting — ML Models / Asset Abstraction (Follow-up)

**Date:** 2026-07-08
**Topic:** Deeper analysis of the asset-abstraction design before drafting the GitHub discussion

## Context

Reviewed the research so far (model-as-asset, LakeFS/Iceberg feature depth, extensible-asset
architecture with literature, and the concrete storage design). Direction is agreed; two deeper
questions were raised that need more research before we finalize the design.

## Points to research

### 1 — Lower-level look at the reference systems (PRIORITY, research first)

For the systems we've been citing — **Lakehouse, Google GOODS, Apache Gravitino, Unity Catalog** —
go one level deeper:

- **What resource/asset types does each actually support** (tables, files/volumes, models,
  functions, etc.)?
- **What APIs do they expose** to register, resolve, and fetch those resources?

**Motivation:** Today Texera uses the `dataset` table to **map a logical path → fetch the bytes
from the data plane**. This path-mapping abstraction works for file-like assets, but it **breaks for
a resource like a computing unit** (a computing unit is not a file path). We need a **better, more
general resource abstraction**. Question: **how do these other systems model this** so that
heterogeneous resources (not just files) fit under one abstraction?

### 2 — Folder-of-files path resolution inside a Python UDF (PARKED — take up after #1)

A model is often a **folder of files**. When a Python UDF loads a model by its folder path and the
loading code then tries to **read the individual files inside** that folder, how does the **path
conversion** happen — given that the **LakeFS mapping lives at the Texera level**, not inside the
user's process?

- How do other systems solve **intra-folder path resolution** for a mounted/fetched asset?
- What are our options to solve it in Texera?

## Action items

- [ ] Research **Question 1** first (resource types + APIs of the reference systems; the general
      resource abstraction beyond path-mapping; how they handle non-file resources like compute).
- [ ] Then take up **Question 2** (folder path resolution in the UDF).
- [ ] Fold findings into the design, then draft the GitHub discussion.
