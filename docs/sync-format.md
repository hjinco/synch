# Sync Format

## Encrypted blob envelopes

Sync blob transport and storage use binary request/response bodies:

- The Obsidian plugin uploads encrypted blob bytes to `PUT /v1/vaults/:vaultId/blobs/:blobId`.
- The API streams those bytes directly into R2.
- Downloads return the R2 object body directly.

All file blobs use the v2 binary envelope. The format is fixed and is not
selected per vault. The `syncFormatVersion` response field is retained only
for compatibility with older plugin versions.

## v2 binary envelope

The v2 blob envelope is binary:

```text
offset  size  value
0       4     magic bytes: 0x53 0x59 0x4e 0x42 ("SYNB")
4       1     binary envelope version: 0x02
5       12    AES-GCM nonce
17      rest  AES-GCM ciphertext, including the authentication tag
```

The v2 HKDF info and AES-GCM additional authenticated data use version `v2`.

## Metadata envelopes

Metadata envelopes remain in the v1 JSON format. This is a separate metadata
envelope version and does not select or represent the file blob sync format.
The v2 binary envelope applies only to encrypted file blob payloads.
