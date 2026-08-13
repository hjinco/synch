---
title: "Remotely Save für Obsidian: Einrichtung, Vor- und Nachteile und Alternativen"
description: "Ein praktischer Leitfaden zu Remotely Save für Obsidian: unterstützte Speicheranbieter, Verschlüsselung, Konflikthandling, mobile Synchronisierung und wann Synch die bessere Wahl ist."
pubDate: 2026-05-11
---

Wenn Sie Obsidian synchronisieren möchten, ohne für den offiziellen Dienst zu bezahlen, ist **Remotely Save** eines der ersten Community-Plugins, auf die Sie stoßen.

Das ist kein Zufall. Statt Sie auf einen Synchronisierungsanbieter festzulegen, verbindet Remotely Save ein Obsidian-Vault mit einem Speicher, den Sie selbst wählen: S3-kompatibler Speicher, WebDAV, Dropbox, OneDrive, Google Drive, Box, pCloud, Koofr, Azure Blob Storage und weitere Backends, je nach Funktionsstufe.

Genau diese Flexibilität ist der Punkt.

Und genau das ist auch der Kompromiss.

Remotely Save kann hervorragend passen, wenn Sie bereits wissen, wo Ihre Vault-Daten liegen sollen, und bereit sind, Synchronisierungseinstellungen selbst zu konfigurieren. Wenn Sie eigentlich einen einfachen, auf Obsidian ausgerichteten Synchronisierungsdienst wollen, bevorzugen Sie möglicherweise irgendwann ein anderes Werkzeug.

Dieser Leitfaden erklärt, wie Remotely Save funktioniert, wann es eine gute Wahl ist, worauf Sie achten sollten und wann eine Alternative wie Synch einfacher sein kann.

![Ein Obsidian-Vault, das mit mehreren selbst gewählten Speicher-Backends verbunden ist](./remotely-save-storage-options.webp)

## Was ist Remotely Save?

