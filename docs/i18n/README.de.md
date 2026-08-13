<h1 align="center">Synch</h1>

<p align="center">Ende-zu-Ende-verschlüsselte Synchronisierung für Obsidian.</p>

<p align="center">
  <a href="https://synch.run/de">Website</a> ·
  <a href="https://synch.run/de/self-hosting">Cloudflare-Deployment</a> ·
  <a href="https://synch.run/de/self-hosting-docker">Docker-Deployment</a>
</p>

<p align="center">
  <a href="https://obsidian.md/plugins?id=synch"><img alt="Obsidian-Community-Plugin" src="https://img.shields.io/badge/Obsidian-Community%20Plugin-7c3aed?style=flat-square" /></a>
  <a href="../../LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" /></a>
</p>

<p align="center">
  <a href="../../README.md">English</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://synch.run/de"><img alt="Synch-Übersicht" src="../../.github/assets/synch-preview.webp" /></a>
</p>

---

Halten Sie Ihren Obsidian-Vault mit lokaler Verschlüsselung, Versionsverlauf
und konfliktsicherer Dateiverarbeitung über Geräte hinweg synchron.

Synch ist ein unabhängiges Community-Plugin und ein unabhängiger Dienst. Es
besteht keine Verbindung zu Obsidian.

## Warum Synch?

- **Privatsphäre von Anfang an** — Vault-Daten werden vor dem Upload auf Ihrem Gerät verschlüsselt.
- **Schnelle Synchronisierung** — Änderungen werden häufig erkannt und über Geräte hinweg synchronisiert.
- **Wiederherstellbar** — Stellen Sie frühere Versionen und gelöschte Dateien aus dem verschlüsselten Verlauf wieder her.
- **Konfliktsicher** — Nicht überlappende Markdown-Bearbeitungen können automatisch zusammengeführt werden.
- **Hosting nach Ihrer Wahl** — Nutzen Sie Synch Cloud oder betreiben Sie Ihren eigenen Synch-Server.

## So funktioniert es

```mermaid
flowchart LR
    device["Ihr Gerät"] --> encrypt["Vault-Daten lokal verschlüsseln"]
    encrypt --> server["Synch Cloud oder Ihr selbst gehosteter Server"]
    server --> other["Auf einem anderen Gerät herunterladen und entschlüsseln"]
```

Der Synchronisierungsdienst speichert verschlüsselte Datei-Blobs und
verschlüsselte Synchronisierungsmetadaten. Er ist so konzipiert, dass der
gehostete Dienst Ihre Klartext-Notizen, Klartext-Dateipfade oder Vault-Schlüssel
nicht lesen kann.

## Obsidian-Synchronisierungsoptionen im Vergleich

Jede Option hat ein anderes Gleichgewicht aus Komfort, Kontrolle und
Einrichtungsaufwand.

