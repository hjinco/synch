---
title: Wie funktioniert die Ende-zu-Ende-Verschlüsselung in Synch?
description: Eine verständliche Erklärung, wie Synch Vault-Daten verschlüsselt, damit Sie Ihr Vault auf jedem Gerät entsperren können, ohne dass der Server Ihre Notizen liest.
pubDate: 2026-05-01
---

Ende-zu-Ende-Verschlüsselung bedeutet: Ihre Daten werden gesperrt, bevor sie Ihr Gerät verlassen – und nur wieder auf einem Ihrer Geräte entsperrt.

Der Server von Synch hilft beim Speichern und Synchronisieren Ihrer Daten, erhält aber nicht das Geheimnis, das zum Lesen nötig ist.

Die Grundidee sieht so aus:

```txt
Ihr Gerät: lesbare Notiz -> verschlüsselte Daten
Server: speichert verschlüsselte Daten
anderes Gerät: verschlüsselte Daten -> lesbare Notiz
```

Vor der Verschlüsselung könnte eine Notiz so aussehen:

```txt
Hello, this is my private note.
```

Nach der Verschlüsselung wirkt sie wie Zufallsdaten:

```txt
K9sV1xQ4...unreadable bytes...
```

Um diese scheinbar zufälligen Daten wieder in die ursprüngliche Notiz zu verwandeln, braucht ein Gerät den richtigen Schlüssel.

## Die zentrale Frage

Ein Großteil der Verschlüsselung lässt sich auf eine Frage reduzieren:

> Wer hat den Schlüssel?

Bei Synch hat Ihr Gerät den Schlüssel. Der Server speichert verschlüsselte Daten, erhält aber nicht den Klartext-Schlüssel, der zum Entschlüsseln nötig wäre.

Synch verschlüsselt Dateiinhalte und Metadaten wie Dateipfade auf Ihrem Gerät, bevor etwas hochgeladen wird. Ein anderes Gerät kann die verschlüsselten Daten vom Server herunterladen, liest sie aber erst, nachdem es denselben vault key lokal entsperrt hat.

Im Rest dieses Artikels erklären wir, wie das funktioniert.

## Zwei Geheimnisse, nicht eines

Wenn Sie in Synch ein Remote-Vault anlegen, wählen Sie ein Vault-Passwort.

![Bildschirm zum Anlegen eines Vault](./create-vault.png)

Es liegt nahe zu denken, dass dieses Passwort alle Dateien direkt verschlüsselt.

Das ist nicht der Fall.

Stattdessen verwendet Synch zwei unterschiedliche Geheimnisse:

```txt
vault password: das Passwort, das Sie sich merken und eingeben
vault key: ein von Synch erzeugter Zufallsschlüssel
```

Der vault key ist der eigentliche Schlüssel zum Verschlüsseln und Entschlüsseln Ihrer synchronisierten Vault-Daten.

Das Vault-Passwort hat eine andere Aufgabe: Es schützt den vault key, damit dieser sicher gespeichert und auf Ihren anderen Geräten entsperrt werden kann.

Einfach gesagt:

```txt
vault key = Schlüssel zu Ihren Daten
vault password = Schlüssel zum Entsperren des vault key
```

Dieser Zwischenschritt ist wichtig, weil von Menschen gewählte Passwörter in der Regel nicht zufällig genug sind, um sie direkt als starke Verschlüsselungsschlüssel zu verwenden. Selbst Passwörter, die einem Menschen stark erscheinen, können von Computern erraten werden, wenn ein Angreifer viele Versuche unternehmen kann.

Deshalb erzeugt Synch für die eigentliche Datenverschlüsselung einen zufälligen vault key von 32 Byte.

```txt
password = "my-strong-password"
vaultKey = "random-32-byte-key"
```

Anschließend schützt Synch diesen vault key mit Ihrem Passwort.

## Den vault key schützen

Synch darf den vault key nicht als lesbaren Text auf dem Server speichern. Sonst könnte der Server Ihre verschlüsselten Daten lesen.

Stattdessen speichert Synch eine verschlüsselte Kopie des vault key.

Dafür wandelt Synch Ihr Passwort zunächst in einen stärkeren Schlüssel namens `wrapKey` um.

```txt
password + salt + Argon2id settings
=> wrapKey
```

Der `wrapKey` verschlüsselt nicht Ihre Dateien. Er dient nur dazu, den vault key zu verschlüsseln – also zu „wrappen“.

Synch erzeugt den `wrapKey` mit Argon2id aus Ihrem Passwort:

```txt
Argon2id(
  password = "my-strong-password",
  salt = random 16 bytes,
  memory = 64 MiB,
  iterations = 3,
  parallelism = 1
)
=> wrapKey
```

Argon2id ist eine passwortbasierte Schlüsselableitungsfunktion. Vereinfacht gesagt ist das ein bewusst aufwendiger Weg, aus einem Passwort einen Verschlüsselungsschlüssel zu machen. Dadurch werden Passwortraten für Angreifer langsamer.

Das Salt ist Zufallsdaten, die zusammen mit dem verschlüsselten vault key gespeichert werden. Es ist kein Geheimnis. Seine Aufgabe ist es, dass dasselbe Passwort in unterschiedlichen Vaults nicht immer dasselbe Ergebnis liefert.

Wenn Sie dasselbe Passwort mit demselben Salt und denselben Einstellungen eingeben, erhält Synch denselben `wrapKey` erneut. Ist das Passwort falsch, entsteht ein anderer `wrapKey`.

