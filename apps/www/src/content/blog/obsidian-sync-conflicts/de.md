---
title: "Warum Obsidian-Notizen beim Synchronisieren dupliziert werden oder verschwinden"
description: "Warum Synchronisierungskonflikte in Obsidian entstehen, wie doppelte Notizen und fehlende Änderungen zustande kommen und wie Sie Ihr Vault auf Desktop und Mobilgerät sicherer halten."
pubDate: 2026-05-14
---

Obsidian ist stark, weil Ihre Notizen einfach Dateien sind. Ein Vault ist ein Ordner, den Sie prüfen, sichern, verschieben und mit anderen Werkzeugen bearbeiten können.

Genau diese Stärke erklärt auch, warum Synchronisierungskonflikte frustrierend sein können.

Wenn zwei Geräte dieselbe Notiz bearbeiten, bevor sie die Änderungen des jeweils anderen gesehen haben, muss ein Synchronisierungswerkzeug eine Entscheidung treffen. Es kann eine Version behalten, ein Duplikat anlegen, eine Konfliktkopie schreiben oder Sie bitten, den Unterschied aufzulösen. Ist das Werkzeug ein allgemeiner Dateisynchronisierungsdienst, versteht es möglicherweise nicht, welche Datei eine Notiz ist, welche eine Plugin-Einstellung und welche Änderung am wichtigsten ist.

So entstehen Suchanfragen wie:

- Obsidian hat meine Notiz dupliziert
- Obsidian conflicted copy
- Obsidian Sync hat Dateien gelöscht
- Obsidian-Notizen fehlen nach der Synchronisierung
- Obsidian-Konflikt mit iCloud oder Dropbox
- Obsidian-Synchronisierung auf dem Mobilgerät funktioniert nicht

Die gute Nachricht: Die meisten Synchronisierungskonflikte in Obsidian sind nachvollziehbar. Sie entstehen in der Regel aus wenigen wiederkehrenden Mustern.

![Zwei Geräte bearbeiten dasselbe Markdown-Vault und erzeugen einen Synchronisierungskonflikt](./sync-conflict-diverge.webp)

## Was ein Synchronisierungskonflikt bedeutet

Ein Synchronisierungskonflikt entsteht, wenn ein Synchronisierungssystem zwei oder mehr Versionen einer Datei nicht sicher zusammenführen kann.

Stellen Sie sich diese Abfolge vor:

1. Ihr Laptop hat `Daily notes/2026-05-14.md`.
2. Ihr Telefon lädt diese Notiz herunter.
3. Ihr Laptop bearbeitet die Notiz, während das Telefon offline ist.
4. Ihr Telefon bearbeitet ebenfalls die alte Version, während es offline ist.
5. Beide Geräte verbinden sich wieder.

Nun gibt es zwei echte Versionen desselben Dateipfads. Ein Synchronisierungswerkzeug kann nicht immer wissen, welche Sie behalten wollten. Wählt es stillschweigend eine, können Sie Arbeit verlieren. Behält es beide, sehen Sie möglicherweise ein Duplikat oder eine Konfliktdatei.

Dieses Duplikat kann unordentlich wirken, ist aber oft die sicherere Folge. Ein sichtbarer Konflikt lässt sich leichter reparieren als ein unsichtbares Überschreiben.

## Warum Obsidian-Vaults häufiger Konflikte erzeugen als normale Ordner

Ein Obsidian-Vault sieht aus wie ein einfacher Ordner, ist aber aktiver, als viele erwarten.

Ihr Vault kann enthalten:

- Markdown-Notizen
- Bilder, PDFs, Audio und andere Anhänge
- Canvas-Dateien
- Plugin-Einstellungen
- Theme- und CSS-Snippet-Dateien
- Workspace-Layout-Dateien
- mobilgerätespezifische Einstellungen
- versteckte Dateien in `.obsidian`

