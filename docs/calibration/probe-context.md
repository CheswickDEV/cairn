# Probe-Kontext — Cairn Kalibrierung (FIXE Test-Basis)

> **Diese Datei ist die unveränderliche Eingabe für jedes Modell.** Sie wird unverändert mit dem
> Standard-7-Bucket-Prompt verdichtet; der erzeugte Brief wird gegen `ground-truth.json` bewertet.
> Nicht editieren, ohne `ground-truth.json` synchron anzupassen — sonst ist „gleiche Basis für jedes
> Modell" verletzt. Szenario ist bewusst NICHT Cairn selbst (vermeidet Meta-Verwirrung).
>
> Szenario: ein internes Team baut einen **Belegerkennungs-Service** (OCR + Extraktion). Sprache:
> Deutsch mit englischen Fachbegriffen (testet gemischtsprachige Treue). Turns sind mit `[Tnn]`
> referenzierbar.

---

[T01] **Lena (Lead):** Kickoff für `BELEG-1427`. Drei harte Rahmenbedingungen, die für ALLES gelten: (1) Alle Belegdaten müssen DSGVO-konform **in der EU** bleiben — **keine US-Cloud-Verarbeitung**, auch nicht für OCR. (2) Budget-Deckel **400 €/Monat** für Infra. (3) Latenz-SLA: **p95 < 1.8 s** pro Beleg. Das ist gesetzt, bitte jede spätere Entscheidung dagegen prüfen.

[T02] **Tarek (Backend):** Verstanden. Für den schnellen Start nehme ich erstmal **SQLite** als Datenbank, dann haben wir kein Setup-Overhead.

[T03] **Mara (Data):** Ok fürs Prototyping. Ich fang parallel mit der OCR-Pipeline an.

[T04] **Tarek:** Btw kann jemand das Standup auf 10:30 schieben? Und der Kaffeevollautomat im 3. Stock ist wieder kaputt ☕. Egal, weiter im Text.

[T05] **Tarek:** Korrektur zur DB: SQLite trägt nicht. Wir haben **gleichzeitige Writes** von mehreren Workern, und SQLite locked die ganze Datei. Ich wechsle auf **PostgreSQL**. Ab jetzt ist Postgres die DB, SQLite ist raus.

[T06] **Mara:** Für OCR schlage ich **AcmeOCR** (Cloud-API) vor — beste Genauigkeit im Benchmark, spart uns das Self-Hosting.

[T07] **Lena:** Stopp — AcmeOCR verarbeitet ausschließlich in **us-east-1**. Das verletzt Rahmenbedingung (1) aus [T01]. Geht nicht, egal wie gut die Genauigkeit ist.

[T08] **Mara:** Stimmt. Dann self-hosted. Ich hatte **PaddleOCR** getestet, aber dessen **Umlaut-Handling für Deutsch war fehlerhaft** (ä/ö/ü wurden teils zu a/o/u). Deshalb nehme ich **docTR** — das verarbeitet deutsche Umlaute korrekt. Also: OCR-Engine ist docTR, AcmeOCR und PaddleOCR sind beide raus.

[T09] **Mara:** Beim ersten docTR-Lauf auf der VPS kam dieser Fehler:
```
RuntimeError: ONNXRuntimeError: [E:onnxruntime:Default] CUDA_PATH is not set, falling back to CPUExecutionProvider
```
Fix: wir laufen bewusst auf **CPU** (die VPS hat keine GPU), das ist nur eine Warnung-as-Error. Workaround: `export ORT_DISABLE_CUDA=1` vor dem Start setzen, dann ist Ruhe.

[T10] **PO:** Kurze Rückfrage zum Geld — wir hatten 500 €/Monat, oder?
[T10b] **Lena:** Nein. Der Deckel ist **400 €/Monat**, nicht 500. Bitte mit 400 rechnen.

[T11] **Tarek:** Job-Queue: ich nehme **Redis** als Broker für die Worker. Bleibt so.

[T12] **Tarek:** Deployment — ich hatte überlegt, das auf **Kubernetes** zu fahren, aber für einen Service mit zwei Workern ist das Overkill und sprengt das Budget. **Verworfen.** Wir deployen per **Docker Compose auf einem Hetzner-VPS** (Standort Falkenstein, also EU — passt zu [T01]).

[T13] **Tarek:** Aktuelle `.env` (bitte exakt so übernehmen, die Werte sind eingestellt):
```
OCR_ENGINE=doctr
DB_DSN=postgres://beleg:****@localhost:5432/beleg_prod
REDIS_URL=redis://localhost:6379/0
MAX_BATCH=32
CONFIDENCE_THRESHOLD=0.82
S3_ENDPOINT=https://eu-fsn.belegstore.example.de
TZ=UTC
```

[T14] **Mara:** Die Extraktions-Funktion, die den Confidence-Cutoff anwendet:
```python
def keep_field(field, threshold=0.82):
    # unter threshold -> Feld wird als "unsicher" geflaggt, nicht verworfen
    return field.confidence >= threshold
```

[T15] **PO:** Nebenbei — soll das Dashboard-Logo eher Petrol oder Türkis werden? Und Helvetica oder Inter? (Können wir später klären.)

[T16] **Tarek:** Deployment steht. Commit `a3f9c21` ist live. Gemessener Durchsatz **≈ 240 Belege/Stunde**, p95-Latenz aktuell **1,6 s** — also unter dem SLA aus [T01]. ✅

[T17] **Mara:** WICHTIG, sonst gibt's stille Datenfehler: die **VPS-Zeitzone MUSS auf UTC** stehen (siehe `TZ=UTC` in [T13]). Stand vorher auf Europe/Berlin, dadurch waren die Beleg-Timestamps um 1–2 h verschoben und die Sortierung kaputt. Nicht zurückdrehen.

[T18] **Tarek:** Kostenstand: aktuell **≈ 290 €/Monat** (VPS + Storage). Liegt unter dem 400er-Deckel.

[T19] **Mara:** Offene Frage: der `CONFIDENCE_THRESHOLD` von **0.82** flaggt mir zu viele Felder als unsicher. Vorschlag, auf **0.78** zu senken — aber das erhöht das Risiko falscher Extraktionen. Noch nicht entschieden: **0.82 beibehalten vs. 0.78**.

[T20] **Tarek:** Auch noch offen: ob wir bei steigendem Volumen einen **zweiten Worker** brauchen. Aktuell nicht entschieden, hängt von der Lastmessung nächste Woche ab.

[T21] **Lena:** Stand soweit gut. **Nächster konkreter Schritt — bitte als Nächstes umsetzen:** den Threshold testweise auf **0.78** senken, einen Tag Produktivlast fahren, und **p95 erneut messen**; Ergebnis dann hier posten, damit wir [T19] entscheiden können.
