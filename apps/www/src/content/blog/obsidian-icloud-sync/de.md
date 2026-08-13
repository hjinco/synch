---
title: "Obsidian iCloud-Sync: Einrichtung, Probleme und sicherere Alternativen"
description: "Erfahren Sie, wie Sie Obsidian mit iCloud auf Mac, iPhone und iPad synchronisieren, was schiefgehen kann und wann Obsidian Sync oder Synch die bessere Wahl sind."
pubDate: 2026-05-10
---

Wenn Sie Obsidian auf einem Mac und einem iPhone nutzen, ist **iCloud-Sync** wahrscheinlich die erste Lösung, die Sie in Betracht ziehen.

Es ist in Apple-Geräte eingebaut. Es kann kostenlos sein, wenn Sie bereits genug iCloud-Speicher haben. Es braucht kein weiteres Synchronisierungsabo. Für ein einfaches Setup nur mit Apple-Geräten kann es gut funktionieren.

Aber iCloud ist kein Obsidian-Synchronisierungsdienst. Es ist ein allgemeiner Dateisynchronisierungsdienst.

Dieser Unterschied zählt. Ein Obsidian Vault ist ein Ordner aus Markdown-Dateien, Anhängen, Plugin-Einstellungen, Themes, Snippets, Canvas-Dateien und versteckter Konfiguration. Wenn die Synchronisierung verzögert ist, eine Datei ausgelagert wird oder zwei Geräte bearbeiten, bevor sie die neueste Version haben, kann das Ergebnis verwirrend oder riskant sein.

Dieser Leitfaden erklärt, wie Obsidian iCloud-Sync funktioniert, wie Sie ihn einrichten, auf welche Probleme Sie achten sollten – und wann Sie eine andere Synchronisierungsmethode wählen sollten.

![Obsidian-Notizen, die per iCloud zwischen MacBook, iPhone und iPad synchronisiert werden](./apple-devices-icloud-sync.webp)

## Können Sie Obsidian mit iCloud synchronisieren?

Ja. Obsidian unterstützt das Speichern von Vaults in iCloud Drive auf Apple-Geräten.

Das übliche Setup ist:

1. Erstellen oder verschieben Sie ein Obsidian Vault in iCloud Drive auf Ihrem Mac.
2. Öffnen Sie dasselbe Vault in Obsidian auf Ihrem iPhone oder iPad.
3. Lassen Sie iCloud Drive die Dateien zwischen den Geräten synchronisieren.

Für Nutzer, die nur Apple-Geräte verwenden, ist das oft der einfachste kostenlose Weg, Obsidian-Notizen zu synchronisieren.

Wichtig ist, den Kompromiss zu verstehen: Obsidian steuert die Synchronisierungs-Engine nicht. iCloud tut das. Wenn iCloud langsam, pausiert, speicherknapp, offline oder durch einen Konflikt verwirrt ist, kann Obsidian das nicht immer aus der App heraus beheben.

## So richten Sie Obsidian iCloud-Sync ein

Bevor Sie den Speicherort Ihres Vaults ändern, fertigen Sie eine Kopie Ihres Vaults außerhalb von iCloud an. Die erste Synchronisierung ist der einfachste Moment, ein Werkzeug auf den falschen Ordner zu zeigen oder versehentlich eine unvollständige Kopie als aktuell zu behandeln.

Bei einem einfachen Setup aus Mac, iPhone und iPad:

1. Stellen Sie sicher, dass jedes Gerät mit demselben Apple-Account angemeldet ist.
2. Schalten Sie iCloud Drive auf jedem Gerät ein.
3. Öffnen Sie auf dem Mac Obsidian und erstellen Sie ein neues Vault in iCloud Drive, oder verschieben Sie ein bestehendes Vault dorthin.
4. Belassen Sie das Vault im Ordner Obsidian in iCloud Drive, wenn Sie iOS oder iPadOS nutzen.
5. Installieren Sie Obsidian auf iPhone oder iPad.
6. Öffnen Sie das Vault aus iCloud Drive.
7. Warten Sie, bis die erste vollständige Synchronisierung fertig ist, bevor Sie auf dem zweiten Gerät bearbeiten.