Manche dieser Dateien bearbeiten Sie. Manche bearbeitet Obsidian. Manche bearbeiten Community-Plugins. Eine Datei kann sich ändern, auch wenn Sie bewusst keine Notiz bearbeitet haben.

Das ist wichtig, weil die meisten Synchronisierungswerkzeuge auf Dateiebene arbeiten. Sie sehen „diese Datei hat sich hier geändert“ und „diese Datei hat sich dort geändert“. Sie verstehen nicht immer, ob eine Änderung eine bedeutsame Notizbearbeitung ist, eine vorübergehende Workspace-Aktualisierung oder ein Plugin, das seine eigene Einstellungsdatei neu schreibt.

## Die häufigsten Ursachen

### 1. Bearbeiten, bevor die Synchronisierung fertig ist

Das ist der klassische Konflikt.

Sie öffnen Obsidian auf dem Telefon, tippen schnell eine Notiz und merken später, dass die Laptop-Version noch nicht fertig hochgeladen war. Oder Sie wecken einen Laptop, beginnen sofort zu schreiben, und die neuesten Änderungen vom Telefon sind noch nicht angekommen.

Das Risiko ist am höchsten, wenn:

- ein Gerät offline war
- die Hintergrundsynchronisierung auf dem Mobilgerät verzögert ist
- ein großer Anhang noch hochgeladen wird
- Sie Geräte schnell wechseln
- Sie eine Synchronisierungsmethode nutzen, die manuelle Pull-, Push- oder Sync-Befehle verlangt

Die Lösung ist unspektakulär, aber wirksam: Bevor Sie auf einem zweiten Gerät bearbeiten, warten Sie, bis die Synchronisierung abgeschlossen ist. Wenn Ihr Synchronisierungswerkzeug eine Statusanzeige hat, prüfen Sie sie. Wenn es manuelle Befehle nutzt, führen Sie sie vor dem Schreiben aus.

![Ein Telefon öffnet ein Vault, bevor die letzte Synchronisierung abgeschlossen ist](./mobile-sync-not-ready.webp)

### 2. Dasselbe Vault mit zwei Werkzeugen synchronisieren

Synchronisieren Sie ein Obsidian-Vault nicht mit mehreren Synchronisierungssystemen gleichzeitig, es sei denn, Sie verstehen das Zusammenspiel sehr genau.

Vermeiden Sie zum Beispiel Kombinationen wie:

- Obsidian Sync plus iCloud Drive für dasselbe Vault
- Syncthing plus Dropbox für dasselbe Vault
- Git-Automatisierung plus einen Cloud-Drive im selben Ordner
- ein Community-Synchronisierungs-Plugin plus einen Dateisynchronisierungsordner um das Vault herum

Das kann Schleifen, veraltete Versionen, doppelte Dateien und verwirrendes Konfliktverhalten erzeugen. Jedes Synchronisierungssystem kann glauben, es sei die Quelle der Wahrheit.

Wenn Sie von einer Synchronisierungsmethode zu einer anderen wechseln, schalten Sie zuerst die alte aus. Legen Sie eine Sicherung an, prüfen Sie die neue Methode und löschen Sie erst dann die alte entfernte Kopie, wenn Sie sie nicht mehr brauchen.

### 3. Zu viel von `.obsidian` synchronisieren

Der Ordner `.obsidian` speichert wichtige Vault-Konfiguration. Darin können Plugins, Einstellungen, Themes, Snippets, Workspace-Zustand und gerätespezifische Layout-Dateien liegen.

Alles zu synchronisieren kann bequem sein. Tastenkürzel, Plugin-Liste und Theme folgen Ihnen überallhin.

Es kann aber auch Probleme erzeugen. Ein Desktop-Layout muss auf dem Mobilgerät keinen Sinn ergeben. Ein Plugin kann Einstellungen häufig neu schreiben. Zwei Geräte können sich über eine Workspace-Datei uneinig sein, die Ihnen egal ist.

