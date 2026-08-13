---
title: "So synchronisieren Sie Obsidian zwischen iPhone und Android"
description: "Erfahren Sie, wie Sie Obsidian zwischen iPhone und Android mit Obsidian Sync, Synch, iCloud, Google Drive, Syncthing, Git und weiteren Optionen synchronisieren."
pubDate: 2026-05-28
---

Wenn Sie Obsidian zwischen **iPhone und Android** synchronisieren wollen, lautet die praktische Antwort: Nutzen Sie Obsidian Sync, wenn Sie die offizielle Option wollen, nutzen Sie Synch, wenn Sie eine private Ende-zu-Ende-verschlüsselte Alternative wollen, und seien Sie vorsichtig mit iCloud, Google Drive, Syncthing oder Git, weil der mobile Dateizugriff auf beiden Plattformen nicht derselbe ist.

Obsidian speichert Ihre Notizen als lokale Markdown-Dateien. Das ist eine der größten Stärken. Ihr Vault ist nicht in einer Datenbank eingeschlossen, und Sie können es kopieren, sichern oder mit normalen Werkzeugen prüfen.

Aber dieses Local-First-Design bedeutet auch, dass die Synchronisierung einen echten Ordner mit Notizen, Anhängen, Plugin-Einstellungen, Themes, Snippets und dem Konfigurationsordner `.obsidian` bewältigen muss. Auf iPhone und Android verhält sich dieser Ordner nicht gleich.

## Warum die Synchronisierung zwischen iPhone und Android schwieriger ist, als sie wirkt

Am Desktop ist das Synchronisieren von Obsidian oft unkompliziert. Sie können ein Vault in einen synchronisierten Ordner legen, es in Obsidian öffnen und das Synchronisierungswerkzeug Dateien im Hintergrund bewegen lassen.

Mobil ist es anders.

iPhone und iPad nutzen Apples Dateisystem und App-Sandboxing. iCloud Drive funktioniert natürlich im Apple-Ökosystem, ist aber kein normaler geteilter Ordner, den Android als Obsidian Vault nutzen kann.

Android gibt Nutzern direkteren Zugriff auf lokale Ordner, sodass Werkzeuge wie Syncthing praktikabel sein können. Aber Android hat auch Akkuoptimierung, Grenzen für Hintergrundausführung und Speicherberechtigungen, die Synchronisierung verzögern oder blockieren können.

Deshalb kann eine Methode, die auf dem iPhone gut funktioniert, auf Android umständlich sein – und eine Methode, die auf Android gut funktioniert, auf dem iPhone unrealistisch.

## Kurze Empfehlung

| Methode | Am besten für | Privatsphäre | Einfachheit |
| --- | --- | --- | --- |
| Obsidian Sync | Nutzer, die den offiziellen integrierten Dienst wollen | Ende-zu-Ende-verschlüsselt | einfach |
| Synch | Nutzer, die eine private gehostete Alternative wollen | Ende-zu-Ende-verschlüsselt | einfach |
| iCloud | Setups nur mit Apple-Geräten | hängt von Apple-Account und Einstellungen ab | einfach auf Apple-Geräten |
| Google Drive, Dropbox, OneDrive | desktoplastige Workflows | hängt vom Anbieter ab | gemischt auf Mobilgeräten |
| Syncthing | technische, androidlastige Setups | privat, Peer-to-Peer | mittel bis schwer |
| Git | Entwickler, die Versionskontrolle wollen | hängt von Remote und Setup ab | schwer |

Für die meisten Menschen, die sowohl iPhone als auch Android nutzen, ist die sauberste Wahl ein Obsidian-orientierter Synchronisierungsdienst. Allgemeine Cloud-Laufwerke und Ordner-Synchronisierungswerkzeuge können funktionieren, brauchen aber meist mehr Aufmerksamkeit.

## Bevor Sie synchronisieren: Sichern Sie Ihr Vault

Bevor Sie ein Synchronisierungswerkzeug anbinden, fertigen Sie eine Kopie Ihres Vaults an.

Ihr Vault ist nur ein Ordner. Kopieren Sie es irgendwohin außerhalb des Synchronisierungs-Setups, etwa in einen anderen lokalen Ordner, auf ein externes Laufwerk oder an einen separaten Backup-Ort.

