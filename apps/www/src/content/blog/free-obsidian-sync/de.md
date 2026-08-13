---
title: "Kostenloses Obsidian Sync: So synchronisieren Sie Obsidian-Notizen ohne Abo"
description: "Suchen Sie eine kostenlose Obsidian-Synchronisierung? Vergleichen Sie Cloud-Speicher, Syncthing, Git, Community-Plugins und den kostenlosen Plan von Synch, bevor Sie sich für eine Vault-Synchronisierung entscheiden."
pubDate: 2026-05-09
---

Wenn Sie nach **kostenlosem Obsidian Sync** suchen, wollen Sie vermutlich etwas ganz Einfaches: Ihre Notizen auf jedem Gerät, ohne ein weiteres Abo.

Das ist nachvollziehbar. Obsidian selbst ist für den privaten Gebrauch kostenlos, Ihre Notizen sind gewöhnliche Markdown-Dateien, und ein Vault sieht aus wie ein ganz normaler Ordner. Da fühlt es sich an, als müsste die Synchronisierung einfach sein.

Manchmal ist sie das. Manchmal nicht.

Wichtig ist: „Obsidian kostenlos synchronisieren“ kann mehrere Dinge bedeuten:

- einen Cloud-Speicher nutzen, den Sie ohnehin bezahlen
- ein kostenloses Peer-to-Peer-Sync-Tool betreiben
- Git als manuellen Sync-Ablauf nutzen
- ein Community-Sync-Plugin installieren
- eine gehostete Obsidian-Sync-Alternative mit kostenlosem Plan wählen

Diese Optionen sind nicht austauschbar. Sie unterscheiden sich bei Datenschutz, Konfliktbehandlung, Mobilverhalten, Einrichtungsaufwand und Wiederherstellung, wenn etwas schiefgeht.

## Ist Obsidian Sync kostenlos?