Es gibt keine universelle Antwort. Der sicherere Weg ist, bewusst zu entscheiden.

Wenn Sie überall dasselbe Erlebnis wollen, synchronisieren Sie die meisten Einstellungen, behalten Konflikte bei Plugins aber im Blick. Wenn jedes Gerät ein eigenes Layout haben soll, schließen Sie Workspace- und gerätespezifische Dateien aus, soweit Ihr Synchronisierungswerkzeug Ausschlüsse unterstützt.

### 4. Schnelle Änderungen an Plugins oder Anhängen

Manche Dateien ändern sich schnell:

- von Plugins erzeugte Datenbanken
- JSON-Einstellungsdateien
- Canvas-Dateien
- große PDFs oder Bilder
- Notizen aus Capture-Workflows
- Dateien, die durch Automatisierung umbenannt werden

Schnelle Änderungen sind schwerer sicher zu synchronisieren, besonders wenn Mobilgeräte schlafen, Netzwerke wechseln oder große Uploads hinter kleineren Markdown-Bearbeitungen zurückbleiben.

Wenn Sie oft große Dateien anhängen, geben Sie ihnen Zeit zum Hochladen, bevor Sie dasselbe Vault woanders bearbeiten. Wenn ein Plugin große oder häufig wechselnde Datendateien schreibt, prüfen Sie, ob diese Dateien überhaupt synchronisiert werden sollten.

### 5. Unterschiede bei Groß-/Kleinschreibung und Pfaden

Verschiedene Plattformen behandeln Dateinamen nicht immer gleich.

Ein Pfad, der auf einem System funktioniert, kann auf einem anderen Probleme machen. Beispiele:

- `Ideas.md` und `ideas.md`
- Dateinamen mit reservierten Zeichen
- sehr lange Pfade
- Umbenennungen, die nur die Groß-/Kleinschreibung ändern
- Anhänge, die ein Gerät verschoben hat, während ein anderes Gerät noch den alten Pfad referenziert

Obsidian selbst ist plattformübergreifend, aber Ihre Synchronisierungsschicht muss das Dateisystemverhalten von macOS, Windows, Linux, iOS und Android trotzdem in Einklang bringen.

Halten Sie Notiz- und Anhangnamen möglichst einfach. Vermeiden Sie Umbenennungen nur in der Groß-/Kleinschreibung, wenn Sie plattformübergreifend synchronisieren. Wenn Sie `ideas.md` in `Ideas.md` umbenennen müssen, gehen Sie zuerst über einen Zwischennamen wie `ideas-temp.md`, lassen Sie synchronisieren und benennen Sie danach erneut um.

## Sind Konfliktdateien schlecht?

Nicht immer.

Eine Konfliktdatei bedeutet, dass das Synchronisierungswerkzeug beschlossen hat, eine Version nicht mit einer anderen zu überschreiben. Das kann lästig sein, schützt Sie aber vor stillem Datenverlust.

Das eigentliche Problem ist nicht, dass eine Konfliktdatei existiert. Das Problem entsteht, wenn Sie sie nicht bemerken, nicht wissen, welche Version aktuell ist, oder die falsche Kopie löschen.

Wenn Sie einen Konflikt finden:

1. Hören Sie auf, diese Notiz auf anderen Geräten zu bearbeiten.
2. Öffnen Sie beide Versionen.
3. Kopieren Sie fehlenden Inhalt in die Version, die Sie behalten wollen.
4. Benennen Sie die Konfliktdatei erst um oder löschen Sie sie, nachdem die Zusammenführung abgeschlossen ist.
5. Lassen Sie die endgültige Version synchronisieren, bevor Sie woanders weiterbearbeiten.

Wenn Ihr Synchronisierungswerkzeug einen Versionsverlauf hat, prüfen Sie ihn, bevor Sie etwas löschen. Der Versionsverlauf kann Sie retten, wenn beide sichtbaren Dateien verwirrend sind.

