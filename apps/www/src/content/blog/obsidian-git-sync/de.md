---
title: "Obsidian Git-Sync: Die richtige Wahl, wenn Sie Git nicht kennen?"
description: "Ein verständlicher Leitfaden zur Synchronisierung von Obsidian mit Git für den Alltag: Was es ist, warum es empfohlen wird, wo es schwierig wird – und wann Synch einfacher ist."
pubDate: 2026-07-27
---

Wenn Sie nach einer kostenlosen Obsidian-Synchronisierung suchen, sagt irgendwann jemand: Nutzen Sie einfach Git.

Dieser Ratschlag taucht regelmäßig in Foren und Reddit-Threads auf. Obsidian-Notizen sind Markdown-Dateien. Git ist kostenlos. Dienste wie GitHub können eine Kopie Ihres Vaults speichern. Auf dem Papier klingt das perfekt.

Wenn Sie Git noch nie genutzt haben, wird es trotzdem schnell unübersichtlich.

Git ist kein Synchronisierungs-Button. Es ist ein System, das Schnappschüsse von Ordnern über die Zeit speichert und diese Schnappschüsse zwischen Computern austauscht. Entwickler nutzen es täglich für Code. Auch zum Notizenmachen lässt es sich verwenden – aber die Gewohnheiten unterscheiden sich von iCloud, Dropbox oder Obsidian Sync.

Deshalb lautet die eigentliche Frage nicht einfach:

> Kann Git Obsidian synchronisieren?

Sondern:

> Möchten Sie einen entwicklertypischen Ablauf aus Speichern und Hochladen lernen, nur um Ihre Notizen aktuell zu halten?

Dieser Leitfaden erklärt Obsidian Git-Sync in verständlicher Sprache: was daran gefällt, wo es für alltägliche Obsidian-Nutzer schwierig wird – und wann eine Ende-zu-Ende-verschlüsselte Alternative wie Synch einfacher ist.

## Was Git in Obsidian-Begriffen ist

Betrachten Sie Git als sorgfältiges Verlaufssystem für Notizen, nicht als automatische Cloud-Synchronisierung.

Alltagssprachlich:

- Ein **Repository** ist Ihr Vault-Ordner plus eine versteckte Änderungshistorie.
- Ein **Commit** ist ein Schnappschuss: „den aktuellen Stand meiner Notizen speichern.“
- Ein **Push** lädt diese Schnappschüsse in eine Online-Kopie hoch, oft auf GitHub.
- Ein **Pull** lädt neuere Schnappschüsse von dieser Online-Kopie auf ein anderes Gerät herunter.
- Ein **Merge-Konflikt** entsteht, wenn zwei Geräte dieselbe Notiz geändert haben, bevor sie voneinander wussten.

Git hält nicht stillschweigend jedes Gerät auf dem neuesten Stand, während Sie schreiben. Ihre Notizen bewegen sich, wenn Schnappschüsse gespeichert und übertragen werden.

Das ist der zentrale Kompromiss.

Bei einem normalen Synchronisierungsdienst bearbeiten Sie eine Notiz und erwarten, dass das andere Gerät nachzieht.

Bei Git bearbeiten Sie eine Notiz, speichern einen Schnappschuss, laden ihn hoch und stellen sicher, dass das andere Gerät ihn herunterlädt, bevor Sie dort weiterarbeiten.

## So sieht Obsidian Git-Sync in der Praxis aus

Die meisten „Obsidian Git-Sync“-Setups funktionieren so:

1. Sie machen Ihren Vault-Ordner zu einem Git-Repository.
2. Sie speichern Schnappschüsse Ihrer Notizänderungen.
3. Sie laden diese Schnappschüsse in ein privates Online-Repository hoch.
4. Auf einem anderen Computer laden Sie dasselbe Repository herunter und öffnen es in Obsidian.

