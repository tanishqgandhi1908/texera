## Summary

We reviewed the design for supporting user-uploaded ML models as versioned assets (reusing the existing dataset storage stack — LakeFS + MinIO). The core direction — treat a
model as an asset, support per-library starting with PyTorch. Before opening a broader design discussion, we agreed to do more research on a few open questions around storage, packaging, and prior art.

- **LakeFS features for models.** Research which LakeFS capabilities are relevant to models specifically (beyond how we use it for datasets), and how other systems that build model
  management on top of LakeFS approach this.

- **PyTorch file storage & loading.** A PyTorch model is a package that must be **mounted** — we cannot simply load it inside a Python UDF the way we load a dataset. Need to understand how the `.pt`/`.pth` (and packaged) format works in terms of storage in LakeFS and how it gets
  materialized/mounted at run time for inference.

- **Unity Catalog.** Look at how Unity Catalog (both the open-source project and the Databricks offering) models and governs ML models as first-class assets, and what we can borrow.

## Action Items

- [x] Research LakeFS features applicable to model storage/versioning.
- [x] Research how other systems build model support on top of LakeFS.
- [x] Investigate how PyTorch model files are stored in LakeFS and how the mount/load step works inside a Python UDF (vs. the direct-load path used for datasets).
- [x] Study Unity Catalog (open source + Databricks) as prior art for models-as-assets.
- [ ] Once findings are gathered, **start a discussion on GitHub** to collect broader feedback on the design.

> Research complete → [ML_MODELS_RESEARCH_FINDINGS.md](ML_MODELS_RESEARCH_FINDINGS.md)
> (covers LakeFS Mount, PyTorch/ONNX/safetensors loading semantics, Unity Catalog, MLflow,
> Hugging Face, Splunk MLTK — plus concrete recommendations and the decisions to raise on GitHub).

## Next Step

Consolidate the research above into the existing discussion notes
([ML_MODELS_DISCUSSION.md](ML_MODELS_DISCUSSION.md)) and open the GitHub discussion.