## So machen Sie die Obsidian-Synchronisierung sicherer

Sie können nicht jeden möglichen Konflikt verhindern, aber Sie können die Wahrscheinlichkeit deutlich senken.

![Ein sicherer Synchronisierungsablauf mit Sicherung, Synchronisierungsstatus und Versionsverlauf](./safe-sync-workflow.webp)

### Eine separate Sicherung behalten

Synchronisierung ist nicht dasselbe wie ein Backup.

Synchronisierung kopiert Änderungen. Wenn Sie versehentlich einen Ordner löschen und diese Löschung überallhin synchronisiert wird, kann die Synchronisierung den Fehler treu verbreiten. Ein echtes Backup gibt Ihnen einen weiteren Wiederherstellungspunkt.

Bevor Sie Synchronisierungswerkzeuge wechseln, ein Vault verschieben oder ein neues Plugin aktivieren, das viele Dateien anfasst, legen Sie eine separate Kopie des Vaults an. Eine einfache lokale Kopie ist besser als nichts. Eine versionierte Sicherung ist besser.

### Die Synchronisierung abschließen, bevor Sie das Gerät wechseln

Machen Sie sich eine Gewohnheit daraus:

- Beenden Sie das Schreiben auf Gerät A.
- Bestätigen Sie, dass die Synchronisierung abgeschlossen ist.
- Öffnen Sie Gerät B.
- Bestätigen Sie, dass Gerät B die Änderungen erhalten hat.
- Beginnen Sie zu bearbeiten.

Das gilt vor allem für Daily Notes, Inbox-Notizen und aktive Projektnotizen, die Sie von mehreren Geräten aus bearbeiten.

### Doppelte Synchronisierung vermeiden

Wählen Sie für ein Vault eine primäre Synchronisierungsmethode.

Wenn Sie Obsidian Sync nutzen, legen Sie dasselbe Vault nicht zusätzlich in einen Cloud-Drive-Synchronisierungsordner. Wenn Sie Syncthing nutzen, lassen Sie Dropbox oder iCloud nicht denselben Ordner mitverwalten. Wenn Sie Git nutzen, seien Sie vorsichtig mit automatisierten Pulls und Pushes parallel zu einem anderen Dateisynchronisierungssystem.

Ein Vault sollte eine klare Synchronisierungsautorität haben.

### Entscheiden, welche Einstellungen synchronisiert werden sollen

Behandeln Sie `.obsidian` als Konfiguration, nicht nur als weiteren Ordner.

Für viele Nutzer ist es hilfreich, Plugin-Listen und Grundeinstellungen zu synchronisieren. Workspace-Layout-Dateien zwischen Desktop und Mobilgerät zu synchronisieren, ist oft weniger hilfreich. Ob Plugin-Datenbanken synchronisiert werden sollten, hängt vom Plugin ab.

Wenn Konflikte wiederholt in Einstellungsdateien auftauchen, die Ihnen egal sind, erwägen Sie, sie auszuschließen. Wenn die Konflikte in Dateien auftauchen, die Ihnen wichtig sind, verlangsamen Sie und verstehen Sie, welches Gerät oder Plugin sie neu schreibt.

### Synchronisierungswerkzeuge mit Versionsverlauf bevorzugen

Versionsverlauf ist eines der wichtigsten Sicherheitsmerkmale für Obsidian.

Er hilft, wenn:

- eine Notiz überschrieben wird
- ein Ordner gelöscht wird
- eine schlechte Zusammenführung Inhalt entfernt
- ein Plugin viele Dateien ändert
- Sie das Problem erst Stunden oder Tage später entdecken

Je wichtiger Ihr Vault ist, desto weniger sollten Sie sich auf ein „neueste Datei gewinnt“-Verhalten ohne Wiederherstellung verlassen.

