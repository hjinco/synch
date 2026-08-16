---
title: Terms of Service
description: Terms that apply to the hosted Synch service.
updatedDate: 2026-08-16
---

Last updated: August 16, 2026

These Terms of Service ("Terms") govern your access to and use of the hosted Synch service, including the Synch website, API, and hosted sync infrastructure (the "Service"). The Service is operated by Synch ("Synch", "we", "us", or "our").

By creating an account, connecting an Obsidian client, or using the Service, you agree to these Terms. If you do not agree, do not use the Service.

## 1. Eligibility

You must be legally able to enter into these Terms. You may not use the Service if you are barred from doing so under applicable law.

The Service is not intended for children under 13, or the minimum age required in your jurisdiction to use online services without parental consent.

## 2. The Service

Synch provides end-to-end encrypted sync for Obsidian vaults. The Synch Obsidian plugin encrypts vault file contents and file path metadata on your device before that data is uploaded to Synch-hosted infrastructure. The hosted Service stores encrypted blobs, encrypted metadata, sync state, account records, and operational metadata needed to provide sync.

Synch is not Obsidian and is not affiliated with Obsidian unless we say otherwise.

## 3. Accounts And Security

You are responsible for maintaining the confidentiality of your account credentials, device access, vault password, encryption keys, and recovery materials. You are responsible for activity under your account unless caused by Synch's breach of these Terms.

Synch cannot recover plaintext vault contents, plaintext file paths, or plaintext vault keys for you if you lose the secret needed to decrypt them. If you lose access to your keys or password, your encrypted synced data may be unrecoverable.

You must provide accurate account information and keep your email address current so we can send account, security, and service notices.

## 4. Your Content

You retain ownership of the notes, files, and other content you choose to sync through the Service ("User Content").

You grant Synch a limited permission to host, store, transmit, process, copy, and delete your User Content only as needed to provide, secure, troubleshoot, maintain, and improve the Service. For vault data, this permission applies to the encrypted form that Synch receives and stores.

You represent that you have the rights needed to upload and sync your User Content and that your use of the Service will not violate applicable law or the rights of others.

## 5. End-To-End Encryption

Synch is designed so that vault file contents and file path metadata are encrypted by the client before leaving your device. Synch stores encrypted blobs and encrypted sync metadata in Cloudflare R2 and stores sync state in Cloudflare-hosted services.

Synch does not receive the plaintext contents of your notes, plaintext file paths, or plaintext vault keys. Synch stores wrapped key envelopes so that authorized clients can unlock a vault using user-held secrets. A wrapped key envelope is not the plaintext vault key.

End-to-end encryption does not hide all information from Synch. For example, Synch may process account information, vault identifiers and names, organization and membership records, invitation records, local vault identifiers, blob identifiers, file sizes, storage usage, timestamps, sync cursors, session information, IP addresses, User-Agent strings, billing identifiers when billing is enabled, and similar operational metadata.

## 6. Acceptable Use

You may not use the Service to:

- Violate any law or regulation.
- Infringe or misappropriate another person's rights.
- Upload, store, or transmit malware or harmful code.
- Attack, disrupt, overload, scan, scrape, or interfere with the Service or its infrastructure.
- Attempt to bypass authentication, authorization, quotas, storage limits, rate limits, or security controls.
- Abuse invitations, accounts, billing, support, or automated systems.
- Use the Service in a way that could create legal, security, or operational risk for Synch or other users.

Because Synch cannot inspect plaintext encrypted vault contents, you remain fully responsible for your User Content and your use of the Service.

## 7. Plans, Quotas, And Billing

Synch may offer free, trial, paid, or limited plans. Plans may include limits on synced vaults, storage, maximum file size, version history, traffic, devices, or other usage.

Paid plans are available for the hosted Service. Billing is handled by Polar, and subscription management may be available through a Polar customer portal linked from Synch. Payment information, taxes, renewals, cancellations, refunds, and subscription terms may be subject to additional checkout or billing portal terms shown at the time of purchase or management.

We may change plans, prices, limits, or included features. If a change materially affects a paid plan, we will provide notice as required by law or by the terms shown at purchase.

## 8. Backups And Data Loss