| Option | Verschlüsselung | Speichermodell | Konflikthandhabung | Geeignet für |
| --- | --- | --- | --- | --- |
| **Synch** | E2EE auf dem Gerät | Synch Cloud oder selbst gehostet | Führt nicht überlappende Markdown-Bearbeitungen automatisch zusammen; bewahrt überlappende Konflikte | Anwender, die einen einfachen, quelloffenen, datenschutzorientierten Workflow wünschen |
| [Obsidian Sync](https://obsidian.md/sync) | E2EE standardmäßig; Standardverschlüsselung ist ebenfalls verfügbar | Von Obsidian gehostet | Offizielle Obsidian-Integration und Synchronisierungsverlauf | Anwender, die den offiziellen gehosteten Dienst bevorzugen |
| [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) | E2EE | Selbst gehostete CouchDB, Objektspeicher oder optionales WebRTC | Führt einfache Konflikte automatisch zusammen | Anwender, die maximale Kontrolle über das Backend wünschen |
| [Remotely Save](https://github.com/remotely-save/remotely-save) | Optionale passwortbasierte E2EE | Ihr S3, WebDAV, Dropbox, OneDrive, Google Drive und anderer Speicher | Grundlegende Konflikterkennung; erweiterte intelligente Konflikthandhabung ist in Pro verfügbar | Anwender, die bereits einen bevorzugten Speicheranbieter haben |

Dieser Vergleich bleibt bewusst auf einer hohen Ebene. Prüfen Sie die aktuelle
Dokumentation und die Einstellungen jedes Projekts, bevor Sie einen wichtigen
Vault migrieren.

## Funktionen

- Nahezu sofortige Synchronisierung
- Verschlüsselter Versionsverlauf
- Wiederherstellung gelöschter Dateien
- Automatisches Zusammenführen von Markdown-Konflikten
- Konfliktkopien bei überlappenden Bearbeitungen
- Markdown-Dateien standardmäßig aktiviert
- Bilder, Audio, Video und PDF-Dateien standardmäßig aktiviert
- Zusätzliche Datei- und Ordnerausschlüsse
- Gehostete Synch Cloud
- Benutzerdefinierte API-URLs für selbst gehostete Deployments
- Unterstützung für Desktop- und Mobile-Obsidian

## Erste Schritte

### Synch Cloud

1. Öffnen Sie in Obsidian **Settings → Community plugins**.
2. Deaktivieren Sie Restricted mode und wählen Sie **Browse**.
3. Suchen Sie nach **Synchrun**.
4. Installieren und aktivieren Sie das Plugin.
5. Öffnen Sie die Einstellungen von Synchrun und melden Sie sich an.
6. Erstellen oder verbinden Sie einen Remote-Vault.

Sobald die Verbindung hergestellt ist, lassen Sie Obsidian geöffnet, während
Synch lokale Änderungen hochlädt und Remote-Änderungen herunterlädt.

### Selbst gehostetes Synch

Die Cloudflare-Deployment-Anleitung stellt Synch auf Ihrem eigenen
Cloudflare-Konto bereit. Für ein Deployment ohne Cloudflare verwenden Sie die
Docker/systemd-Anleitung.

Sie können Synch in folgenden Umgebungen betreiben:

- Cloudflare
- Docker
- Ihrer eigenen Hardware mit systemd

Siehe die Deployment-Anleitungen:

- [Cloudflare-Deployment](https://synch.run/de/self-hosting)
- [Docker/systemd-Deployment](https://synch.run/de/self-hosting-docker)

Nach dem Deployment legen Sie in den Plugin-Einstellungen die benutzerdefinierte
API-Basis-URL fest.

## Sicherheitshinweise

Erstellen Sie immer eine vollständige Sicherung Ihres Vaults, bevor Sie:

- einen neuen Synchronisierungsanbieter installieren
- von einer anderen Synchronisierungslösung migrieren
- Verschlüsselungseinstellungen ändern
- einen Remote-Vault zurücksetzen oder erneut verbinden

Betreiben Sie nicht mehrere Synchronisierungsanbieter für denselben Vault, es
sei denn, Sie verstehen vollständig, wie deren Dateiüberwachung und
Konfliktlösung zusammenwirken.

### Offenlegungen

<details>
<summary>Offenlegungen anzeigen</summary>

Dieser Abschnitt dient der Prüfung gemäß der Obsidian-Entwicklerrichtlinie und
richtet sich an Nutzer, die vor der Installation verstehen möchten, was das
Plugin tut.

### Kontoanforderungen

Für den gehosteten Synchronisierungsdienst ist ein Synch-Konto erforderlich. Das
Konto dient der Authentifizierung von Geräten, dem Erstellen und Verbinden von
Remote-Vaults, der Ausgabe von Synchronisierungstokens, der Durchsetzung von
Speicherlimits und der Verwaltung des Dienstzugriffs.

### Netzwerknutzung

Synch verbindet sich über HTTPS und WebSocket-Verbindungen mit der
konfigurierten Synch-API-Basis-URL. Beim gehosteten Dienst handelt es sich um
von Synch betriebene Infrastruktur. Der Standardendpunkt der gehosteten API ist
`https://api.synch.run`, die Echtzeit-Synchronisierung nutzt WebSocket-Verbindungen
unter `wss://api.synch.run`. Das Plugin verwendet Netzwerkanfragen, um:

- sich anzumelden und eine authentifizierte Gerätesitzung aufrechtzuerhalten.
- Remote-Vaults zu erstellen, aufzulisten und zu verbinden.
- verschlüsselte Datei-Blobs und verschlüsselte Synchronisierungsmetadaten hochzuladen.
- verschlüsselte Datei-Blobs und verschlüsselte Synchronisierungsmetadaten herunterzuladen.
- Echtzeit-Synchronisierungsnachrichten über WebSocket-Verbindungen auszutauschen.
- Konto-, Abrechnungs-, Kontingent-, Speicher- und Synchronisierungsstatus zu lesen.

Die von Synch gehostete Infrastruktur nutzt Drittanbieter, darunter Cloudflare
für Hosting, Speicher, Netzwerk, Datenbanken, Queues und zugehörige
Infrastruktur. Die Abrechnung erfolgt über Polar.

### An Synch gesendete Daten

Vault-Dateiinhalte und Dateipfad-Metadaten werden vor dem Upload auf Ihrem Gerät
verschlüsselt. Synch speichert verschlüsselte Blobs und verschlüsselte
Synchronisierungsmetadaten und ist so konzipiert, dass der gehostete Dienst
Ihre Klartext-Notizen, Klartext-Dateipfade oder Klartext-Vault-Schlüssel nicht
lesen kann.

Ende-zu-Ende-Verschlüsselung verbirgt nicht alle betrieblichen Metadaten. Synch
kann Kontoinformationen, Vault-Kennungen und -Namen, Organisations- und
Mitgliedschaftsdaten, lokale Vault-Kennungen, Blob-Kennungen, Dateigrößen,
Speichernutzung, Zeitstempel, Synchronisierungscursor, Sitzungsinformationen,
IP-Adressen, User-Agent-Zeichenfolgen, Abrechnungskennungen für gehostete
Abonnements und ähnliche betriebliche Metadaten verarbeiten.

### Lokaler Vault-Zugriff

Synch liest und schreibt Dateien innerhalb des aktuellen Obsidian-Vaults, um
ausgewählte Vault-Dateien zu synchronisieren. Plugin-Einstellungen werden über
die Plugin-Daten-API von Obsidian gespeichert, das Gerätesitzungstoken über die
Secret-Storage-API von Obsidian, und der lokale Synchronisierungszustand in der
browserseitigen IndexedDB.

Synch liest oder schreibt nicht absichtlich Dateien außerhalb des aktuellen
Obsidian-Vaults.

### Zahlungen

Der gehostete Dienst bietet kostenlose und kostenpflichtige Abonnements. Der
aktuelle kostenpflichtige Hosting-Tarif ist Sync Starter, mit monatlicher oder
jährlicher Abrechnung. Zahlungsabwicklung und Abonnementverwaltung erfolgen
über Polar.

### Telemetrie, Werbung und Datenschutz

Das Synch-Obsidian-Plugin enthält keine clientseitige Telemetrie und zeigt keine
Werbung. Der gehostete Dienst kann betriebliche Protokolle und Dienstmetadaten
verarbeiten, die für Betrieb, Absicherung, Fehlerbehebung und Verbesserung des
Dienstes erforderlich sind.

Einzelheiten finden Sie in den rechtlichen Dokumenten des gehosteten Dienstes:

- [Datenschutzrichtlinie](https://synch.run/privacy)
- [Nutzungsbedingungen](https://synch.run/terms)

</details>

## Mitwirken

Issues, Fehlerberichte, Verbesserungen der Dokumentation und Pull Requests sind
willkommen.

## Lizenz

Synch ist Open Source unter der [MIT License](../../LICENSE).