Der Ordnerort ist auf Mobilgeräten wichtig. Die Obsidian-Hilfe empfiehlt, iCloud-Vaults unter `iCloud Drive/Obsidian/[Your Vault Name]` zu belassen, nicht in einem beliebigen iCloud-Ordner.

Wenn Sie eine aktuelle macOS-Version nutzen, markieren Sie den Obsidian-Ordner außerdem als lokal heruntergeladen. Klicken Sie im Finder mit der rechten Maustaste auf den Ordner Obsidian in iCloud Drive und wählen Sie **Immer heruntergeladen lassen**. Auf iPhone oder iPad nutzen Sie die Dateien-App, um sicherzustellen, dass die Vault-Dateien heruntergeladen sind, bevor Sie offline darauf angewiesen sind.

## Wann iCloud-Sync gut funktioniert

iCloud kann eine vernünftige Obsidian-Synchronisierungsmethode sein, wenn Ihr Setup einfach ist.

Es funktioniert am besten, wenn:

- Sie nur Mac, iPhone und iPad nutzen
- Ihr Vault klein oder mittelgroß ist
- Sie vor allem jeweils auf einem Gerät bearbeiten
- Sie nicht viele große Anhänge haben
- Sie gelegentliche Synchronisierungsverzögerungen hinnehmen können
- Sie separate Backups außerhalb von iCloud führen

Wenn Sie vor allem auf dem Mac schreiben und gelegentlich auf dem iPhone lesen oder leicht bearbeiten, kann iCloud ausreichen.

Das Risiko steigt, wenn Sie auf mehreren Geräten intensiv bearbeiten, oft offline arbeiten, große Anhänge nutzen oder ein Synchronisierungsverhalten erwarten, das sich sofort und konfliktbewusst anfühlt.

![Ein Synchronisierungskonflikt zwischen einer Obsidian-Notiz auf Laptop und Smartphone](./icloud-sync-conflict.webp)

## Häufige Probleme bei Obsidian iCloud-Sync

Die häufigsten iCloud-Probleme sind nicht immer offensichtlich als „Synchronisierungsfehler“. Sie wirken oft so, als würde Obsidian sich merkwürdig verhalten, obwohl das eigentliche Problem Dateiverfügbarkeit oder Synchronisierungszeitpunkt ist.

### Notizen erscheinen nicht auf iPhone oder iPad

Wenn eine Notiz auf Ihrem Mac existiert, aber nicht auf Ihrem iPhone, hat iCloud sie möglicherweise noch nicht heruntergeladen.

Prüfen Sie, dass:

- iCloud Drive auf dem Mobilgerät aktiviert ist
- das Vault im richtigen iCloud-Drive-Ordner Obsidian liegt
- die Dateien-App die Notiz sehen kann
- das Gerät genug Speicher hat
- iCloud den Upload vom Mac abgeschlossen hat

Beginnen Sie nicht damit, eine alte oder unvollständige Kopie derselben Notiz zu bearbeiten, während Sie warten. Das kann einen Konflikt erzeugen oder die Version überschreiben, die Sie behalten wollten.

### Das Vault wirkt leer oder unvollständig

Ein unvollständiges Vault bedeutet meist, dass der Ordner existiert, aber einige Dateien noch nicht heruntergeladen sind.

Das ist besonders wahrscheinlich nach dem Einrichten eines neuen Telefons, nach einer Geräterücksicherung oder beim Öffnen eines großen Vaults mit vielen Anhängen.

