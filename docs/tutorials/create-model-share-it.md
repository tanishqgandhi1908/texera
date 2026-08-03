---
title: "Create a Model, upload files to it, and share it"
weight: 25
---

This tutorial walks through managing an ML model in Texera: creating it, uploading a version, controlling
who can see it, and publishing it to the hub so other users can discover it.

Models are a sibling of [datasets](create-dataset-upload-data.md) — they are versioned, stored in the same
object store, and shared through the same access-control model. What differs is that a model also records
its **framework** (for example `pytorch`) and its serialization **format** (for example `safetensors`), and
those two fields are searchable.

> The **Models** section is behind a feature flag. If you do not see it in the sidebar, an administrator can
> enable it under **Admin → Settings** by turning on `models_enabled`.

**1. Create a model**

 * Go to the **Models** tab and click the model-creation icon.
 * Give the model a name. Model names may contain letters, digits, underscores and hyphens — unlike dataset
   names, underscores are preserved rather than collapsed to hyphens.
 * Choose the **framework** and **format** from the dropdowns, add a description, and click `Create`.

The model is created empty. Files are added in the next step as a version.

**2. Upload files as a version**

 * Open the model and expand the upload panel.
 * Drag your model directory onto the upload area. **Drag the folder itself** if you want to keep its
   nested structure — the "Browse & Upload Files" button flattens paths.
 * Uploaded files appear as staged changes. Enter a version name and create the version to commit them.

Large weight files are uploaded in parts automatically. If a file is rejected before the upload starts, it
exceeds `single_file_upload_max_size_mib`, which an administrator can raise under **Admin → Settings**.

**3. Set a cover image**

If the version contains an image (`.jpg`, `.jpeg`, `.png`, `.gif` or `.webp`), right-click it in the file
tree and choose **Set as cover**. The image is displayed on the model's detail page and on its card in
listings. The cover always refers to a file already committed in the model, so it is versioned along with
everything else.

**4. Share the model with specific people**

 * Click the share icon on the model's card or list row.
 * Enter one or more email addresses and pick **READ** or **WRITE**, then grant access.

Each recipient gets an email containing a direct link to the model. A **WRITE** collaborator can upload new
versions and re-share the model; a **READ** collaborator can only view and download it.

You can change or revoke someone's access at any time from the same dialog.

**5. Publish the model**

The same dialog has a **Private / Public** toggle:

| State | Who can see it |
| --- | --- |
| Private | Only you and the people you granted access to |
| Public | Every Texera user, and it appears in the hub |

Publishing grants read access to all users. Unpublishing revokes it again, leaving only your explicit grants
in place. Separately, the model's detail page has a **Downloadable** toggle that controls whether users other
than the owner may download the model's files.

**6. Find models on the hub**

Public models are listed under **Hub → Models**, where you can search them by name, description, framework or
format — so searching for `pytorch` or `safetensors` finds every matching public model. You can like a model,
and its view count increases as people open it. The hub landing page also shows the most-liked models.

**7. Download a model**

Use the download action on the model's card or list row to get the whole model as a zip, or download an
individual file from the file tree on the detail page. Downloads are refused for users other than the owner
when the model is marked as not downloadable.