Nun verschlüsselt Synch den vault key mit dem `wrapKey`:

```txt
AES-GCM encrypt (
  key = wrapKey,
  nonce = random 12 bytes,
  plaintext = vaultKey
)
=> encrypted vaultKey
```

AES-GCM ist das hier verwendete Verschlüsselungsverfahren. Die Nonce ist zufällig wirkende Daten, die für die Verschlüsselung nötig sind. Sie muss eindeutig sein, muss aber nicht geheim bleiben.

An diesem Punkt kann der Server das Paket mit dem verschlüsselten vault key speichern.

```json
{
  "kdf": {
    "name": "argon2id",
    "memoryKiB": 65536,
    "iterations": 3,
    "parallelism": 1,
    "salt": "b64_salt"
  },
  "wrap": {
    "algorithm": "aes-256-gcm",
    "nonce": "b64_nonce",
    "ciphertext": "b64_encrypted_vaultKey"
  }
}
```

Dieses Paket sagt einem Synch-Client, wie er später versuchen kann, den vault key zu entsperren. Es übergibt dem Server weder das Passwort noch den vault key.

Der Server hat:

```txt
salt
Argon2id settings
nonce
encrypted vaultKey
```

Der Server hat nicht:

```txt
password
wrapKey
vaultKey
```

Dieser Unterschied ist der Kern des Ende-zu-Ende-Verschlüsselungsdesigns von Synch.

## Was der Server sehen kann – und was nicht

Weil der Server den vault key nicht hat, kann er weder Ihre Dateiinhalte noch entschlüsselte Dateipfade lesen.

Der Server speichert verschlüsselte Daten und die Informationen, die Ihre eigenen Geräte brauchen, um sie nach Eingabe des richtigen Vault-Passworts zu entsperren.

Ende-zu-Ende-Verschlüsselung versteckt allerdings nicht alles. Der Server kann weiterhin Informationen sehen, die für den Sync-Dienst nötig sind, etwa Ihr Konto, die Vault-Kennung, Größen verschlüsselter Objekte, Änderungszeiten und Sync-Aktivität.

Die wichtige Grenze: Der Server sollte Ihre verschlüsselten Vault-Daten nicht eigenständig wieder in lesbare Notizen verwandeln können.

## Dateien und Metadaten verschlüsseln

Sobald Ihr Gerät den vault key entsperrt hat, verwendet Synch diesen Schlüssel als zentrales Geheimnis für die synchronisierten Daten.

Dateiinhalte werden vor dem Upload verschlüsselt. Metadaten wie Dateipfade ebenfalls. Jedes verschlüsselte Objekt hat eine eigene Nonce, die zusammen mit den verschlüsselten Daten gespeichert und beim Entschlüsseln verwendet wird.

Der Server speichert nur verschlüsselte Daten. Er speichert keine Klartext-Dateiinhalte, keine Klartext-Dateipfade und keinen vault key.

## Das Vault auf einem anderen Gerät entsperren

![Bildschirm zum Verbinden eines Vault](./connect-vault.png)

Wenn ein anderes Gerät sich mit demselben Remote-Vault verbindet, lädt es das Paket mit dem verschlüsselten vault key vom Server herunter.

Anschließend geben Sie auf diesem Gerät das Vault-Passwort ein.

Synch leitet mit dem gespeicherten Salt und den Argon2id-Einstellungen denselben `wrapKey` ab:

```txt
Argon2id(password, same salt, same settings)
=> same wrapKey
```

Ist das Passwort korrekt, entschlüsselt das Gerät mit diesem `wrapKey` den verschlüsselten vault key:

```txt
AES-GCM decrypt(
  key = wrapKey,
  nonce = stored nonce,
  ciphertext = encrypted vaultKey
)
=> vaultKey
```

Sobald das Gerät den vault key hat, kann es die synchronisierten Dateien und Metadaten lokal entschlüsseln.

Ist das Passwort falsch, leitet das Gerät einen anderen `wrapKey` ab, und das Entschlüsseln des vault key schlägt fehl.

## Warum Ihr Vault-Passwort trotzdem zählt

Ihr Vault-Passwort verschlüsselt nicht jede Datei in Ihrem Vault direkt. Es entsperrt den vault key, und der vault key verschlüsselt die eigentlichen Sync-Daten.

Trotzdem bleibt das Passwort sehr wichtig.

Wer eine Kopie des Pakets mit dem verschlüsselten vault key erhält, kann offline Passwortversuche dagegen richten. Argon2id macht jeden Versuch teurer, kann aber ein leicht zu erratendes Passwort nicht schützen.

Wenn Sie das Vault-Passwort vergessen, kann Synch das Vault nicht für Sie wiederherstellen. Das Passwort wird gebraucht, um den `wrapKey` abzuleiten, und der `wrapKey` wird gebraucht, um den vault key zu entsperren. Fehlt eines von beiden, sind die verschlüsselten Vault-Daten nicht lesbar.

Auch der Server kann ein verlorenes Passwort nicht wiederherstellen. Die Ableitung des `wrapKey` beginnt bei Ihrem Passwort, und das Passwort selbst wird nie an Synch gesendet.

Kurz gesagt: Die Rolle des Servers ist das Speichern und Synchronisieren verschlüsselter Vault-Daten; das Zurückverwandeln in lesbare Notizen geschieht vollständig auf Ihren Geräten. Die Geheimnisse, die zum Lesen der Daten nötig sind, liegen nie auf dem Server.