Bevor Sie annehmen, das Vault sei kaputt, prüfen Sie denselben Ordner in der Dateien-App und warten Sie, bis iCloud fertig ist. Wenn Sie ein Backup haben, vergleichen Sie damit, statt Dateien blind hin- und herzuschieben.

### Dateien werden vom Gerät ausgelagert

iCloud Drive kann lokale Kopien von Dateien entfernen, um Speicherplatz zu sparen. Das ist nützlich für Fotos und Dokumente, kann für ein Obsidian Vault aber gefährlich sein, weil Obsidian erwartet, dass die Vault-Dateien lokal verfügbar sind.

Nutzen Sie auf dem Mac **Immer heruntergeladen lassen** für den Ordner Obsidian. Auf älteren macOS-Versionen müssen Sie möglicherweise auch die Einstellung zur Speicheroptimierung des Mac prüfen.

Das Ziel ist einfach: Ihr Vault sollte auf der Festplatte vorhanden sein, nicht nur durch Platzhalterdateien repräsentiert werden.

### Bearbeitungen kollidieren zwischen Geräten

Konflikte können entstehen, wenn zwei Geräte dieselbe Datei bearbeiten, bevor jedes Gerät die neueste Version hat.

Zum Beispiel:

1. Sie bearbeiten eine Notiz auf dem Mac.
2. Der Mac hat den Upload noch nicht abgeschlossen.
3. Sie öffnen die ältere Version auf dem iPhone.
4. Sie bearbeiten oder schließen die Notiz dort.
5. iCloud entscheidet, welche Dateiversion gewinnt.

Im besten Fall erhalten Sie eine Konfliktkopie. Im schlechtesten Fall kann es so aussehen, als hätte eine Version die andere stillschweigend ersetzt.

Deshalb eignet sich iCloud-Sync besser für Bearbeitung auf jeweils einem Gerät als für schnelles Wechseln zwischen Mac und Mobilgerät.

### Die Synchronisierung hängt oder ist langsam

iCloud gibt Obsidian keinen zuverlässigen Button „Jetzt synchronisieren“. Wenn iCloud Drive hängt, wartet Obsidian im Wesentlichen auf das Betriebssystem.

Prüfen Sie:

- die Netzwerkverbindung
- das iCloud-Speicherquota
- den Gerätespeicher
- ob der Energiesparmodus Hintergrundaktivität einschränkt
- ob die Datei auf iCloud.com sichtbar ist
- ob iCloud Drive pausiert ist oder noch andere Dateien hochlädt

Warten Sie bei wichtigen Notizen, bis die Datei auf dem zweiten Gerät sichtbar und aktuell ist, bevor Sie dort bearbeiten.

## Ist Obsidian iCloud-Sync sicher?

iCloud-Sync kann für schlanke Workflows sicher genug sein, sollte aber nicht als vollständiges Backup oder als eigener Obsidian-Synchronisierungsdienst behandelt werden.

Synchronisierung und Backup sind unterschiedlich.

Wenn eine Datei auf einem Gerät gelöscht, geleert oder überschrieben wird, kann die Synchronisierung diese Änderung auf jedes Gerät tragen. Ein Synchronisierungsdienst hält Geräte konsistent. Ein Backup gibt Ihnen einen unabhängigen Wiederherstellungspunkt.

Wenn Ihr Obsidian Vault Ihnen wichtig ist, führen Sie ein separates Backup. Das kann Time Machine sein, ein kopierter Vault-Ordner, ein Git-Repository, ein anderes Backup-Werkzeug oder ein Synchronisierungsdienst mit Versionsverlauf.

Seien Sie außerdem vorsichtig mit Plugins und Einstellungen. Der Ordner `.obsidian` kann desktop- und mobilespezifisches Verhalten enthalten. Alle Einstellungen über iCloud zu synchronisieren mag bequem sein, kann aber auch dazu führen, dass mobiles Obsidian Einstellungen erbt, die für Ihren Mac gedacht waren.

