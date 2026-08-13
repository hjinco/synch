---
title: "So synchronisieren Sie Obsidian unter Windows und Android"
description: "Erfahren Sie, wie Sie Obsidian zwischen Windows und Android mit Obsidian Sync, Syncthing, Cloud-Speicher, Git und Synch, einer privaten verschlüsselten Sync-Alternative, synchronisieren."
pubDate: 2026-05-09
---

Wenn Sie wissen wollen, **wie Sie Obsidian unter Windows und Android synchronisieren**, lautet die kurze Antwort: Nutzen Sie Obsidian Sync, wenn Sie die einfachste offizielle Option wollen, Syncthing, wenn Sie eine kostenlose technische Einrichtung wollen, oder Synch, wenn Sie eine private, Ende-zu-Ende-verschlüsselte Obsidian-Sync-Alternative wollen.

Windows und Android sind eine gute Obsidian-Kombination, weil beide Plattformen direkten Zugriff auf lokale Ordner bieten – stärker als iOS. Dadurch werden mehrere Sync-Methoden möglich.

Aber nicht jede Methode ist für Ihr Vault gleich sicher.

Obsidian speichert Ihre Notizen als lokale Markdown-Dateien. Ihr Vault kann außerdem Anhänge, Plugin-Einstellungen, Themes, Snippets und den Konfigurationsordner `.obsidian` enthalten. Ein Sync-Werkzeug muss diese Dateien bewegen, ohne Duplikate, Konflikte oder kaputte Einstellungen zu erzeugen.

Dieser Leitfaden konzentriert sich ausschließlich auf die Synchronisierung von Obsidian zwischen einem Windows-PC und einem Android-Smartphone.

![Verschlüsselte Obsidian-Synchronisierung zwischen einem Windows-Laptop und einem Android-Smartphone](./windows-android-encrypted-sync.webp)

## Die besten Optionen für Windows und Android

| Methode | Am besten für | Kosten | Datenschutz | Schwierigkeit |
| --- | --- | --- | --- | --- |
| Obsidian Sync | Nutzer, die die offizielle Einrichtung wollen | Kostenpflichtig | Ende-zu-Ende-verschlüsselt | Einfach |
| Synch | Nutzer, die privaten gehosteten Sync mit einem kostenlosen oder günstigen Plan wollen | Kostenlose und kostenpflichtige Pläne | Ende-zu-Ende-verschlüsselt | Einfach |
| Syncthing | Technische Nutzer, die kostenlosen Gerät-zu-Gerät-Sync wollen | Kostenlos | Privater Peer-to-Peer-Sync | Mittel |
| Google Drive, Dropbox oder OneDrive | Desktop-lastige Abläufe | Oft kostenlos innerhalb der Speicherlimits | Hängt vom Anbieter ab | Mittel |
| Git | Entwickler und technische Autoren | Oft kostenlos | Hängt vom Remote-Host ab | Schwer |

Für die meisten Windows- und Android-Nutzer liegt die eigentliche Wahl zwischen drei Optionen:

- **Obsidian Sync**, wenn Sie den offiziellen Dienst wollen.
- **Syncthing**, wenn Sie kostenlosen Peer-to-Peer-Sync wollen und die Einrichtung stemmen können.
- **Synch**, wenn Sie privaten verschlüsselten Sync wollen, ohne ein eigenes Sync-System zu betreiben.

![Drei Sync-Wege zwischen Windows- und Android-Geräten](./sync-methods-comparison.webp)

## Vor dem Sync: Sichern Sie Ihr Vault

Bevor Sie eine Sync-Methode einrichten, erstellen Sie auf Windows eine Kopie Ihres Obsidian-Vault.

Ihr Vault ist nur ein Ordner. Kopieren Sie ihn an einen Ort außerhalb des Sync-Ordners, etwa auf ein externes Laufwerk oder in ein separates Backup-Verzeichnis.

Das ist wichtig, weil der riskanteste Moment die erste Synchronisierung ist. Zeigt ein Werkzeug auf den falschen Ordner, behandelt es ein Gerät als leer oder erzeugt es einen Konflikt, können Sie mit einem Backup schnell wiederherstellen.

