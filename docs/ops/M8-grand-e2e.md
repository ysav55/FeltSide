# M8.7 — Grand E2E (engine ⇄ CRM)

**Verdict: PASS.** A live, two-repo end-to-end run: the real FeltSide engine
driven through a full evening and consumed by the real EpokerCRM connector.

Because the E2E imports the CRM's actual `EngineHttpConnector` — which
validates every engine response against its Zod wire schemas — a green run is
a genuine contract proof across both products, not a mock. The harness and
the human-readable run log live in the **CRM** repo (that is where the
connector is):

- Harness: `EpokerCRM/server/tools/grand-e2e.ts`
- Run log for Jo: `EpokerCRM/docs/ops/M8-grand-e2e-runlog.md`

## The evening, and what passed

The engine was spawned (`node src/index.js`) against a real Postgres DB and
driven through:

1. **CRM → engine lesson sync** (`PUT /sync/v1/lessons`) materialized a
   scheduled coached lesson (with a playlist of drills) + a scheduled
   tournament, seats soft-restricted to the mapped students.
2. **Coached lesson** — coach opened it, dealt drill hands, tagged a mistake.
3. **Tournament** — activated, 4 students registered, ran to payout.
4. **Uncoached homework** — two students played a cash session, cashed out.
5. **Review + retag** — coach retagged a homework hand (revision bump).
6. **CRM ingestion** — the connector polled every export resource
   (`meta`, `players`, `sessions`, `hands`, `tournament-presets`) and asserted:

| Assertion | Result |
|-----------|--------|
| Tournament session exported with distinct `finish_position`s (1,2,3,4) | ✓ |
| `crm_student_id` denormalized onto tournament participants | ✓ |
| Lesson mistake tag present on an exported hand | ✓ |
| Retagged hand re-emitted at **revision 2** with the new tag (CONTRACT §4.5) | ✓ |
| Second full poll → **zero** new unique hands/sessions (at-least-once, no dup) | ✓ |
| Every hand + session parsed clean against the CRM Zod schemas (no drift) | ✓ |

This closes the loop the CONTRACT was written for: the engine produces a real
evening, and the CRM ingests all of it — correctly, once each, with no shape
drift — through its own code.