## Sollten Sie iCloud mit Obsidian unter Windows nutzen?

In der Regel nein.

iCloud ist am sinnvollsten, wenn jedes Gerät im Apple-Ökosystem ist. Sobald Windows ins Setup kommt, steigen Risiko und Reibung.

Windows-iCloud-Drive kann langsamer, weniger vorhersehbar und anfälliger für ausstehende Synchronisierungszustände oder doppelte Dateien sein als das native Apple-Erlebnis. Obsidian-Vaults ändern sich oft, und das macht sie zu einem schlechten Fit für jede Dateisynchronisierung, die mit schnellen Ordnerupdates kämpft.

Wenn Sie Obsidian zwischen Windows und Apple-Geräten synchronisieren müssen, ziehen Sie stattdessen eine plattformübergreifende, Obsidian-orientierte Synchronisierungsmethode in Betracht:

- offizielles Obsidian Sync
- Synch
- ein sorgfältig konfiguriertes Community-Plugin
- Syncthing, wenn Sie sich zutrauen, die Synchronisierung von Gerät zu Gerät zu verwalten
- Git, wenn Sie explizite Versionskontrolle wollen und mit Konflikten umgehen können

iCloud ist nicht die beste Brücke zwischen Apple-Geräten und Windows für ein aktives Obsidian Vault.

![Ende-zu-Ende-verschlüsselte Obsidian-Synchronisierung zwischen Laptop und Smartphone](./encrypted-sync-alternative.webp)

## Obsidian iCloud vs. Obsidian Sync vs. Synch

Hier der praktische Vergleich.

| Option | Am besten für | Stärke | Wichtigster Kompromiss |
| --- | --- | --- | --- |
| iCloud Drive | Nutzer nur mit Apple-Geräten und einfachen Vaults | einfach und oft kostenlos | nicht Obsidian-bewusst |
| Obsidian Sync | Nutzer, die den offiziellen integrierten Dienst wollen | ausgereift, plattformübergreifend, Ende-zu-Ende-verschlüsselt | kostenpflichtiges Abo |
| Synch | Nutzer, die günstige gehostete Synchronisierung mit Open-Source-Code und Ende-zu-Ende-Verschlüsselung wollen | auf Obsidian ausgerichtet, privat, kostenlose und günstige Pläne | neueres Projekt |

iCloud ist eine Dateisynchronisierungsschicht. Sie kann ausreichen, wenn Ihr Vault einfach ist und alle Geräte Apple-Geräte sind.