Synch is a sync service, not a complete backup system. You are responsible for maintaining independent backups of important data.

We work to provide a reliable service, but sync conflicts, client bugs, network failures, storage failures, account compromise, lost keys, user error, or service interruptions may cause data loss or make encrypted data unrecoverable.

## 9. Deletion, Suspension, And Termination

You may stop using the Service at any time. You may request deletion of your account or vaults using the controls we provide or by contacting us at contact@synch.run.

When an account or vault is deleted, Synch will delete or schedule deletion of associated service records and encrypted blobs, subject to operational queues, backups, logs, legal obligations, security needs, and abuse-prevention needs.

For remote vaults on a free plan, Synch may permanently delete a remote vault once no vault content change has been synchronized to it for 90 consecutive days. Connecting to or opening a vault does not extend this period; a content change must be synchronized successfully. Synch will email the vault owner once the deletion has been carried out. Synchronizing a content change, or upgrading to a paid plan, before the 90 days elapse prevents the deletion. After deletion, the remote vault's encrypted data, encrypted metadata, sync state, version history, and related service records may not be recoverable. This policy does not delete files from your local Obsidian vault. Backup copies may be retained and deleted according to the retention practices described above.

We may suspend or terminate access to the Service if we reasonably believe you violated these Terms, created risk for the Service or other users, failed to pay amounts owed, or used the Service unlawfully.

## 10. Service Changes

Synch may evolve as the Service develops. We may add, remove, or modify features, limits, APIs, storage formats, client requirements, pricing, plan availability, billing providers, and hosted infrastructure. We may discontinue the Service or any part of it.

Where practical, we will provide notice of material changes that affect your ability to access synced data, but you are responsible for keeping your own backups and exportable copies.

## 11. Open Source And Self-Hosting

Synch source code is published on GitHub under the MIT License. The MIT License gives you rights to inspect, copy, modify, distribute, and self-host the software according to its terms.

These Terms govern the hosted Synch Service. The MIT License does not grant you rights to misuse the Synch name, logo, domains, hosted infrastructure, accounts, API credentials, or other service resources. If you self-host Synch independently, your self-hosted deployment is not the hosted Service covered by these Terms.

## 12. Third-Party Services

The Service depends on third-party infrastructure and services, including Cloudflare for hosting, storage, and related infrastructure, and Polar for checkout, subscription management, customer portal sessions, payment processing, and related billing operations. Third-party services may process information as described in our Privacy Policy and their own terms.

## 13. Disclaimers

The Service is provided "as is" and "as available." To the fullest extent permitted by law, Synch disclaims all warranties, whether express, implied, or statutory, including warranties of merchantability, fitness for a particular purpose, title, non-infringement, availability, reliability, security, and data integrity.

We do not guarantee that the Service will be uninterrupted, error-free, secure, or that encrypted data can always be synced, restored, or recovered.

## 14. Limitation Of Liability

To the fullest extent permitted by law, Synch and its affiliates, maintainers, contributors, officers, employees, contractors, and agents will not be liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for lost profits, lost revenue, lost data, loss of goodwill, security incidents, service interruption, or cost of substitute services.

To the fullest extent permitted by law, Synch's total liability for all claims relating to the Service will not exceed the greater of the amount you paid Synch for the hosted Service in the 12 months before the event giving rise to the claim or USD $100.

Some jurisdictions do not allow certain limitations of liability, so some of these limits may not apply to you.

## 15. Indemnity

To the fullest extent permitted by law, you agree to defend, indemnify, and hold harmless Synch and its affiliates, maintainers, contributors, officers, employees, contractors, and agents from claims, damages, liabilities, losses, costs, and expenses, including reasonable attorneys' fees, arising from your User Content, your use of the Service, your violation of these Terms, or your violation of law or third-party rights.

## 16. Changes To These Terms

We may update these Terms from time to time. If we make material changes, we will provide notice through the Service, by email, or by another reasonable method. The updated Terms will become effective when posted unless a later date is stated.

Your continued use of the Service after updated Terms become effective means you accept the updated Terms.

## 17. Contact

Questions about these Terms may be sent to:

Synch  
contact@synch.run
