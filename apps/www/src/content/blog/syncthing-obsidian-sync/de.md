---
title: "Syncthing für Obsidian: Eine gute Alternative zu Obsidian Sync?"
description: "Ein praktischer Leitfaden zu Syncthing mit Obsidian: wo es gut funktioniert, wo Risiken entstehen und wann Synch die einfachere verschlüsselte Alternative ist."
pubDate: 2026-05-11
---

Syncthing ist eine der häufigen Antworten, wenn Obsidian-Nutzer nach kostenloser, privater Synchronisierung fragen.

Das ist nachvollziehbar. [Syncthing](https://syncthing.net/) ist Open Source, Peer-to-Peer und dafür gebaut, Dateien direkt zwischen Geräten zu synchronisieren. Sie müssen Ihre Notizen nicht in Dropbox, Google Drive, iCloud oder OneDrive legen. Sie brauchen auch keinen zentralen Speicherserver, der eine Kopie Ihres Vaults behält.

Für viele technisch versierte Nutzer ist genau das der Reiz.

Aber es gibt einen Unterschied zwischen dem Synchronisieren von Dateien und dem sicheren Synchronisieren eines Obsidian-Vaults.

Obsidian ist lokal zuerst, aber ein Vault ist mehr als ein Ordner voller Markdown-Dateien. Es kann Anhänge, Plugin-Datenbanken, Themes, Snippets, Canvas-Dateien, Workspace-Zustand und den Konfigurationsordner `.obsidian` enthalten. Diese Dateien können sich schnell ändern, und sie können sich von mehreren Geräten aus ändern.

Die eigentliche Frage ist also nicht einfach:

> Kann Syncthing Obsidian synchronisieren?

Sie lautet:

> Ist Syncthing das richtige Synchronisierungsmodell für die Art, wie Sie Obsidian nutzen?

![Syncthing-Startseite zur privaten, fortlaufenden Dateisynchronisierung](./syncthing-homepage.webp)

## Was Syncthing gut kann

Syncthing ist ein Werkzeug zur fortlaufenden Dateisynchronisierung. Es erkennt Dateiänderungen über Dateisystemüberwachung und regelmäßige Scans und synchronisiert Änderungen zwischen zwei oder mehr Computern.

Die Kernstärken sind klar:

- Es ist Open Source.
- Es speichert Ihre Daten nicht auf einem zentralen Syncthing-Server.
- Es ist für Ihre Dateien nicht auf gehosteten Cloud-Speicher angewiesen.
- Die Kommunikation von Gerät zu Gerät ist mit TLS verschlüsselt, auch wenn für die Verbindung ein Relay nötig ist.
- Geräte werden authentifiziert, bevor sie sich verbinden können.
- Es kann viele verschiedene Ordner synchronisieren, nicht nur Obsidian-Vaults.

Für Obsidian-Nutzer, die ein kostenloses Peer-to-Peer-Setup zwischen einem Desktop und einem anderen ständig online erreichbaren Gerät wollen, kann Syncthing eine starke Option sein.

Es ist besonders attraktiv, wenn Sie Dateisynchronisierung, Gerätepaarung, Ordnerfreigabe und Konfliktwiederherstellung bereits verstehen.

## Warum Obsidian-Vaults besondere Sorgfalt brauchen

Ein Obsidian-Vault wirkt einfach, weil Notizen normale Dateien sind. Das ist eine der besten Designentscheidungen von Obsidian.

Das Synchronisierungsproblem: Die Aktivität im Vault ist nicht immer einfach.

Ein normales Vault kann enthalten:

- Markdown-Notizen
- Bilder, PDFs, Audio und andere Anhänge
- Canvas-Dateien
- Plugin-Einstellungen
- Theme- und Snippet-Dateien
- Workspace-Zustand
- mobilgerätespezifische Einstellungen
- versteckte Dateien in `.obsidian`

Manche dieser Dateien bearbeiten Sie. Manche bearbeitet Obsidian. Manche bearbeiten Plugins. Manche werden möglicherweise neu geschrieben, obwohl Sie denken, Sie hätten nichts geändert.

Das ist wichtig, weil generische Dateisynchronisierung die Absicht von Obsidian nicht versteht. Sie sieht Dateiänderungen. Sie weiß nicht, dass sich eine Plugin-Einstellung geändert hat, dass eine mobile Workspace-Datei kein Desktop-Layout überschreiben sollte oder dass ein Notizkonflikt einen für Menschen lesbaren Wiederherstellungsweg braucht.

## Ein gutes Syncthing-Setup

Syncthing funktioniert für Obsidian am besten, wenn Ihr Setup diszipliniert ist.

Ein gutes Setup sieht in der Regel so aus:

1. Ein primäres Desktop-Vault.
2. Ein oder mehrere sekundäre Geräte.
3. Eine separate Sicherung vor der ersten Synchronisierung.
4. Eine klare Entscheidung, ob `.obsidian` synchronisiert wird.
5. Genug Zeit, damit jedes Gerät die Synchronisierung abschließt, bevor Sie woanders bearbeiten.
6. Eine Gewohnheit zur Konfliktwiederherstellung.

Wenn Sie vor allem auf einem Rechner bearbeiten und ein anderes Gerät zum Lesen oder leichten Erfassen nutzen, kann Syncthing zuverlässig sein.

Wenn Sie dieselben Notizen häufig von mehreren Geräten aus bearbeiten, während manche davon offline sind, steigt das Risiko.

## Die schwierigen Teile von Syncthing mit Obsidian

Syncthing ist leistungsfähig, aber die Verantwortung liegt bei Ihnen.

Der erste schwierige Teil ist die Geräteverfügbarkeit. Peer-to-Peer-Synchronisierung braucht Geräte, die lange genug online sind, um Änderungen auszutauschen, direkt oder über ein Relay. Wenn Ihr Laptop schläft und Ihr Telefon eine Notiz bearbeitet, kann nichts synchronisieren, bis ein anderes Gerät mit den benötigten Änderungen wieder kommunizieren kann.

Der zweite schwierige Teil ist das mobile Verhalten. Einschränkungen im Android-Hintergrund, Akkuoptimierung und App-Verfügbarkeit können beeinflussen, wie schnell Änderungen ankommen. Die [offizielle Syncthing-Android-App](https://forum.syncthing.net/t/discontinuing-syncthing-android/23002) wurde nach der letzten Veröffentlichung mit der Syncthing-Version vom Dezember 2024 eingestellt. Android-Nutzer müssen deshalb ihren aktuellen App-Weg verstehen, etwa Syncthing-Fork oder einen anderen Ansatz.

Der dritte schwierige Teil ist das Konflikthandling. Wenn zwei Geräte dieselbe Datei bearbeiten, bevor die Synchronisierung abgeschlossen ist, muss ein Dateisynchronisierungswerkzeug beide Versionen irgendwie bewahren. Das ist besser als stiller Datenverlust, hinterlässt aber Aufräumarbeit.

Der vierte schwierige Teil ist die Vault-Konfiguration. `.obsidian` zu synchronisieren hält Plugins und Einstellungen angeglichen, kann aber auch Desktop-Annahmen auf das Mobilgerät kopieren. `.obsidian` nicht zu synchronisieren vermeidet das, dann können sich Ihre Geräte aber unterschiedlich verhalten.

Keines dieser Probleme bedeutet, dass Syncthing schlecht ist. Sie bedeuten, dass Syncthing ein Dateisynchronisierungswerkzeug ist und Obsidian-Vaults anwendungsspezifisches Verhalten haben.

![Obsidian-Notizen auf dem Weg über generische Dateisynchronisierung und über einen verschlüsselten, Obsidian-bewussten Synchronisierungspfad](./obsidian-sync-paths.webp)

## Syncthing im Vergleich zu Synch

Synch geht einen anderen Weg.

Syncthing ist ein allgemeines Peer-to-Peer-Werkzeug zur Dateisynchronisierung. Synch ist ein Open-Source-Dienst mit Ende-zu-Ende-Verschlüsselung, der eigens für Obsidian gebaut ist.

Dieser Unterschied verändert den Kompromiss.

| Frage | Syncthing | Synch |
| --- | --- | --- |
| Was wird synchronisiert? | Ordner und Dateien | Daten des Obsidian-Vaults |
| Ist es Open Source? | Ja | Ja |
| Ist es Ende-zu-Ende-verschlüsselt? | Die Gerätekommunikation ist verschlüsselt; optionale Verschlüsselung für nicht vertrauenswürdige Geräte gibt es für fortgeschrittene Setups | Vault-Daten werden lokal verschlüsselt, bevor sie hochgeladen werden |
| Braucht es zentralen Speicher? | Nein | Gehosteter Dienst oder selbst gehosteter Synch-Server |
| Ist es Obsidian-bewusst? | Nein | Ja |
| Braucht es Gerätepaarung und Ordner-Setup? | Ja | Keine Peer-to-Peer-Gerätepaarung |
| Am besten geeignet | Technisch versierte Nutzer, die Dateisynchronisierung von Gerät zu Gerät wollen | Nutzer, die private Obsidian-Synchronisierung wollen, ohne Dateisynchronisierungs-Infrastruktur zu verwalten |

Syncthing ist attraktiv, wenn Sie gar keinen gehosteten Speicher wollen.

Synch ist attraktiv, wenn Sie einen ruhigeren Obsidian-Synchronisierungsablauf wollen und dabei Ende-zu-Ende-Verschlüsselung und Open-Source-Code behalten.

## Wann Syncthing eine gute Wahl ist

Nutzen Sie Syncthing für Obsidian, wenn Sie Peer-to-Peer-Dateisynchronisierung wollen und bereit sind, die Einrichtung selbst zu tragen.

Es passt gut, wenn:

- Sie verstehen, wie Syncthing Ordner zwischen Geräten teilt.
- Sie bereit sind, den Synchronisierungsstatus zu prüfen, bevor Sie bearbeiten.
- Sie unabhängige Sicherungen behalten.
- Sie Konfliktdateien behandeln können, falls sie erscheinen.
- Ihre Geräte zu vorhersehbaren Zeiten online sind.
- Sie gehosteten Speicher lieber ganz vermeiden.

Für technisch versierte Nutzer mit Desktop, Laptop, Heimserver oder NAS kann Syncthing ein klares und privates Setup sein.

## Wann Synch besser passt

Nutzen Sie Synch, wenn Sie eine Alternative zu Obsidian Sync wollen, ohne aus der Synchronisierung ein Geräteverwaltungsprojekt zu machen.

Synch ist für Nutzer entworfen, denen Datenschutz wichtig ist, die aber trotzdem einen gehosteten Synchronisierungsablauf wollen. Ihre Vault-Daten werden lokal verschlüsselt, bevor sie hochgeladen werden. Der Server speichert also verschlüsselte Daten, keine lesbaren Notizen.

Synch passt besser, wenn:

- Sie Synchronisierungsverhalten wollen, das um Obsidian herum entworfen ist.
- Sie keine Peer-to-Peer-Konnektivität verwalten möchten.
- Sie eine gehostete Option mit Ende-zu-Ende-Verschlüsselung wollen.
- Sie eine einfachere Einrichtung auf Mobilgeräten wollen.
- Sie Versionsverlauf und Wiederherstellung gelöschter Dateien innerhalb der Planlimits wollen.
- Sie eine kostenlose oder günstige Alternative zu Obsidian Sync wollen.

Der aktuelle Synch-Free-Plan umfasst ein synchronisiertes Vault, 50 MB Speicher, eine maximale Dateigröße von 3 MB und 1 Tag Versionsverlauf. Der Starter-Plan umfasst ein synchronisiertes Vault, 1 GB Speicher, eine maximale Dateigröße von 5 MB und 1 Monat Versionsverlauf.

Damit ist Synch eine praktische Option für kleine persönliche Vaults, Studierende, Hobby-Notizen und Nutzer, die private verschlüsselte Synchronisierung wollen, ohne ein größeres Abo zu bezahlen.

## Sicherheitstipps, wenn Sie Syncthing trotzdem nutzen

Wenn Sie sich für Syncthing entscheiden, richten Sie es sorgfältig ein.

Beginnen Sie mit einer vollständigen Sicherung Ihres Vaults vor der ersten Synchronisierung. Behandeln Sie Synchronisierung nicht als Backup. Synchronisierung kann Fehler sehr effizient kopieren.

Warten Sie, bis die erste Synchronisierung abgeschlossen ist, bevor Sie das Vault auf einem anderen Gerät öffnen. Genau in diesem Moment entstehen viele vermeidbare Probleme.

Entscheiden Sie vor dem Synchronisieren, was mit `.obsidian` geschehen soll. Wenn Sie überall dieselben Plugins und Einstellungen wollen, synchronisieren Sie es bewusst. Wenn Sie getrennte Desktop- und Mobile-Layouts wollen, erwägen Sie, einige Einstellungen auszuschließen.

Vermeiden Sie zwei Synchronisierungssysteme auf demselben Vault. Legen Sie denselben Obsidian-Ordner nicht in iCloud oder Dropbox, während Sie gleichzeitig Syncthing oder einen anderen Synchronisierungsdienst nutzen. Geschichtete Synchronisierungswerkzeuge sind eine häufige Quelle doppelter Dateien und verwirrender Konflikte.

Prüfen Sie Konfliktdateien, statt sie sofort zu löschen. Sie können die einzige Kopie von Bearbeitungen enthalten, die entstanden, während ein anderes Gerät offline war.

## FAQ

### Kann Syncthing Obsidian synchronisieren?

Ja. Syncthing kann ein Obsidian-Vault synchronisieren, weil ein Obsidian-Vault ein lokaler Ordner ist. Die wichtige Frage ist, ob Sie bereit sind, Dateisynchronisierung, Konflikte, Geräteverfügbarkeit und mobiles Verhalten selbst zu steuern.

### Ist Syncthing Ende-zu-Ende-verschlüsselt?

Syncthing sichert die Kommunikation zwischen authentifizierten Geräten mit TLS und speichert Ihre Dateien nicht auf einem zentralen Syncthing-Server. Es gibt außerdem einen optionalen Modus für nicht vertrauenswürdige Geräte, um verschlüsselte Daten auf einem Gerät zu speichern, dem Sie nicht vollständig vertrauen. Das unterscheidet sich von einem gehosteten Obsidian-Synchronisierungsdienst, bei dem Vault-Daten standardmäßig lokal verschlüsselt werden, bevor sie hochgeladen und entfernt in verschlüsselter Form gespeichert werden.

### Ist Syncthing besser als Obsidian Sync?

Es kommt darauf an, was Ihnen wichtig ist. Syncthing ist kostenlos, Open Source und Peer-to-Peer. Obsidian Sync ist offiziell, integriert und für Obsidian gebaut. Syncthing gibt Ihnen mehr Kontrolle, aber Obsidian Sync braucht in der Regel weniger Betriebsaufwand.

### Ist Synch eine Alternative zu Syncthing für Obsidian?

Ja, wenn Ihr Ziel private Obsidian-Synchronisierung ist und nicht allgemeine Ordnersynchronisierung. Syncthing ist breiter und Peer-to-Peer. Synch ist enger und auf Obsidian ausgerichtet, mit Ende-zu-Ende-verschlüsselter gehosteter Synchronisierung und einem Weg zum Self-Hosting.

### Sollten Sie Syncthing oder Synch nutzen?

Nutzen Sie Syncthing, wenn Sie Peer-to-Peer-Dateisynchronisierung wollen und die Details selbst steuern können. Nutzen Sie Synch, wenn Sie eine private, Ende-zu-Ende-verschlüsselte Alternative zu Obsidian Sync wollen, die sich leichter einrichten lässt und um das Verhalten des Vaults herum entworfen ist.

## Fazit

Syncthing ist ein starkes Dateisynchronisierungswerkzeug. Für die richtigen Nutzer kann es ein Obsidian-Vault gut synchronisieren.

Aber es bleibt Dateisynchronisierung. Es weiß nicht, was ein Obsidian-Vault bedeutet, welche Dateien Plugin-Zustand sind, welche Konflikte wichtig sind oder welchen Wiederherstellungsablauf ein Notiz-Nutzer erwartet.

Wenn Sie maximale Peer-to-Peer-Kontrolle wollen, lohnt sich Syncthing.

Wenn Sie private Obsidian-Synchronisierung mit Ende-zu-Ende-Verschlüsselung und weniger Einrichtungsaufwand wollen, ist Synch für genau diese Aufgabe gebaut.
