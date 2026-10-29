# Next Obsidian plugin release

## Added

- A conflict view (command: "Open conflict view") listing the conflict copies sync left in your vault. Each entry shows the file it belongs to, when the copy was made, and the size of both versions; select the name to open the file.
- Resolve a conflict from a comparison of the two versions (a line-by-line diff for text, side by side for images) by keeping the original or keeping the copy. When the copy only adds lines to the original, it can be merged after reviewing the comparison. If either file has changed since the comparison was opened, resolution stops so you can review the updated versions. Resolved copies are removed according to your trash settings.

## Changed

- Conflict contents and automatic merge availability are loaded when opening a comparison. The conflict list refreshes only for relevant file changes and batches bursts of changes.

## Fixed

- Fix automatic conflict merging through the comparison dialog and protect both keep-side actions against files changed since review, including binary files and newly recreated originals.

- Prevent other editors’ cursor names from becoming document text when backspacing on mobile.
