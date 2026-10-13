import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anchorTime,
  cueAction,
  describeOffset,
  effectFor,
  LATE_GRACE_MS,
  planCue,
  planCues,
  type Cue,
  type Effect,
  type SoundRef,
  type Timeline,
} from "../schedule.ts";

const timeline: Timeline = {
  eventStart: "2026-10-10T16:00:00.000Z",
  eventEnd: "2026-10-11T16:00:00.000Z",
  windows: [
    {
      key: "submissions",
      opens_at: "2026-10-10T17:00:00.000Z",
      closes_at: "2026-10-11T15:00:00.000Z",
    },
    { key: "judging", opens_at: null, closes_at: null },
  ],
};

const song: SoundRef = { kind: "file", id: "song" };
const lengths = (sound: SoundRef) =>
  sound.kind === "file" ? (sound.id === "song" ? 180_000 : null) : 1000;

function cue(change: Partial<Cue>): Cue {
  return {
    id: "c",
    label: "Cue",
    sound: song,
    anchor: "event.end",
    windowKey: null,
    at: null,
    offsetSeconds: 0,
    align: "start",
    channel: "music",
    joinLate: true,
    volume: 100,
    ...change,
  };
}

test("a cue that ends at the event's end starts its length earlier", () => {
  const plan = planCue(cue({ align: "end" }), timeline, lengths);
  assert.equal(plan?.endsAt, Date.parse("2026-10-11T16:00:00.000Z"));
  assert.equal(plan?.startsAt, Date.parse("2026-10-11T15:57:00.000Z"));
});

test("an offset moves the time before aligning", () => {
  const plan = planCue(
    cue({ anchor: "window.close", windowKey: "submissions", offsetSeconds: -300, align: "end" }),
    timeline,
    lengths,
  );
  assert.equal(plan?.endsAt, Date.parse("2026-10-11T14:55:00.000Z"));
});

test("cues without a time, or with a sound that's gone, aren't planned", () => {
  assert.equal(anchorTime(cue({ anchor: "window.open", windowKey: "judging" }), timeline), null);
  assert.equal(anchorTime(cue({ anchor: "window.open", windowKey: "missing" }), timeline), null);
  assert.equal(anchorTime(cue({ anchor: "time", at: null }), timeline), null);
  assert.equal(planCue(cue({ sound: { kind: "file", id: "gone" } }), timeline, lengths), null);
  assert.equal(
    planCues([cue({ anchor: "window.close", windowKey: "judging" })], timeline, lengths).length,
    0,
  );
});

test("plans come soonest first", () => {
  const plans = planCues(
    [cue({ id: "late" }), cue({ id: "early", anchor: "event.start" })],
    timeline,
    lengths,
  );
  assert.deepEqual(
    plans.map((plan) => plan.cue.id),
    ["early", "late"],
  );
});

test("a cue waits, plays from the top within the grace, joins late, then is done", () => {
  const plan = planCue(cue({ anchor: "event.start" }), timeline, lengths);
  assert.ok(plan);
  const start = plan.startsAt;
  assert.deepEqual(cueAction(plan, start - 5000), { kind: "wait", inMs: 5000 });
  assert.deepEqual(cueAction(plan, start + LATE_GRACE_MS), { kind: "play", fromMs: 0 });
  assert.deepEqual(cueAction(plan, start + 60_000), { kind: "play", fromMs: 60_000 });
  assert.deepEqual(cueAction(plan, plan.endsAt), { kind: "done" });
});

test("a cue that doesn't join late is let go once the grace has passed", () => {
  const plan = planCue(cue({ anchor: "event.start", joinLate: false }), timeline, lengths);
  assert.ok(plan);
  assert.deepEqual(cueAction(plan, plan.startsAt + LATE_GRACE_MS + 1), { kind: "done" });
});

test("effects fall back to defaults, and an organizer's choice wins, including silence", () => {
  const chosen = new Map<string, Effect>([
    ["announcement.posted", { sound: song, volume: 80 }],
    ["challenges.accepted", { sound: null, volume: 100 }],
  ]);
  assert.deepEqual(effectFor("announcement.posted", chosen), { sound: song, volume: 80 });
  assert.equal(effectFor("challenges.accepted", chosen).sound, null);
  assert.deepEqual(effectFor("announcement.urgent", chosen).sound, {
    kind: "builtin",
    name: "alert",
  });
  assert.equal(effectFor("message.sent", chosen).sound, null);
});

test("offsets read as words", () => {
  assert.equal(describeOffset(0), "at");
  assert.equal(describeOffset(-300), "5 minutes before");
  assert.equal(describeOffset(3600), "1 hour after");
  assert.equal(describeOffset(-90), "90 seconds before");
});