Viele nutzen das Community-Plugin [Obsidian Git](https://github.com/Vinzent03/obsidian-git), um mehr davon in Obsidian erledigen zu können, ohne dauerhaft im Terminal zu arbeiten.

Der grundlegende Ablauf sieht so aus:

```txt
Obsidian Vault auf Gerät A
        |
Schnappschuss speichern + hochladen
        |
Online-Git-Kopie
        |
aktuellen Schnappschuss herunterladen
        |
Obsidian Vault auf Gerät B
```

Die Online-Git-Kopie ist der Zwischenpunkt zwischen den Geräten. Das kann gut funktionieren, wenn Sie sorgfältig vorgehen.

Es hängt trotzdem davon ab, dass Sie oder ein Plugin daran denken, Schnappschüsse zu speichern und zu übertragen. Eine Notiz zu bearbeiten ist nicht dasselbe wie eine Notiz zu synchronisieren.

## Warum Git trotzdem empfohlen wird

Git wird empfohlen, weil es kostenlos, nachvollziehbar und stark bei der Historie sein kann.

Was Sie bekommen:

- eine kostenlose oder günstige Möglichkeit, eine Online-Kopie Ihres Vaults zu behalten
- eine detaillierte Historie der Notizänderungen über die Zeit
- eine Möglichkeit, ältere und neuere Versionen einer Markdown-Notiz zu vergleichen
- mehr Kontrolle, als das Vault einfach in einen beliebigen Cloud-Ordner zu legen
- ein Setup, für das Sie nicht für Obsidian Sync bezahlen müssen

Das klingt attraktiv, wenn Sie kostenlose Synchronisierung wollen und Wert darauf legen, alte Versionen wiederherstellen zu können.

Weniger attraktiv ist es, wenn Sie eigentlich Folgendes wollen: Obsidian auf dem Smartphone öffnen, schnell etwas notieren und darauf vertrauen, dass der Laptop es bald sieht.

## Was Sie brauchen, bevor Sie Git ausprobieren

Wenn Git neu für Sie ist, rechnen Sie mit einer Lernkurve, bevor der erste reibungslose Synchronisierungstag kommt.

In der Regel müssen Sie verstehen:

- wie Sie ein privates Online-Repository anlegen
- wie Sie Obsidian mit diesem Repository verbinden
- wie Sie einen Schnappschuss Ihrer Notizen speichern
- wie Sie Änderungen hoch- und herunterladen
- was zu tun ist, wenn zwei Versionen derselben Notiz voneinander abweichen
- welche Dateien nicht in die Historie gehören

Sie brauchen außerdem ein separates Backup, bevor Sie beginnen. Kopieren Sie zuerst Ihr gesamtes Vault an einen sicheren Ort. Synchronisierungswerkzeuge können Fehler schnell vervielfältigen. Git ist keine Ausnahme.

Einige Einrichtungsdetails sind wichtiger, als sie klingen:

- Halten Sie das Online-Repository **privat**, es sei denn, Sie wollen Ihre Notizen bewusst öffentlich machen.
- Entscheiden Sie früh, ob Obsidian-Einstellungen in `.obsidian` enthalten sein sollen.
- Legen Sie keine Passwörter, Tokens oder geheimen Plugin-Einstellungen ins Repository.
- Synchronisieren Sie dasselbe Vault nicht gleichzeitig zusätzlich mit iCloud, Dropbox, Google Drive, OneDrive oder Syncthing.

Wenn diese Schritte sich bereits nach zu viel Aufwand anfühlen, ist Git vermutlich nicht die Synchronisierungsmethode, die Sie wollen.

## Wann Git gut funktionieren kann

Git kann für Obsidian funktionieren, wenn Ihr Alltag ruhig und vor allem desktopbasiert ist.

Es passt besser, wenn:

- Ihr Vault vor allem Textnotizen enthält, nicht viele Fotos und PDFs
- Sie hauptsächlich jeweils auf einem Computer schreiben
- Sie bereit sind, die neuesten Notizen herunterzuladen, bevor Sie auf einem anderen Gerät schreiben
- Ihnen eine detaillierte Historie wichtiger ist als unsichtbare Hintergrundsynchronisierung
- Sie nichts dagegen haben, ein paar neue Konzepte zu lernen
- das Smartphone ergänzend ist, nicht Ihr Hauptort zum Schreiben

Ein realistischer guter Tag mit Git sieht so aus:

1. Öffnen Sie Obsidian auf dem Laptop.
2. Stellen Sie sicher, dass Sie die neuesten Notizen haben.
3. Schreiben Sie eine Weile.
4. Speichern Sie einen Schnappschuss.
5. Laden Sie ihn hoch.
6. Laden Sie später auf einem anderen Computer herunter, bevor Sie wieder bearbeiten.

Wenn dieser Rhythmus sich natürlich anfühlt, kann Git zuverlässig sein.

Wenn Sie oft zwischen Smartphone und Laptop wechseln, ohne an den Synchronisierungsstatus zu denken, wird Git Ihnen im Weg stehen.

## Wo Obsidian Git-Sync schwierig wird

### 1. Es fühlt sich nicht wie normale Synchronisierung an

Bei Obsidian Sync, iCloud oder einer speziellen Synchronisierungs-App ist das mentale Modell einfach: hier bearbeiten, dort sehen.

Bei Git lautet das mentale Modell: hier bearbeiten, Schnappschuss speichern, hochladen, dann dort herunterladen.

Plugins können einen Teil davon automatisieren. Die zugrunde liegende Idee können sie nicht entfernen. Wenn ein Schnappschuss nie hochgeladen wurde, hat das andere Gerät Ihre Notiz nicht.

### 2. Konflikte unterbrechen das Schreiben

Wenn Smartphone und Laptop dieselbe Notiz bearbeiten, bevor sie synchronisiert sind, kann Git nicht stillschweigend raten, welche Version richtig ist. Sie sehen möglicherweise Konfliktmarkierungen in der Notiz und müssen sie selbst aufräumen.

Das ist sicherer, als eine Version stillschweigend zu löschen. Es ist trotzdem ärgerlich, wenn Sie nur schnell etwas notieren wollten.

Eine ausführlichere Erklärung, wie Sync-Konflikte in Obsidian über verschiedene Werkzeuge hinweg entstehen, finden Sie unter [warum Obsidian-Notizen beim Synchronisieren dupliziert werden oder verschwinden](/de/blog/obsidian-sync-conflicts).

### 3. Smartphones sind der Schwachpunkt

Desktop-Git-Setups sind bereits ein Projekt. Mobile Git-Setups sind schwieriger.

Auf einem Smartphone brauchen Sie möglicherweise zusätzliche Apps, extra Login-Schritte oder einen fragilen Plugin-Workflow. Schnelles Erfassen wird langsamer. Konflikte zu beheben wird schwieriger. Große Vaults werden schwerfälliger.

Wenn Ihr Hauptgrund für Synchronisierung lautet „tagsüber schreibe ich auf dem Smartphone“, ist Git in der Regel die falsche erste Wahl.

### 4. Bilder und PDFs machen alles schwerer

Git merkt sich die Historie. Das ist großartig für Text. Für große Dateien ist es unbequem.

Wenn Ihr Vault viele Bilder, PDFs oder Aufnahmen enthält, kann die Online-Kopie schnell wachsen. Eine große Datei später zu löschen verkleinert die Historie nicht immer. Medienlastige Vaults sind meist in einem Synchronisierungssystem besser aufgehoben, das für gemischte Dateien gebaut ist.

### 5. Privat ist nicht dasselbe wie verschlüsselt

Ein privates GitHub-Repository ist vor dem öffentlichen Internet verborgen. Das ist gut.

Es ist nicht dasselbe wie Ende-zu-Ende-Verschlüsselung.

Wenn Ihre Notizen als normales Markdown hochgeladen werden, kann der Git-Host lesbare Notizinhalte speichern. Bei Tagebüchern, Gesundheitsnotizen, Arbeitsnotizen oder allem Sensiblen ist dieser Unterschied wichtig.

Synch verschlüsselt Vault-Daten auf Ihrem Gerät vor dem Upload, sodass der Synchronisierungsserver verschlüsselte Daten speichert statt lesbarer Notizen. Wenn Sie die verständliche technische Fassung wollen, lesen Sie [wie die Ende-zu-Ende-Verschlüsselung von Synch funktioniert](/de/blog/encryption-and-decryption).

### 6. Zwei Synchronisierungssysteme auf einem Vault sind ein klassisches Desaster

Legen Sie ein Git-verwaltetes Vault nicht in iCloud, Dropbox, Google Drive, OneDrive oder Syncthing und lassen Sie Git gleichzeitig Schnappschüsse automatisieren. Zwei Systeme, die um denselben Ordner kämpfen, sind ein klassischer Weg zu Duplikaten, fehlenden Bearbeitungen und verworrener Historie.

Wählen Sie eine aktive Synchronisierungsmethode für das Vault, in dem Sie jeden Tag schreiben.

## Git vs. Synch

Git und Synch versuchen, unterschiedliche Probleme zu lösen.

Git ist ein Werkzeugkasten für Historie und Übertragung. Synch ist ein Open-Source-Synchronisierungsdienst mit Ende-zu-Ende-Verschlüsselung, gebaut für Obsidian.

| Frage | Git | Synch |
| --- | --- | --- |
| Wofür ist es da? | Notizhistorie speichern und Schnappschüsse zwischen Geräten bewegen | ein Obsidian Vault synchronisieren |
| Müssen Sie besondere Schritte lernen? | Ja: Schnappschüsse, Hochladen, Herunterladen, Konflikte aufräumen | deutlich weniger |
| Fühlt es sich wie normale Synchronisierung an? | nur bei sorgfältiger Automatisierung | ja, das ist das Ziel |
| Sind Notizen standardmäßig Ende-zu-Ende-verschlüsselt? | nein, nicht auf einem normalen Git-Host | ja, auf Ihrem Gerät vor dem Upload verschlüsselt |
| Smartphone-tauglich? | oft schwierig | für Obsidian auf mehreren Geräten gebaut |
| Am besten für | Menschen, die Git-artige Historie wollen und den Ablauf steuern können | Menschen, die private Obsidian-Synchronisierung wollen, ohne Git zu lernen |

Git ist attraktiv, wenn Historie und Kontrolle der Punkt sind und Sie bereit sind, das System zu bedienen.

Synch ist attraktiv, wenn Ihre Notizen zwischen Geräten wandern sollen, ohne dass Notizenmachen zur Repository-Pflege wird.

## Wann Git trotzdem lohnen kann

Wählen Sie Git, wenn:

- Sie neugierig genug sind, die Grundlagen langsam zu lernen
- Sie vor allem am Desktop schreiben
- Ihr Vault textlastig ist
- Sie eine detaillierte Änderungshistorie wollen
- Sie damit einverstanden sind, bewusst innezuhalten, um zu synchronisieren
- ein privates Repository für Ihre Notizen privat genug ist

Beginnen Sie trotzdem klein. Nutzen Sie zuerst ein Test-Vault. Fangen Sie nicht mit Ihrer einzigen Kopie von Jahren an Notizen an.

## Wann Synch besser passt

Wählen Sie Synch, wenn Sie eigentlich Obsidian-Synchronisierung wollen, kein Mini-Git-Projekt.

Synch passt besser, wenn:

- Sie keine Commits, Pulls und Merges lernen wollen, nur um Notizen zu synchronisieren
- Sie sowohl am Desktop als auch mobil schreiben
- Sie standardmäßig Ende-zu-Ende-Verschlüsselung wollen
- Sie gehostete Synchronisierung wollen, ohne ein allgemeines Cloud-Laufwerk zu nutzen
- Sie eine kostenlose oder günstige Alternative zu Obsidian Sync wollen
- Sie weniger bewegliche Teile wollen als Git plus Plugin plus Remote-Host

Der aktuelle Synch Free-Plan umfasst ein synchronisiertes Vault, 50 MB Speicher, eine maximale Dateigröße von 3 MB und 1 Tag Versionsverlauf. Der Starter-Plan umfasst ein synchronisiertes Vault, 1 GB Speicher, eine maximale Dateigröße von 5 MB und 1 Monat Versionsverlauf.

Damit ist Synch praktisch für kleine persönliche Vaults, Studierende, Hobby-Notizen und alle, die private verschlüsselte Synchronisierung wollen, ohne zuerst Entwicklerwerkzeuge zu lernen.

Wenn Sie noch Optionen vergleichen, siehe [die besten Obsidian-Sync-Alternativen 2026](/de/blog/obsidian-sync-alternatives) und [kostenlose Optionen für Obsidian-Synchronisierung](/de/blog/free-obsidian-sync).

## Wenn Sie Git trotzdem ausprobieren

Halten Sie das Setup schlicht und sorgfältig.

1. Kopieren Sie zuerst Ihr gesamtes Vault an einen sicheren Ort.
2. Nutzen Sie ein privates Online-Repository.
3. Beginnen Sie nach Möglichkeit mit einem kleinen Test-Vault.
4. Lernen Sie eine Schleife gründlich: Aktuelles herunterladen, schreiben, Schnappschuss speichern, hochladen.
5. Laden Sie auf einem zweiten Gerät immer herunter, bevor Sie bearbeiten.
6. Vermeiden Sie es, dieselbe Notiz auf zwei Geräten gleichzeitig zu bearbeiten.
7. Halten Sie große Anhänge nach Möglichkeit draußen.
8. Kombinieren Sie Git nicht mit einem anderen Synchronisierungswerkzeug im selben Ordner.

Wenn die erste Woche sich stressig statt hilfreich anfühlt, ist das eine nützliche Information. Git mag mächtig sein, aber es muss nicht das richtige Synchronisierungswerkzeug für Ihr Notizenleben sein.

## FAQ

### Kann Git Obsidian synchronisieren, wenn ich kein Entwickler bin?

Ja, es kann funktionieren, aber rechnen Sie mit einer Lernkurve. Git wurde für Softwarehistorie gebaut, nicht für beiläufige Notiz-Synchronisierung. Viele Obsidian-Nutzer lernen genug, um es zum Laufen zu bringen. Viele andere merken, dass sie Synchronisierung wollten, nicht ein neues System zum Verwalten.

### Reicht das Obsidian-Git-Plugin allein?

Es hilft am Desktop, indem es Ihnen Schaltflächen und Automatisierung in Obsidian gibt. Es nimmt Ihnen nicht ab, Schnappschüsse, Uploads, Downloads, Konflikte und Privatsphäre-Einstellungen zu verstehen.

### Ist Git eine gute kostenlose Alternative zu Obsidian Sync?

Es kann kostenlos oder günstig sein, ja. Die versteckte Kostenstelle ist Zeit und Aufmerksamkeit. Wenn Kostenlosigkeit am wichtigsten ist und Sie gerne tüfteln, kann Git einen Versuch wert sein. Wenn Notizen mit weniger Nachdenken synchronisiert werden sollen, schauen Sie sich eine spezielle Synchronisierungsoption an.

### Ist ein privates GitHub-Repository Ende-zu-Ende-verschlüsselt?

Nein. Privat bedeutet, dass andere Leute es nicht beiläufig durchstöbern können. Es bedeutet nicht, dass der Host nur unlesbare Daten speichert, die er nicht lesen kann. Wenn Sie Ende-zu-Ende-verschlüsselte gehostete Synchronisierung brauchen, nutzen Sie ein Werkzeug, das dafür gebaut ist.

### Sollte ich Git oder Synch nutzen?

Nutzen Sie Git, wenn Sie Notizhistorie in einem Repository wollen und bereit sind, den Ablauf zu lernen. Nutzen Sie Synch, wenn Sie private, Ende-zu-Ende-verschlüsselte Obsidian-Synchronisierung wollen, ohne Git selbst zu verwalten.

### Kann ich Git und Synch zusammen nutzen?

Nicht auf demselben aktiven Vault. Sie können eine separate Backup-Kopie woanders aufbewahren, aber lassen Sie nicht zwei aktive Synchronisierungssysteme einen Arbeitsordner verwalten.

## Fazit

Git kann ein Obsidian Vault synchronisieren. Für manche Menschen, besonders sorgfältige Desktop-Schreibende, denen Historie wichtig ist, funktioniert es gut.

Für viele alltägliche Obsidian-Nutzer ist es die falsche erste Antwort. Es verlangt, in Schnappschüssen, Uploads, Downloads und Konfliktbereinigung zu denken. Das ist viel Zeremonie, wenn Sie nur Notizen auf jedem Gerät wollten.

Wenn Sie gerne Git lernen und Ihr Ablauf vor allem aus Desktop-Textnotizen besteht, kann Obsidian Git-Sync eine starke kostenlose Option sein.

Wenn Sie private Obsidian-Synchronisierung mit Ende-zu-Ende-Verschlüsselung und weniger Verwaltungsaufwand wollen, ist Synch für genau diese Aufgabe gebaut.
