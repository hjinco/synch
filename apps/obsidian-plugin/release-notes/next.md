# Next Obsidian plugin release

## Added

## Changed

- Improve sync throughput by reading files concurrently and moving SHA-256 hashing off the renderer thread.
- Reduce unnecessary byte-buffer copies during encrypted blob processing and vault writes.
- Reuse verified local content during pulls, retaining Markdown content as encrypted merge bases and avoiding redundant downloads.

## Fixed