Entscheiden Sie außerdem, ob Sie den Einstellungsordner `.obsidian` mit synchronisieren wollen. Das hält Plugins, Themes, Tastenkürzel und App-Einstellungen zwischen den Geräten ähnlicher – einige Einstellungen fühlen sich auf Desktop und Mobilgerät aber nicht gleich gut an.

![Sicherung eines Obsidian-Vault vor dem Einrichten der Synchronisierung](./vault-backup-before-sync.webp)

## Option 1: Windows und Android mit Obsidian Sync synchronisieren

[Obsidian Sync](https://obsidian.md/sync) ist der offizielle Weg, Obsidian geräteübergreifend zu synchronisieren.

Unter Windows und Android ist die Einrichtung am einfachsten:

1. Installieren Sie Obsidian unter Windows.
2. Öffnen Sie Ihr Vault oder legen Sie ein neues an.
3. Abonnieren Sie Obsidian Sync.
4. Legen Sie ein Remote-Vault an oder verbinden Sie sich damit.
5. Lassen Sie das Windows-Vault hochladen.
6. Installieren Sie Obsidian unter Android.
7. Melden Sie sich an und verbinden Sie die Android-App mit demselben Remote-Vault.
8. Warten Sie, bis das Vault heruntergeladen ist, bevor Sie unter Android intensiv bearbeiten.

Der größte Vorteil: Obsidian Sync ist in die App integriert. Es unterstützt Ende-zu-Ende-Verschlüsselung, Versionsverlauf und selektiven Sync und versteht Obsidian besser als ein allgemeines Dateisync-Werkzeug.

Der Kompromiss ist der Preis. Wenn Sie den offiziellen Dienst bezahlen möchten, ist das die einfachste Empfehlung.

## Option 2: Windows und Android mit Synch synchronisieren

Synch ist ein Open-Source-Dienst mit Ende-zu-Ende-Verschlüsselung für Obsidian-Nutzer.

Er richtet sich an alle, die privaten gehosteten Sync wollen, ohne auf Google Drive, Dropbox, OneDrive oder eine selbst verwaltete Peer-to-Peer-Einrichtung angewiesen zu sein.

Der grobe Ablauf:

1. Installieren Sie das Synch-Obsidian-Plugin unter Windows.
2. Verbinden Sie Ihr Vault mit Synch.
3. Lassen Sie den ersten Upload abschließen.
4. Installieren Sie Obsidian unter Android.
5. Installieren und aktivieren Sie das Synch-Plugin unter Android.
6. Verbinden Sie sich mit demselben Synch-Vault.
7. Lassen Sie den ersten Download abschließen, bevor Sie von beiden Geräten aus bearbeiten.

Synch konzentriert sich auf drei Punkte, die für eine Windows-und-Android-Einrichtung zählen:

- **Ende-zu-Ende-Verschlüsselung**: Vault-Daten werden lokal verschlüsselt, bevor sie hochgeladen werden.
- **Obsidian-Kompatibilität**: Der Sync-Ablauf ist um Obsidian-Vaults herum gebaut, nicht um beliebige Ordner.
- **Zugängliche Preise**: Es gibt einen Free-Plan für kleine Vaults und einen günstigen Starter-Plan für größeren privaten Gebrauch.

Der aktuelle Free-Plan von Synch umfasst ein synchronisiertes Vault, 50 MB Speicher, 3 MB maximale Dateigröße und 1 Tag Versionsverlauf. Der Starter-Plan umfasst ein synchronisiertes Vault, 1 GB Speicher, 5 MB maximale Dateigröße und 1 Monat Versionsverlauf.

Synch passt gut, wenn Sie etwas Einfacheres als Syncthing und Datenschutzbewussteres als einen allgemeinen Cloud-Speicher wollen.

## Option 3: Windows und Android mit Syncthing synchronisieren

[Syncthing](https://syncthing.net/) ist eine beliebte kostenlose Option für Windows und Android.

Es synchronisiert Ordner direkt zwischen Geräten. Ihre Notizen müssen nicht in einem zentralen Cloud-Speicher liegen – das macht Syncthing attraktiv für alle, die eine private Peer-to-Peer-Einrichtung wollen.

Eine typische Einrichtung sieht so aus:

1. Installieren Sie Syncthing unter Windows.
2. Installieren Sie eine Syncthing-kompatible Android-App.
3. Fügen Sie Ihr Android-Gerät in Syncthing unter Windows hinzu.
4. Fügen Sie Ihr Windows-Gerät in Syncthing unter Android hinzu.
5. Geben Sie Ihren Obsidian-Vault-Ordner von Windows aus frei.
6. Nehmen Sie den freigegebenen Ordner unter Android an.
7. Öffnen Sie unter Android den synchronisierten Ordner als Obsidian-Vault.
8. Warten Sie, bis die Synchronisierung abgeschlossen ist, bevor Sie Notizen auf beiden Geräten bearbeiten.

Syncthing kann sehr gut funktionieren, aber Sie müssen die Kompromisse kennen.

Beide Geräte brauchen genug Online-Zeit, um Änderungen auszutauschen. Das Hintergrundverhalten von Android kann den Sync-Zeitpunkt je nach Akku-Einstellungen außerdem beeinflussen. Wenn Sie dieselbe Notiz unter Windows und Android bearbeiten, bevor beide Geräte synchronisiert haben, können trotzdem Konflikte entstehen.

Syncthing eignet sich am besten, wenn Sie kostenlosen Sync wollen und nichts dagegen haben, Geräte selbst einzurichten.

## Option 4: Google Drive, Dropbox oder OneDrive nutzen

Cloud-Speicher können Obsidian unter Windows leicht synchronisieren – unter Android wird die Einrichtung aber unsauberer.

Unter Windows können Sie Ihr Vault in einen synchronisierten Cloud-Ordner legen. Unter Android braucht Obsidian jedoch zuverlässigen Zugriff auf einen lokalen Ordner. Viele Cloud-Speicher-Apps verhalten sich nicht wie ein normaler, jederzeit verfügbarer lokaler Ordner, sodass Sie zusätzliche Werkzeuge oder manuelle Download-Abläufe brauchen können.

Dieser Ansatz kann akzeptabel sein, wenn Sie überwiegend unter Windows bearbeiten und Android nur gelegentlich zum Lesen nutzen. Für nahtloses bidirektionales Bearbeiten ist er weniger ideal.

Das andere Thema ist Datenschutz. Ohne eine eigene Verschlüsselungsschicht sind Ihre Notizen nach dem Speichermodell des Cloud-Anbieters geschützt, nicht nach einem Obsidian-spezifischen Ende-zu-Ende-verschlüsselten Sync-Modell.

Nutzen Sie einen Cloud-Speicher nur, wenn Ihr Vault einfach ist und Sie die Einschränkungen beim Dateizugriff unter Android bereits verstehen.

## Option 5: Git nutzen

Git kann Obsidian-Notizen synchronisieren, weil Markdown-Dateien gut zur Versionskontrolle passen.

Unter Windows ist Git unkompliziert, wenn Sie Entwicklerwerkzeuge bereits nutzen. Unter Android brauchen Sie in der Regel eine Git-fähige App oder einen manuelleren Ablauf. Das macht Git leistungsfähig, aber unbequem fürs alltägliche Notieren.

Git eignet sich für:

- expliziten Versionsverlauf
- das Prüfen von Änderungen
- das Wiederherstellen älterer Notizversionen
- Entwickler-Workflows

Git ist nicht ideal für:

- automatische Hintergrundsynchronisierung
- schnelles Festhalten auf dem Handy
- nicht-technische Nutzer
- das Vermeiden von Merge-Konflikten

Nutzen Sie Git, wenn Sie Git bereits kennen und Versionskontrolle höher gewichten als nahtlosen Sync.

## Empfohlene Einrichtung für die meisten Windows- und Android-Nutzer

Wenn Sie möglichst wenig Reibung und offiziellen Support wollen, wählen Sie Obsidian Sync.

Wenn Sie eine kostenlose Einrichtung wollen und Gerätepaarung, Ordnerfreigabe und Android-Akku-Einstellungen verwalten können, wählen Sie Syncthing.

Wenn Sie privaten gehosteten Sync mit Ende-zu-Ende-Verschlüsselung und einem einfacheren Ablauf als bei Syncthing wollen, wählen Sie Synch.

Vermeiden Sie, mehrere Sync-Werkzeuge gleichzeitig auf demselben Vault zu verwenden. Legen Sie dasselbe Vault zum Beispiel nicht in OneDrive und synchronisieren Sie es gleichzeitig über Syncthing oder einen anderen Obsidian-Sync-Dienst. Das ist einer der einfachsten Wege, Konflikte zu erzeugen.

## Häufige Sync-Probleme unter Windows und Android

Das häufigste Problem ist Bearbeiten, bevor die erste Synchronisierung fertig ist. Wenn Sie ein neues Android-Gerät verbinden, warten Sie, bis das gesamte Vault heruntergeladen ist, bevor Sie Änderungen vornehmen.

Ein weiteres häufiges Thema ist die Akkuoptimierung unter Android. Darf Ihr Sync-Werkzeug nicht im Hintergrund laufen, werden Änderungen möglicherweise nicht zum erwarteten Zeitpunkt hoch- oder heruntergeladen.

Große Anhänge können die Synchronisierung außerdem verlangsamen. Wenn Ihr Vault viele PDFs, Bilder, Audiodateien oder Videos enthält, prüfen Sie Dateigrößenlimits und das Verhalten von selektivem Sync, bevor Sie annehmen, dass alles wie bei kleinen Markdown-Notizen funktioniert.

Plugin-Einstellungen können knifflig sein. Eine Desktop-Plugin-Einrichtung überträgt sich nicht immer perfekt auf Android. Verhält sich Ihre mobile Obsidian-App nach dem Synchronisieren der Einstellungen merkwürdig, prüfen Sie, welche Teile von `.obsidian` Sie synchronisieren.

## FAQ

### Was ist der beste Weg, Obsidian zwischen Windows und Android zu synchronisieren?

Die einfachste offizielle Option ist Obsidian Sync. Die beste kostenlose technische Option ist in der Regel Syncthing. Wenn Sie privaten gehosteten Sync mit Ende-zu-Ende-Verschlüsselung wollen, ist Synch für diesen Einsatzzweck gebaut.

### Kann ich Obsidian zwischen Windows und Android kostenlos synchronisieren?

Ja. Syncthing ist eine starke kostenlose Option für Windows und Android. Synch hat außerdem einen Free-Plan für kleine Vaults. Cloud-Speicher können innerhalb der Speicherlimits kostenlos sein, der Ordnerzugriff unter Android macht sie aber oft weniger bequem.

### Kann ich Google Drive nutzen, um Obsidian unter Android zu synchronisieren?

In manchen Abläufen ist das möglich, aber es ist nicht die sauberste Option. Google Drive eignet sich auf dem Desktop besser als in der Rolle eines nahtlosen lokalen Vault-Ordners für Obsidian unter Android.

### Ist Syncthing für Obsidian sicher?

Syncthing kann für Obsidian sicher sein, wenn Sie es sorgfältig einrichten, vor dem Bearbeiten auf einem anderen Gerät auf den Abschluss der Synchronisierung warten und Backups behalten. Es bleibt ein Dateisync-Werkzeug, deshalb sind Konfliktbehandlung und Geräteverfügbarkeit Ihre Verantwortung.

### Sollte ich den Ordner `.obsidian` synchronisieren?

Synchronisieren Sie ihn, wenn Plugins, Themes, Tastenkürzel und Einstellungen unter Windows und Android ähnlich bleiben sollen. Synchronisieren Sie nicht alles blind, wenn Sie unterschiedliche Desktop- und Mobil-Setups wollen.

### Ist Synch eine Obsidian-Sync-Alternative für Windows und Android?

Ja. Synch ist als private, Ende-zu-Ende-verschlüsselte Obsidian-Sync-Alternative gebaut. Es ist besonders relevant, wenn Sie gehosteten Sync wollen, ohne einen allgemeinen Cloud-Speicher zu nutzen oder Syncthing selbst zu verwalten.

## Abschließende Empfehlung

Unter Windows und Android haben Sie mehr gute Sync-Optionen als iPhone-Nutzer.

Nutzen Sie Obsidian Sync, wenn Sie den offiziellen integrierten Dienst wollen. Nutzen Sie Syncthing, wenn Sie kostenlosen Peer-to-Peer-Sync wollen und mit Einrichtungsdetails zurechtkommen. Nutzen Sie Git, wenn Sie entwickeln und explizite Versionskontrolle wollen.

Nutzen Sie Synch, wenn Sie eine private, Ende-zu-Ende-verschlüsselte Obsidian-Sync-Alternative wollen, die unter Windows und Android funktioniert, ohne Ihren Notiz-Workflow in Infrastrukturwartung zu verwandeln.