Die erste Synchronisierung ist der riskanteste Moment. Wenn ein Gerät eine alte Kopie hochlädt, ein anderes Gerät mit einem leeren Ordner startet oder der falsche Ordner verbunden wird, gibt Ihnen ein Backup einen Weg zurück.

Entscheiden Sie außerdem, was mit dem Ordner `.obsidian` geschehen soll. Er enthält Plugins, Themes, Tastenkürzel, Snippets, den Arbeitsbereichszustand und App-Einstellungen. Ihn zu synchronisieren kann Geräte konsistenter wirken lassen, aber einige Desktop-Plugins oder Layouts ergeben auf Mobilgeräten keinen Sinn.

Wenn Sie unsicher sind, beginnen Sie zuerst mit Notizen und Anhängen. Synchronisieren Sie Einstellungen erst, wenn die grundlegende Vault-Synchronisierung stabil ist.

## Option 1: Obsidian Sync

[Obsidian Sync](https://obsidian.md/sync) ist der offizielle Synchronisierungsdienst für Obsidian.

Für ein Setup aus iPhone und Android ist das die einfachste Empfehlung, wenn Sie das am stärksten integrierte Erlebnis wollen. Es arbeitet in Obsidian, unterstützt Ende-zu-Ende-Verschlüsselung und umfasst Funktionen wie Versionsverlauf und selektive Synchronisierung.

Der Hauptvorteil: Sie müssen iCloud, Google Drive, Android-Speicher oder ein Drittanbieter-Dateisynchronisierungswerkzeug nicht dazu bringen, sich wie eine Obsidian-bewusste Synchronisierungsschicht zu verhalten. Obsidian Sync ist für genau diese Aufgabe gebaut.

Der Kompromiss ist der Preis. Wenn das offizielle Abo in Ihr Budget passt, ist es in der Regel die Option mit der geringsten Reibung.

## Option 2: Synch

Synch ist ein Open-Source-Synchronisierungsdienst mit Ende-zu-Ende-Verschlüsselung für Obsidian.

Es ist für Nutzer gedacht, die private gehostete Synchronisierung wollen, ohne von einem allgemeinen Cloud-Laufwerk abzuhängen und ohne ein eigenes Peer-to-Peer-Setup zu betreiben.

Das zählt für iPhone und Android, weil der schwierige Teil nicht nur das Verschieben von Dateien ist. Der schwierige Teil ist, Synchronisierung über zwei mobile Plattformen mit unterschiedlichen Dateisystemen und Hintergrundverhalten zuverlässig wirken zu lassen.

Bei Synch werden Vault-Daten auf Ihrem Gerät verschlüsselt, bevor sie hochgeladen werden. Der Server speichert verschlüsselte Daten, keine lesbaren Notizen. Der Synchronisierungsablauf ist um Obsidian-Vaults herum gebaut, nicht um generische Ordner.

Synch passt gut, wenn:

- Sie sowohl iPhone als auch Android nutzen
- Sie Ende-zu-Ende-verschlüsselte gehostete Synchronisierung wollen
- Sie etwas Einfacheres als Syncthing oder Git wollen
- Sie nicht von iCloud, Google Drive, Dropbox oder OneDrive abhängen wollen
- Sie eine Open-Source-Alternative zu Obsidian Sync wollen

Wenn Sie zwischen Obsidian Sync und Synch wählen: Wählen Sie Obsidian Sync für den offiziellen eingebauten Dienst. Wählen Sie Synch, wenn Sie eine Open-Source-, private, Ende-zu-Ende-verschlüsselte Alternative mit gehostetem Ablauf wollen.

## Option 3: iCloud

iCloud passt gut, wenn alle Ihre Geräte Apple-Geräte sind.

Wenn Ihr Setup aus Mac, iPhone und iPad besteht, kann iCloud Drive für ein einfaches Obsidian Vault ausreichen. Viele Nutzer beginnen dort, weil es bereits verfügbar ist und wenig Einrichtung braucht.

Aber iCloud ist keine gute Antwort für die Synchronisierung von Obsidian zwischen iPhone und Android.

Das Problem ist nicht nur, ob Android irgendwie auf iCloud-Dateien zugreifen kann. Das Problem ist, ob Android einen von iCloud gestützten Ordner als zuverlässiges lokales Obsidian Vault mit Offline-Zugriff, Hintergrundsynchronisierung und vorhersehbarem Konfliktverhalten nutzen kann.

Für die meisten Nutzer ist das kein Setup, auf das man sich verlassen sollte.

Nutzen Sie iCloud für Obsidian-Workflows nur mit Apple-Geräten. Wenn Android Teil Ihres Alltags ist, wählen Sie eine andere Methode.

## Option 4: Google Drive, Dropbox oder OneDrive

Cloud-Laufwerke sind vertraut, aber die mobile Obsidian-Synchronisierung verlangt mehr von ihnen als gewöhnliche Dokumentenspeicherung.

Obsidian erwartet einen lokalen Vault-Ordner, den es zuverlässig lesen und schreiben kann. Auf Mobilgeräten stellen Cloud-Laufwerk-Apps Dateien oft über die eigene App, einen Dateiauswähler oder einen Offline-Cache bereit. Das ist nicht immer dasselbe, als Obsidian einen normalen, jederzeit verfügbaren Ordner zu geben.

Android ist hier meist flexibler als das iPhone, aber das Ergebnis hängt vom Anbieter, den Offline-Einstellungen, Speicherberechtigungen und Hilfs-Apps von Drittanbietern ab.

Die häufigen Risiken sind:

- Dateien sind möglicherweise nicht verfügbar, wenn Obsidian sie erwartet
- Uploads oder Downloads geschehen verspätet
- zwei Geräte bearbeiten, bevor die Synchronisierung fertig ist
- Anhänge kommen später an als die Notizen, die auf sie verweisen
- `.obsidian`-Einstellungen können sich auf Geräten unterschiedlich verhalten

Cloud-Laufwerke können akzeptabel sein, wenn Sie vor allem auf einem Gerät bearbeiten und das andere zum Lesen nutzen. Für tägliches bidirektionales Bearbeiten zwischen iPhone und Android sind sie weniger ideal.

## Option 5: Syncthing

[Syncthing](https://syncthing.net/) ist ein beliebtes kostenloses Peer-to-Peer-Synchronisierungswerkzeug.

Auf Android kann Syncthing eine starke Option sein. Android gibt genug Ordnerzugriff, damit viele Nutzer ein Obsidian Vault direkt zwischen Geräten synchronisieren können.

Auf dem iPhone ist die Geschichte anders. Einschränkungen von iOS machen einen normalen Syncthing-artigen Ordner-Synchronisierungsablauf deutlich schwieriger. Es gibt Drittanbieter-Ansätze, aber sie sind nicht so einfach oder vorhersehbar wie das Android-Erlebnis.

Syncthing lohnt sich, wenn Ihr Setup vor allem aus Desktop und Android besteht und Sie sich zutrauen, Geräte, Ordner, Netzverfügbarkeit und Konflikte zu verwalten.

Für iPhone und Android zusammen ist es in der Regel nicht der einfachste Weg.

## Option 6: Git

Git kann Obsidian-Notizen synchronisieren, weil Markdown-Dateien gut mit Versionskontrolle funktionieren.

Für Entwickler kann Git attraktiv sein. Sie bekommen Commits, Historie, Diffs und explizite Kontrolle über Änderungen.

Aber Git ist für die meisten Menschen keine nahtlose mobile Synchronisierungslösung. Sie müssen Commits, Pulls, Pushes, Authentifizierung, Merge-Konflikte und manchmal ein Git-Plugin oder eine mobile Git-App handhaben. Große Anhänge können das Repository außerdem unangenehm zu verwalten machen.

Nutzen Sie Git, wenn Sie Versionskontrolle wollen und den Ablauf bereits verstehen. Wenn Ihr Ziel ist, Obsidian auf iPhone und Android zu öffnen und weiterzuschreiben, ist Git in der Regel zu viel Arbeit.

## Häufige Probleme

Das häufigste Problem ist Bearbeiten, bevor die erste Synchronisierung fertig ist. Wenn Ihr Android-Telefon die neueste Notiz noch nicht heruntergeladen hat und Ihr iPhone dieselbe Notiz bearbeitet, können Duplikate oder Konflikte entstehen.

Anhänge können auch hinter Notizen zurückbleiben. Eine Markdown-Datei kommt möglicherweise schnell an, während ein Bild, PDF, eine Audiodatei oder ein Video länger braucht. Bis der Anhang ankommt, kann die Notiz kaputt wirken.

Plugin-Einstellungen sind eine weitere Reibungsquelle. Ein Desktop-Plugin funktioniert möglicherweise nicht auf Mobilgeräten. Ein Arbeitsbereichslayout, das auf dem iPad stimmig wirkt, kann auf einem Android-Telefon umständlich sein. Den gesamten Ordner `.obsidian` zu synchronisieren ist bequem, aber nicht immer die sicherste Voreinstellung.

Betreiben Sie nicht mehrere Synchronisierungswerkzeuge auf demselben aktiven Vault. Legen Sie zum Beispiel kein Vault in iCloud Drive, während Sie es gleichzeitig über einen anderen Obsidian-Synchronisierungsdienst synchronisieren. Synchronisierungsschichten zu mischen ist einer der einfachsten Wege, verwirrende Konflikte zu erzeugen.

## FAQ

### Kann ich Obsidian zwischen iPhone und Android kostenlos synchronisieren?

Ja, aber kostenlose Optionen bringen in der Regel Kompromisse mit sich. Syncthing ist stark auf Android, aber schwierig auf dem iPhone. Git kann für technische Nutzer funktionieren, ist aber nicht nahtlos. Cloud-Laufwerke brauchen möglicherweise Extra-Werkzeuge oder manuelle Gewohnheiten. Wenn Sie das einfachste Erlebnis wollen, nutzen Sie einen Synchronisierungsdienst, der für Obsidian gebaut ist.

### Kann ich iCloud nutzen, um Obsidian mit Android zu synchronisieren?

Für die meisten Nutzer nein. iCloud ist vernünftig für Obsidian-Workflows nur mit Apple-Geräten, aber keine saubere plattformübergreifende Synchronisierungsschicht für Android.

### Kann ich Google Drive nutzen, um Obsidian zwischen iPhone und Android zu synchronisieren?

Es kann mit Extra-Werkzeugen oder manuellen Abläufen möglich sein, ist aber nicht das zuverlässigste Setup. Obsidian braucht verlässlichen lokalen Dateizugriff, und mobile Cloud-Laufwerk-Apps bieten das nicht immer so, wie Obsidian es erwartet.

### Funktioniert Syncthing mit dem iPhone?

Syncthing ist auf Android deutlich praktikabler als auf dem iPhone. Einschränkungen des iOS-Dateisystems machen ein normales Syncthing-artiges Setup schwierig.

### Sollte ich den Ordner `.obsidian` synchronisieren?

Synchronisieren Sie ihn, wenn Einstellungen, Themes, Tastenkürzel und Plugins auf den Geräten ähnlich bleiben sollen. Synchronisieren Sie ihn nicht blind, wenn Sie unterschiedliche mobile und Desktop-Setups wollen oder wenn einige Plugins sich auf Mobilgeräten schlecht verhalten.

### Ist Synch eine Alternative zu Obsidian Sync?

Ja. Synch ist als Open-Source-, Ende-zu-Ende-verschlüsselte Alternative zu Obsidian Sync gebaut. Es ist besonders relevant, wenn Sie private gehostete Synchronisierung wollen, ohne ein allgemeines Cloud-Laufwerk zu nutzen oder ein eigenes Peer-to-Peer-Setup zu verwalten.

## Abschließende Empfehlung

Obsidian zwischen iPhone und Android zu synchronisieren ist möglich, aber die beste Methode hängt davon ab, wie viel Einrichtung Sie verwalten wollen.

Nutzen Sie Obsidian Sync, wenn Sie die offizielle integrierte Option wollen.

Nutzen Sie Synch, wenn Sie eine Open-Source-, Ende-zu-Ende-verschlüsselte Alternative zu Obsidian Sync mit gehostetem Ablauf wollen.

Nutzen Sie iCloud nur für Setups ausschließlich mit Apple-Geräten. Nutzen Sie Syncthing, wenn Sie technisch versiert sind und sich vor allem auf Android oder Desktop stützen. Nutzen Sie Git, wenn Sie Versionskontrolle wollen und Konflikte selbst lösen können.

Für die meisten iPhone- und Android-Nutzer lautet die langfristige Antwort: Wählen Sie ein Synchronisierungswerkzeug, das für Obsidian gebaut ist, statt ein allgemeines Cloud-Laufwerk oder Dateisynchronisierungswerkzeug in einen mobilen Ablauf zu zwingen.