## Welche Synchronisierungsmethoden sind konfliktanfällig?

Jede Synchronisierungsmethode kann Konflikte erzeugen. Der Unterschied liegt darin, wie sichtbar, wiederherstellbar und nachvollziehbar der Konflikt ist.

Allgemeine Cloud-Drives wie iCloud Drive, Dropbox, Google Drive und OneDrive können für einfache Vaults funktionieren, sind aber nicht eigens um Obsidian-Verhalten herum gebaut. Sie können ausreichen, wenn Sie vor allem auf einem Gerät bearbeiten und andere zum Lesen nutzen.

Syncthing ist stark bei Peer-to-Peer-Dateisynchronisierung, besonders für technisch versierte Nutzer, synchronisiert aber weiterhin Dateien statt Obsidian-Absicht. Sie müssen Geräteverfügbarkeit, Konfliktdateien und Ausschlüsse verstehen.

Git ist hervorragend für Verlauf und Text-Diffs, aber für die meisten Notiz-Workflows keine mühelose Synchronisierung. Es verlangt, dass Sie an Commits, Pulls, Pushes und Merges denken.

Community-Plugins können flexibel sein, aber das Konfliktverhalten hängt vom Plugin, dem Speicher-Backend und den Einstellungen ab.

Offizielles [Obsidian Sync](https://obsidian.md/sync) ist die am stärksten integrierte kostenpflichtige Option. Es unterstützt Ende-zu-Ende-Verschlüsselung und Versionsverlauf, und sein Konfliktverhalten ist für Obsidian-Nutzer entworfen.

[Synch](/de/) ist für Nutzer gebaut, die eine günstigere, Open-Source- und Ende-zu-Ende-verschlüsselte Alternative zur Obsidian-Synchronisierung wollen. Das wichtige Entwurfsziel ist nicht nur, Dateien zwischen Geräten zu bewegen. Es ist, die Sicherheit des Vaults zu bewahren: verschlüsselte Synchronisierung, nachvollziehbarer Zustand und Wiederherstellung über den Versionsverlauf.

## Praktische Checkliste zur Konfliktvermeidung

Bevor Sie ein synchronisiertes Vault auf einem anderen Gerät bearbeiten, fragen Sie:

- Hat das vorherige Gerät die Synchronisierung abgeschlossen?
- Hat dieses Gerät die neuesten Änderungen erhalten?
- Synchronisieren Sie dieses Vault nur mit einer Synchronisierungsmethode?
- Haben Sie vor größeren Änderungen eine Sicherung?
- Wissen Sie, ob `.obsidian`-Einstellungen synchronisiert werden sollen?
- Bewahrt Ihre Synchronisierungsmethode einen Versionsverlauf?
- Wenn ein Konflikt erscheint, wissen Sie, wie Sie ihn zusammenführen statt ihn zu löschen?

Wenn die Antwort auf mehrere dieser Fragen nein ist, verlangsamen Sie, bevor Sie wichtige Notizen schreiben.

## Fazit

Synchronisierungskonflikte in Obsidian sind nicht zufällig. Sie entstehen in der Regel, wenn mehrere Geräte, Offline-Bearbeitungen, aktive Einstellungsdateien, große Anhänge oder überlappende Synchronisierungswerkzeuge mehr als eine gültige Version derselben Datei erzeugen.

Das sicherste Obsidian-Synchronisierungs-Setup ist nicht einfach das schnellste. Es ist das, das Ihnen eine klare Quelle der Wahrheit gibt, Ihre privaten Notizen schützt, zeigt, wann die Synchronisierung abgeschlossen ist, genug Verlauf behält, um Fehler rückgängig zu machen, und Konflikte nicht verbirgt, bis es zu spät ist.

Ihr Vault ist wertvoll, weil es Ihnen gehört. Synchronisierung sollte dieses Eigentum bewahren, nicht zerbrechlich machen.