Der offizielle Dienst [Obsidian Sync](https://obsidian.md/sync) ist nicht kostenlos. Die Obsidian-App können Sie kostenlos nutzen, Sync ist jedoch ein optionales, kostenpflichtiges Add-on.

Zum Zeitpunkt der Veröffentlichung nennt Obsidian auf der [Preisseite](https://obsidian.md/pricing) Sync mit 4 US-Dollar pro Nutzer und Monat bei jährlicher Abrechnung bzw. 5 US-Dollar pro Nutzer und Monat bei monatlicher Abrechnung.

Das heißt nicht, dass der Preis überzogen wäre. Offizielles Obsidian Sync ist ausgereift, integriert, Ende-zu-Ende-verschlüsselt und stammt vom selben Team, das Obsidian entwickelt. Für viele Nutzer ist das Bezahlen des offiziellen Dienstes die einfachste und sicherste Wahl.

Wenn Ihre Suche aber mit „kostenlos“ beginnt, optimieren Sie vermutlich für eines davon:

- ein kleines privates Vault
- einen Studien- oder Hobby-Workflow
- die Vermeidung einer weiteren monatlichen Zahlung
- Open-Source-Werkzeuge
- Self-Hosting oder mehr Kontrolle
- einen Test, ob synchronisiertes Obsidian zu Ihrem Ablauf passt

Für diese Fälle gibt es mehrere kostenlose oder günstigere Wege, die sich zu kennen lohnen.

## Was eine kostenlose Obsidian-Sync-Einrichtung trotzdem leisten muss

Ein Obsidian-Vault ist mehr als ein Ordner voller Notizen. Darin können Markdown-Dateien, Bilder, PDFs, Canvas-Dateien, Plugin-Einstellungen, Themes, Snippets und versteckte `.obsidian`-Konfigurationsdateien liegen.

Eine gute Sync-Einrichtung muss mehr tun als hoch- und herunterladen.

Sie sollte Fragen wie diese beantworten helfen:

- Was passiert, wenn zwei Geräte dieselbe Notiz bearbeiten?
- Funktioniert die mobile Synchronisierung zuverlässig?
- Werden Dateipfade und Notizinhalte verschlüsselt, bevor sie einen Server erreichen?
- Können Sie nach einer misslungenen Bearbeitung eine ältere Version wiederherstellen?
- Werden große Anhänge vorhersehbar behandelt?
- Können Sie einen Konflikt verstehen und beheben, wenn einer entsteht?

Kostenlose Werkzeuge können gut funktionieren, verlagern aber oft mehr Verantwortung auf Sie. Das ist der eigentliche Kompromiss.

## Option 1: Cloud-Speicher

Die einfachste kostenlose Obsidian-Sync-Einrichtung ist meist ein Cloud-Speicher: iCloud Drive, Dropbox, Google Drive, OneDrive oder ein anderer Dateisync-Anbieter.

Wenn Sie einen dieser Dienste bereits nutzen und Ihr Vault klein ist, kann das ausreichen. Sie legen das Vault in den synchronisierten Ordner, öffnen es auf einem anderen Gerät und lassen den Cloud-Speicher die Dateien bewegen.

Der Vorteil ist Bequemlichkeit. Meist brauchen Sie kein neues Konto, keinen speziellen Server und keine aufwendige Einrichtung.

Die Schwäche: Allgemeine Cloud-Speicher sind nicht auf Obsidian ausgelegt. Sie synchronisieren Dateien, verstehen aber kein Vault-Verhalten. Schnelle Bearbeitungen, Änderungen an Plugin-Einstellungen, Einschränkungen der Hintergrundsynchronisierung auf dem Handy und Konfliktkopien können schnell frustrieren.

Cloud-Speicher eignen sich am besten für einfache Vaults, überwiegend Ein-Geräte-Bearbeitung und Nutzer, die dem Speicheranbieter ihre Dateien ohnehin anvertrauen.

## Option 2: Syncthing

[Syncthing](https://syncthing.net/) ist ein kostenloses Open-Source-Werkzeug für Peer-to-Peer-Dateisynchronisierung. Statt Ihr Vault in einem zentralen Cloud-Dienst zu speichern, synchronisiert es Dateien direkt zwischen Ihren Geräten.

Das ist attraktiv, wenn Sie Open-Source-Sync wollen und keinen gehosteten Anbieter dazwischen haben möchten. Für Desktop-zu-Desktop-Abläufe kann Syncthing ausgezeichnet sein.

Der Kompromiss ist die Verfügbarkeit. Geräte müssen in der Regel zur richtigen Zeit online sein, um Änderungen auszutauschen. Die Einrichtung auf dem Handy ist außerdem oft weniger geradlinig als bei einem gehosteten Sync-Dienst, besonders unter iOS.

Syncthing ist eine starke kostenlose Wahl für technikaffine Nutzer, die Dateisync verstehen und die Kontrolle von Gerät zu Gerät behalten wollen.

## Option 3: Git

Git kann kostenlos, leistungsfähig und nachvollziehbar sein. Sie bekommen Verlauf, Diffs, Branches, Commits und die Möglichkeit, Ihr Vault zu einem Remote-Git-Host oder auf einen eigenen Server zu pushen.

Für Entwickler fühlt sich das natürlich an. Für alle anderen kann es wirken, als würde aus dem Notieren Softwarewartung.

Das Problem ist nicht, dass Git schwach wäre. Das Problem ist, dass Git von Ihnen verlangt, in Commits, Pulls, Pushes, Merges, Authentifizierung und Konflikten zu denken. Das ist ein gutes Modell für Code. Für schnelle Notizen vom Handy ist es nicht immer ein gutes Modell.

Git eignet sich am besten, wenn Sie ohnehin explizite Versionskontrolle wollen und Merge-Konflikte selbst beheben können.

## Option 4: Community-Sync-Plugins

Community-Plugins können Obsidian-spezifischer arbeiten als ein allgemeines Dateisync-Werkzeug.

[Remotely Save](https://github.com/remotely-save/remotely-save) etwa lässt Sie über Speicher-Backends wie WebDAV, S3-kompatiblen Speicher, Dropbox, OneDrive, Google Drive, Box, pCloud und andere synchronisieren. [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) ist eine leistungsfähige Option für alle, die ein selbst gehostetes Sync-System mit Echtzeitverhalten wollen.

Diese Werkzeuge können ausgezeichnet sein, aber „kostenlos“ hängt vom Backend ab. Ein Plugin kann kostenlos sein, während Speicherdienst, Server, Domain, Wartungszeit oder selbst gehostete Infrastruktur trotzdem Kosten verursachen.

Community-Plugins eignen sich am besten, wenn Sie Flexibilität wollen und bereit sind, die Speicherschicht selbst zu wählen oder zu betreiben.

## Option 5: Der kostenlose Plan von Synch

Synch ist ein Open-Source-Dienst mit Ende-zu-Ende-Verschlüsselung für Obsidian. Er richtet sich an alle, die etwas näher an einem gehosteten Sync-Erlebnis wollen, ohne den vollen Preis des offiziellen Dienstes.

Synch hat einen kostenlosen Plan, mit dem Sie ein Obsidian-Vault ohne Zahlung synchronisieren können. Der aktuelle Free-Plan umfasst:

- 1 synchronisiertes Vault
- 50 MB Speicher
- 3 MB maximale Dateigröße
- 1 Tag Versionsverlauf

Das ist bewusst klein. Es soll keinen großen kostenpflichtigen Plan für ein Vault voller Anhänge ersetzen. Es soll private gehostete Synchronisierung für kleine Vaults, Tests, schlanke Notizen und alle zugänglich machen, die den Ablauf vor einem Upgrade ausprobieren wollen.

Synch hat außerdem einen günstigen Starter-Plan für alle, die mehr Platz brauchen: 1 GB Speicher, 5 MB maximale Dateigröße und 1 Monat Versionsverlauf.

Der zentrale Unterschied zum einfachen Cloud-Dateisync: Synch ist um Obsidian-Vault-Sync und Ende-zu-Ende-Verschlüsselung herum gebaut. Ihre Vault-Daten werden lokal verschlüsselt, bevor sie hochgeladen werden, und der Server sollte Ihre Notizinhalte nicht lesen können. Wenn Sie die technische Fassung wollen, lesen Sie [wie die Ende-zu-Ende-Verschlüsselung von Synch funktioniert](/de/blog/encryption-and-decryption).

Synch eignet sich am besten für alle, die kostenlose oder günstige gehostete Synchronisierung, Open-Source-Code und einen auf Obsidian ausgerichteten Ablauf wollen.

## Kostenlose Obsidian-Sync-Optionen im Vergleich

| Option | Kostenlos? | Am besten für | Wichtigster Kompromiss |
| --- | --- | --- | --- |
| Cloud-Speicher | Oft, wenn Sie bereits Speicher haben | Einfache Vaults und unkomplizierte Einrichtung | Nicht auf Obsidian ausgelegt |
| Syncthing | Ja | Peer-to-Peer-Sync und Gerätekontrolle | Geräte und Mobilverhalten brauchen Aufmerksamkeit |
| Git | Ja, abhängig vom Remote-Hosting | Entwickler und expliziten Versionsverlauf | Manueller Sync und Konfliktablauf |
| Remotely Save | Plugin ist kostenlos; Backend kann Kosten verursachen | Eigenen Speicher mitbringen | Einrichtung hängt vom Anbieter ab |
| Self-hosted LiveSync | Software ist kostenlos; Infrastruktur kann Kosten verursachen | Technische Self-Hoster | Backend-Wartung |
| Synch Free | Ja | Kleine Vaults und gehosteter E2EE-Sync | Speicher- und Verlaufslimits |
| Obsidian Sync | Nein | Offizieller, ausgereifter Sync | Kostenpflichtiges Abo |

## Welche kostenlose Option sollten Sie wählen?

Wählen Sie einen Cloud-Speicher, wenn Ihr Vault klein ist, Sie überwiegend von einem Gerät aus bearbeiten und diesem Anbieter bereits vertrauen.

Wählen Sie Syncthing, wenn Sie kostenlosen Peer-to-Peer-Sync wollen und mit der Geräteverwaltung zurechtkommen.

Wählen Sie Git, wenn Sie Git bereits nutzen und expliziten Verlauf höher gewichten als automatische Hintergrundsynchronisierung.

Wählen Sie Remotely Save oder Self-hosted LiveSync, wenn Sie ein Community-Plugin wollen und bereit sind, Speicher oder Infrastruktur einzurichten.

Wählen Sie Synch Free, wenn Sie eine gehostete, Ende-zu-Ende-verschlüsselte Obsidian-Sync-Alternative mit einem echten Free-Plan und einfacherer Einrichtung als beim Self-Hosting wollen.

Wählen Sie offizielles Obsidian Sync, wenn Sie das am stärksten integrierte Erlebnis wollen und die Abo-Kosten akzeptabel sind.

## Das Fazit

Es gibt nicht die eine beste kostenlose Obsidian-Sync-Einrichtung für alle.

Die beste Wahl hängt davon ab, was „kostenlos“ für Sie bedeutet. Kostenlos kann heißen: kein Abo, kein gehosteter Anbieter, kein proprietärer Sync-Dienst, keine Infrastrukturrechnung – oder einfach ein Free-Plan, der für ein kleines Vault reicht.

Wenn Ihnen Ihre Notizen wichtig sind, wählen Sie nicht nur nach dem Preis. Wählen Sie die Sync-Methode, die zu Ihren Datenschutzansprüchen, Ihren Geräten, Ihrer Toleranz für Einrichtungsaufwand und dazu passt, wie viel Wiederherstellungsverlauf Sie brauchen, wenn etwas schiefgeht.