[Obsidian Sync](https://obsidian.md/sync) ist der offizielle Dienst. Es ist die einfachste Empfehlung, wenn Sie das am stärksten integrierte Erlebnis wollen und der Preis für Sie passt.

Synch ist eine Open-Source-Alternative zu Obsidian Sync mit Ende-zu-Ende-Verschlüsselung. Es ist für Nutzer gedacht, die gehostete Synchronisierung wollen, ohne sich auf ein allgemeines Cloud-Laufwerk zu stützen und ohne den vollen Preis des offiziellen Dienstes zu zahlen. Synch hat einen kostenlosen Plan für kleine Vaults und einen günstigen Starter-Plan für Nutzer, die mehr Platz brauchen.

## Bewährte Praktiken für Obsidian iCloud-Sync

Wenn Sie sich für iCloud entscheiden, halten Sie das Setup konservativ.

- Sichern Sie Ihr Vault, bevor Sie es nach iCloud verschieben
- Belassen Sie das Vault im empfohlenen iCloud-Drive-Ordner Obsidian
- Markieren Sie den Ordner Obsidian als lokal heruntergeladen
- Warten Sie, bis die erste Synchronisierung fertig ist, bevor Sie auf einem anderen Gerät bearbeiten
- Vermeiden Sie es, dieselbe Notiz auf zwei Geräten gleichzeitig zu bearbeiten
- Seien Sie vorsichtig, wenn Sie offline arbeiten
- Kombinieren Sie nicht mehrere Synchronisierungswerkzeuge auf demselben Vault
- Führen Sie ein unabhängiges Backup außerhalb von iCloud

Der letzte Punkt ist der wichtigste. iCloud kann helfen, Geräte synchron zu halten, sollte aber nicht Ihre einzige Wiederherstellungsstrategie sein.

## Häufig gestellte Fragen

### Ist Obsidian iCloud-Sync kostenlos?

Es kann kostenlos sein, wenn Sie bereits genug iCloud-Speicher haben. Sie müssen Obsidian nicht für die Synchronisierung über iCloud Drive bezahlen. iCloud-Speicher selbst kann jedoch einen kostenpflichtigen Apple-Plan erfordern, wenn Ihr Vault und andere Dateien das kostenlose Speicherlimit überschreiten.

### Warum wird meine Obsidian-Notiz nicht aufs iPhone synchronisiert?

Die häufigsten Gründe sind, dass iCloud Drive die Synchronisierung noch nicht abgeschlossen hat, das Vault nicht im erwarteten iCloud-Drive-Ordner Obsidian liegt, die Datei nicht lokal heruntergeladen wurde oder das Gerät nicht genug Speicher hat.

### Kann iCloud zu Datenverlust in Obsidian führen?

Jedes Dateisynchronisierungssystem kann zu Datenverlust beitragen, wenn eine leere, alte oder konfliktbehaftete Version die Version überschreibt, die Sie behalten wollten. Deshalb sollten Sie Backups führen und nicht auf einem zweiten Gerät bearbeiten, bevor die neuesten Änderungen angekommen sind.

### Kann ich iCloud und Obsidian Sync zusammen nutzen?

Betreiben Sie nicht zwei Synchronisierungssysteme auf demselben aktiven Vault. iCloud Drive und einen weiteren Obsidian-Synchronisierungsdienst im selben Ordner zu nutzen kann Konflikte und verwirrende Löschungen erzeugen. Wählen Sie eine primäre Synchronisierungsmethode für das Vault.

### Ist iCloud besser als Obsidian Sync?

iCloud ist günstiger, wenn Sie bereits Apple-Speicher nutzen, aber Obsidian Sync ist speziell für Obsidian gebaut und funktioniert auf mehr Plattformen. Wenn Zuverlässigkeit und plattformübergreifendes Verhalten wichtiger sind als der Preis, ist Obsidian Sync in der Regel die stärkere Option.

### Ist Synch ein iCloud-Ersatz für Obsidian?

Synch kann iCloud als Synchronisierungsschicht für ein Obsidian Vault ersetzen, wenn Sie einen Obsidian-orientierten, Ende-zu-Ende-verschlüsselten gehosteten Synchronisierungsdienst wollen. Das ist besonders relevant, wenn iCloud sich zu fragil anfühlt, wenn Sie Geräte außerhalb von Apple nutzen oder wenn Sie eine günstigere Alternative zum offiziellen Obsidian Sync wollen.

## Fazit

Obsidian iCloud-Sync ist ein guter Ausgangspunkt für Nutzer nur mit Apple-Geräten und einfachen Vaults. Es ist einfach, vertraut und oft kostenlos.

Es ist nicht die beste Wahl für jedes Vault.

Wenn Ihre Notizen wichtig sind, wenn Sie oft geräteübergreifend bearbeiten, wenn Windows Teil Ihres Setups ist oder wenn Sie klareres Wiederherstellungsverhalten wollen, ziehen Sie stattdessen ein Obsidian-orientiertes Synchronisierungswerkzeug in Betracht. Nutzen Sie offizielles Obsidian Sync für die am stärksten ausgereifte First-Party-Option. Nutzen Sie Synch, wenn Sie eine günstigere, Open-Source- und Ende-zu-Ende-verschlüsselte Alternative zu Obsidian Sync wollen.