[Remotely Save](https://github.com/remotely-save/remotely-save) ist ein inoffizielles Community-Plugin für Obsidian, mit dem sich Notizen zwischen einem lokalen Vault und einem entfernten Cloud-Speicher synchronisieren lassen.

Es ist nicht der offizielle Obsidian-Sync-Dienst. Es läuft in Obsidian als Plugin und nutzt den von Ihnen gewählten Speicheranbieter als entfernten Synchronisierungsort.

Das Grundmodell sieht so aus:

```txt
Obsidian vault on device A
        |
Remotely Save plugin
        |
your chosen remote storage
        |
Remotely Save plugin
        |
Obsidian vault on device B
```

Der entfernte Speicher vermittelt zwischen den Geräten. Je nach Einrichtung kann das ein S3-kompatibler Bucket, ein WebDAV-Server, Dropbox, OneDrive, Google Drive oder ein anderer unterstützter Dienst sein.

## Warum Menschen Remotely Save nutzen

Der wichtigste Grund für Remotely Save ist Kontrolle.

Beim offiziellen Obsidian-Sync-Dienst ist der Synchronisierungsdienst vorgegeben. Mit Remotely Save bringen Sie Ihren eigenen Speicher mit. Das ist attraktiv, wenn Sie bereits einen Speicheranbieter nutzen, Daten in einem bestimmten Cloud-Konto behalten wollen oder eine Lösung bevorzugen, die nicht an ein einziges gehostetes Synchronisierungsprodukt gebunden ist.

Remotely Save ist besonders interessant, wenn:

- Sie Obsidian über einen Speicher synchronisieren möchten, dem Sie bereits vertrauen
- Sie S3-kompatiblen Speicher wie Cloudflare R2, Backblaze B2, MinIO oder Amazon S3 nutzen möchten
- Sie WebDAV über einen selbst gehosteten Server, Synology, Nextcloud oder einen anderen Anbieter nutzen möchten
- Sie einen Workflow über ein Obsidian-Plugin bevorzugen statt eines separaten Desktop-Synchronisierungstools
- Sie Mobilgeräte und Desktop über dasselbe Plugin synchronisieren möchten
- Sie bereit sind, Einstellungen sorgfältig zu lesen, bevor Sie einem Vault die Synchronisierung anvertrauen

Für technisch versierte Nutzer kann diese Flexibilität wichtiger sein als die einfachstmögliche Einrichtung.

## Unterstützte Speicheranbieter

Remotely Save unterstützt mehrere Speicher-Backends. Die genaue Auswahl hängt von Plugin-Version und Funktionsstufe ab. Das Projekt nennt unter anderem:

| Speicher-Backend | Warum Nutzer es wählen | Wichtigster Kompromiss |
| --- | --- | --- |
| S3-kompatibler Speicher | Flexibel, günstig, funktioniert mit Anbietern wie R2, B2, MinIO und S3 | Erfordert Bucket, Schlüssel, Endpoint und Kostenbewusstsein |
| WebDAV | Funktioniert mit vielen selbst gehosteten Setups und NAS-Systemen | Die Qualität hängt stark vom WebDAV-Server ab |
| Dropbox | Vertrauter gehosteter Speicher | Sie verlassen sich auf einen allgemeinen Cloud-Drive-Anbieter |
| OneDrive | Praktisch für persönliche Microsoft-Konten | Die kostenlose Version nutzt den App Folder; voller Zugriff auf persönliches OneDrive ist ein PRO-Merkmal, und Geschäftskonten sind nicht das dokumentierte Ziel |
| Google Drive | Vertrauter Speicher für viele Nutzer | Die Google-Drive-Unterstützung ist ein PRO-Connect-Merkmal |
| Box, pCloud, Koofr, Azure Blob und andere | Nützlich, wenn Sie diese Dienste bereits nutzen | Die genannten Anbieter sind PRO-Connect-Merkmale |

Das ist der wesentliche Unterschied zwischen Remotely Save und den meisten Obsidian-Synchronisierungsalternativen. Es ist nicht nur ein Synchronisierungsdienst. Es ist eine Brücke zwischen Obsidian und vielen möglichen entfernten Speichersystemen.

Diese Brücke ist mächtig, aber Sie müssen das Speichersystem auf der anderen Seite trotzdem verstehen.

## Typischer Einrichtungsablauf

Die genaue Einrichtung hängt vom Anbieter ab, aber die meisten Remotely-Save-Konfigurationen folgen demselben Muster:

1. Sichern Sie Ihr Obsidian-Vault außerhalb des Synchronisierungsziels.
2. Installieren Sie Remotely Save über den Community-Plugin-Browser von Obsidian.
3. Wählen Sie in den Plugin-Einstellungen einen entfernten Dienst.
4. Geben Sie Zugangsdaten, Endpoint, Bucket, Ordner oder Autorisierungsdetails des Anbieters ein.
5. Entscheiden Sie, ob Sie Verschlüsselung aktivieren.
6. Entscheiden Sie, ob große Dateien übersprungen oder Pfade ausgeschlossen werden sollen.
7. Führen Sie eine erste Synchronisierung aus.
8. Installieren und konfigurieren Sie das Plugin auf Ihren anderen Geräten.
9. Prüfen Sie, dass dasselbe Vault korrekt erscheint, bevor Sie von mehreren Orten aus bearbeiten.

Der erste Schritt ist der wichtigste. Jedes Synchronisierungswerkzeug kann einen Fehler schnell verbreiten. Bevor Sie ein echtes Vault mit einem neuen Synchronisierungssystem verbinden, legen Sie eine separate Kopie an einem Ort an, den das Plugin nicht erreichen kann.

## Verschlüsselung in Remotely Save

Remotely Save unterstützt passwortbasierte Ende-zu-Ende-Verschlüsselung. Wenn Sie ein Verschlüsselungskennwort festlegen, werden Dateien verschlüsselt, bevor sie an den entfernten Speicheranbieter gesendet werden.

Das ist wichtig, wenn Sie private Notizen in einem allgemeinen Cloud-Dienst oder Object-Storage-Bucket ablegen.

Einige Details sollten Sie trotzdem verstehen:

- Die Verschlüsselung muss auf jedem Gerät korrekt konfiguriert sein.
- Wenn Sie das Verschlüsselungskennwort vergessen, können Sie die synchronisierten Daten möglicherweise nicht aus dem entfernten Speicher wiederherstellen.
- Manche Metadaten können sich anders verhalten als bei einem eigens dafür gebauten verschlüsselten Synchronisierungsdienst.
- Die Plugin-Einstellungsdatei kann sensible Informationen enthalten und sollte weder geteilt noch in Git übernommen werden.

Verschlüsselung ist nicht nur ein Häkchen. Sie verändert das Wiederherstellungsmodell. Bevor Sie sich darauf verlassen, testen Sie mit einem kleinen Vault und stellen Sie sicher, dass ein anderes Gerät die Daten korrekt entschlüsseln kann.

## Konflikthandling

Beim Konflikthandling fühlen sich Obsidian-Synchronisierungswerkzeuge sehr anders an als gewöhnliche Datei-Upload-Tools.

Ein Obsidian-Vault ändert sich auf viele kleine Weisen. Eine Markdown-Notiz kann sich auf dem Laptop ändern. Eine Plugin-Einstellung kann sich auf dem Telefon ändern. Eine Canvas-Datei oder ein Anhang wird möglicherweise noch hochgeladen, während ein anderes Gerät schon zu bearbeiten beginnt. Wenn zwei Geräte zusammenhängende Dateien ändern, bevor sie den jeweils neuesten Stand gesehen haben, muss das Synchronisierungswerkzeug entscheiden, was zu tun ist.

Remotely Save enthält Konflikterkennung und -behandlung; fortgeschritteneres, intelligenteres Konfliktverhalten gehört zum PRO-Merge-Funktionsumfang. Das kann helfen, ersetzt aber nicht gute Synchronisierungsgewohnheiten.

Sie sollten weiterhin vermeiden:

- dieselbe Notiz auf zwei Geräten stark zu bearbeiten, bevor synchronisiert wird
- mehrere Synchronisierungssysteme auf demselben aktiven Vault laufen zu lassen
- ein Cloud-Backend als vollständiges Backup zu betrachten
- Plugin-Einstellungen zu synchronisieren, ohne Unterschiede zwischen Mobilgerät und Desktop zu verstehen
- Konfliktkopien als harmloses Rauschen zu behandeln

Wenn ein Vault wichtig ist, behalten Sie eine unabhängige Sicherung. Synchronisierung hält Geräte konsistent. Ein Backup gibt Ihnen einen Wiederherstellungspunkt, wenn Konsistenz die falsche Änderung verbreitet.

![Zwei Geräte bearbeiten dasselbe Obsidian-Vault mit einer dezenten Warnung vor einem Synchronisierungskonflikt](./sync-conflict-risk.webp)

## Mobile Synchronisierung

Remotely Save unterstützt Obsidian Mobile, und das ist einer der Gründe für seine Beliebtheit.

Mobile Unterstützung ist wichtig, weil viele generische Synchronisierungswerkzeuge auf Telefonen und Tablets deutlich schwächer sind als auf dem Desktop. Android und iOS beschränken Hintergrundaktivität, Dateizugriff und lang laufende Aufgaben. Ein Plugin, das in Obsidian läuft, kann einfacher zu nutzen sein als eine separate Dateisynchronisierungs-App.

Trotzdem hat die mobile Synchronisierung praktische Grenzen:

- Die Synchronisierung läuft möglicherweise nur zuverlässig, während Obsidian geöffnet ist.
- Große Dateien können auf Mobilgeräten langsam oder problematisch sein.
- OAuth- und Anmeldeabläufe der Anbieter können je nach Plattform unterschiedlich sein.
- Wechselnde mobile Netzwerke können lange Synchronisierungsvorgänge unterbrechen.
- Die Plugin-Einstellungen müssen geräteübergreifend übereinstimmen.

Für ein kleines, markdownzentriertes Vault kann das ausreichen. Bei einem Vault mit vielen Anhängen, großen PDFs, aufgenommenem Audio oder häufigen Bearbeitungen über mehrere Geräte hinweg sollten Sie sorgfältig testen, bevor Sie es als produktive Infrastruktur behandeln.

## Remotely Save im Vergleich zu Obsidian Sync

Remotely Save und Obsidian Sync lösen überlappende Probleme, geben aber unterschiedliche Versprechen.

| Option | Am besten für | Stärke | Kompromiss |
| --- | --- | --- | --- |
| Remotely Save | Nutzer, die eigenen Speicher mitbringen möchten | Flexible Anbieterwahl | Mehr Einrichtung und Verantwortung für das Backend |
| Obsidian Sync | Nutzer, die den offiziellen, integrierten Dienst wollen | Ausgereifte, Obsidian-eigene Erfahrung | Kostenpflichtiges Abo und proprietärer gehosteter Dienst |

Wenn Sie möglichst wenig Reibung wollen, ist Obsidian Sync die einfachere Empfehlung. Es stammt vom Obsidian-Team und ist direkt in die App integriert.

Wenn Ihnen wichtiger ist, den Speicheranbieter selbst zu wählen, ist Remotely Save flexibler.

## Remotely Save im Vergleich zu Syncthing

Syncthing ist eine weitere beliebte kostenlose Option, um Obsidian-Vaults zu synchronisieren. Es ist Open Source und Peer-to-Peer: Ihre Geräte können direkt synchronisieren, ohne zentralen Cloud-Speicheranbieter.

Das ist ein starkes Modell für Desktop-zu-Desktop-Setups.

Der Kompromiss ist die Verfügbarkeit. Geräte müssen in der Regel zur richtigen Zeit online sein. Die mobile Einrichtung kann außerdem umständlicher sein, besonders wenn Sie eine Lösung wollen, die sich in Obsidian natürlich anfühlt.

Remotely Save nutzt entfernten Speicher als Vermittler. Syncthing nutzt die Synchronisierung von Gerät zu Gerät. Was besser ist, hängt davon ab, ob Sie ein Cloud-gestütztes Setup oder ein Peer-to-Peer-Setup bevorzugen.

## Remotely Save im Vergleich zu Self-hosted LiveSync

Self-hosted LiveSync ist ein leistungsfähiges Obsidian-Synchronisierungs-Plugin für Nutzer, die ein fortgeschritteneres, selbst gehostetes Synchronisierungssystem wollen. Es kann gut zu technisch versierten Nutzern passen, die Backend-Infrastruktur betreiben und pflegen können.

Im Vergleich zu Remotely Save ist Self-hosted LiveSync festgelegter in der Synchronisierungsarchitektur. Remotely Save ist breiter bei der Wahl des Speicheranbieters. LiveSync kann leistungsfähiger sein, wenn Sie genau dieses Modell wollen und bereit sind, es korrekt zu betreiben.

Für nicht technische Nutzer können sich beide nach mehr Infrastruktur anfühlen, als sie erwartet haben.

## Wann Remotely Save eine gute Wahl ist

Remotely Save lohnt sich, wenn Sie den Gedanken mögen, Ihren eigenen Synchronisierungs-Stack zu konfigurieren.

Es passt gut, wenn:

- Sie bereits einen bevorzugten Speicheranbieter haben
- Sie S3, R2, B2, MinIO, WebDAV oder ein anderes bestimmtes Backend wollen
- Sie Zugangsdaten und Plugin-Einstellungen verwalten können
- Sie verstehen, dass Synchronisierung nicht dasselbe ist wie ein Backup
- Sie bereit sind, zuerst mit einer Kopie Ihres Vaults zu testen
- Sie ein Community-Plugin statt eines eigenen gehosteten Dienstes wollen

In diesem Zusammenhang kann Remotely Save genau das richtige Werkzeug sein.

## Wann Remotely Save nicht die beste Wahl sein muss

Remotely Save ist möglicherweise nicht die beste Wahl, wenn Ihr eigentliches Ziel einfach lautet: Obsidian privat synchronisieren, mit möglichst wenig Konfiguration.

Ein anderer Ansatz kann besser sein, wenn:

- Sie kein Speicher-Backend wählen oder konfigurieren möchten
- Sie keine Zugriffsschlüssel, WebDAV-URLs, Buckets oder anbieterspezifischen Einstellungen verwalten möchten
- Sie einen Synchronisierungsdienst wollen, der eigens um das Verhalten von Obsidian-Vaults herum entworfen ist
- Sie gehostete Synchronisierung wollen, ohne für den offiziellen Obsidian-Sync-Tarif zu bezahlen
- Sie eine einfachere Geschichte für Wiederherstellung und Einrichtung auf mehreren Geräten wollen

Hier zählt die Unterscheidung:

Remotely Save ist ein flexibles Synchronisierungs-Plugin für Menschen, die eigenen Speicher mitbringen wollen.

Das ist etwas anderes, als einen sofort nutzbaren Obsidian-Synchronisierungsdienst zu wollen.

## Eine einfachere Alternative: Synch

Wenn Remotely Save attraktiv klingt, weil Sie private Obsidian-Synchronisierung wollen, aber weniger attraktiv, weil Sie kein eigenes Backend konfigurieren möchten, lohnt sich ein Blick auf [Synch](https://synch.run/).

Synch ist ein Open-Source-Dienst mit Ende-zu-Ende-Verschlüsselung, der für Obsidian-Nutzer gebaut ist. Statt Sie einen Speicheranbieter mitbringen und in ein Plugin verdrahten zu lassen, stellt Synch die gehostete Synchronisierungsschicht bereit und konzentriert sich direkt auf den Workflow des Obsidian-Vaults.

Damit wird der Kompromiss klarer:

| Wählen Sie Remotely Save, wenn ... | Wählen Sie Synch, wenn ... |
| --- | --- |
| Sie eigenen Speicher mitbringen möchten | Sie gehostete Obsidian-Synchronisierung möchten |
| Sie Anbieter konfigurieren können | Sie weniger Einrichtung möchten |
| Sie bereits S3, WebDAV, Dropbox oder ein anderes Backend nutzen | Sie einen Dienst möchten, der um das Vault herum entworfen ist |
| Sie maximale Flexibilität beim Backend möchten | Sie einen einfacheren verschlüsselten Synchronisierungsweg möchten |

Remotely Save bleibt eine starke Option für Nutzer, die die Speicherschicht selbst kontrollieren wollen. Synch fühlt sich natürlicher an, wenn Sie eigentlich private Obsidian-Synchronisierung wollen, ohne aus der Speicherauswahl ein Projekt zu machen.

![Ein verschlüsseltes Obsidian-Vault, das über einen gehosteten Dienst mit mehreren Geräten synchronisiert](./hosted-encrypted-sync.webp)

## Praktische Sicherheitscheckliste

Unabhängig von der gewählten Synchronisierungsmethode sollten Sie vor dem Verbinden eines wichtigen Vaults ein paar Regeln befolgen:

- Legen Sie vor der ersten Synchronisierung eine vollständige Sicherung an.
- Testen Sie zuerst mit einem kleinen Vault.
- Betreiben Sie nicht zwei Synchronisierungswerkzeuge auf demselben aktiven Vault.
- Bestätigen Sie Verschlüsselung und Entschlüsselung auf einem zweiten Gerät, bevor Sie der Einrichtung vertrauen.
- Halten Sie Zugangsdaten und Plugin-Einstellungen aus Git heraus.
- Beobachten Sie, was mit `.obsidian`-Einstellungen passiert, bevor Sie sie breit synchronisieren.
- Behalten Sie auch dann eine unabhängige Sicherung, wenn die Synchronisierung zu funktionieren scheint.

Der letzte Punkt ist nicht optional. Synchronisierungswerkzeuge sind dafür gebaut, dass sich Geräte einig werden. Wenn eine falsche Löschung oder eine leere Datei zum vereinbarten Stand wird, brauchen Sie ein Backup außerhalb der Synchronisierungsschleife.

## Fazit

Remotely Save gehört zu den nützlichsten Obsidian-Synchronisierungs-Plugins, weil es Ihnen Wahlfreiheit gibt. Sie können Ihr Vault mit Speicher verbinden, den Sie bereits nutzen, Verschlüsselung konfigurieren, Desktop und Mobilgerät synchronisieren und vermeiden, an einen einzigen offiziellen Dienst gebunden zu sein.

Aber diese Wahl bringt Verantwortung mit. Sie müssen ein Backend wählen, es korrekt konfigurieren, seine Grenzen verstehen und Ihren Wiederherstellungsweg testen.

Wenn Sie diese Kontrolle wollen, verdient Remotely Save einen ernsthaften Blick.

Wenn Sie vor allem private, gehostete, Ende-zu-Ende-verschlüsselte Obsidian-Synchronisierung mit weniger beweglichen Teilen wollen, kann Synch die einfachere Option sein.
